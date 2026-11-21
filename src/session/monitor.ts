/**
 * Monitor (first-class) — the wait → answer → wait loop the Nov 19
 * subagent monitor was doing by hand, now as library code so any Muse can
 * run it with `bun run monitor`.
 *
 * Two layers, kept separate on purpose (same pattern as dice.ts):
 * - Pure functions (stripHtml / classifyMessage / parseQuestion /
 *   combatAnnouncements): no Foundry, no I/O, unit tested in
 *   tests/monitor.test.ts. The loop never guesses from free text.
 * - Live functions (answerQuestion / runMonitor): thin wrappers over
 *   FoundryLive reads + sendChat + the pins handler.
 *
 * Answering rules — the monitor NEVER invents stats or rolls:
 * - Dice: parseRollRequest → rollForChat (the roller owns the grammar).
 * - Questions: only the intents parseQuestion recognizes (turn, round,
 *   HP, AC, initiative, scene) and only from data actually read from the
 *   world at answer time. A missing actor / missing field is reported as
 *   "couldn't find it", never filled in.
 * - Combat: the monitor announces TURN changes only (the GM advancing the
 *   tracker). HP / down / end-of-combat belong to the CombatAutopilot —
 *   the code path that changes HP owns the callout — so the monitor never
 *   double-posts a down message the autopilot already sent.
 * - Builds (FR-1 + FR-8): a build request in chat routes to the build
 *   loop (`src/session/build-loop.ts` — pure parser + history) and the
 *   executor (`src/session/build-exec.ts`, loaded lazily — it imports
 *   the live composer, which is not test-safe). One confirmation line
 *   per build op; a compound request runs its ops in order, one line
 *   each. Ambiguous requests get a clarifying question in chat;
 *   out-of-scope requests get "I can't do that yet". Rooms are
 *   targetable by name, and "here" resolves from the GM's last ping
 *   or cursor. The session persists to a state file after each build,
 *   so a restart keeps the dungeon and the rooms already built. The
 *   loop never guesses a position and never hallucinates a build.
 * - GM whispers (BRA-185, FR-18): a whisper from the GM to Meroki is
 *   an instruction, not table chatter. An embedded cutscene script or
 *   a named sequence ("mice and the ogre") is validated with the
 *   cutscene engine and played — acknowledged instantly, then played
 *   in the background so the loop never goes deaf mid-fight (a
 *   sequence can span combat rounds). A whispered build or question
 *   routes through the normal paths with replies whispered back to
 *   the GM. Anything else gets a whispered clarification. Rolls are
 *   out of scope for the whisper channel — they live in public chat.
 * - Session modes (BRA-233): one session carries a mode — hands-on
 *   (FR-1), co-design (FR-15), improvise (FR-18) — switchable in one
 *   chat message from the GM ("let's go hands-on on this room" /
 *   "take the brief from here") or with `--mode` at startup. The
 *   switch is visible (a `mode-switched` log line + a confirmation
 *   in chat) and persisted, so a restart keeps the mode; the build
 *   state survives the switch untouched. Builds execute in every
 *   mode; only brief routing differs by mode (co-design logs a
 *   floor brief as a `brief` event for the convergence loop instead
 *   of "can't do that yet"). See src/session/modes.ts for what each
 *   mode actually changes — nothing is invented to fill the table.
 * - Speed budget (BRA-230, FR-10): every handled message is timed —
 *   detect (message timestamp → loop sees it) plus one action record
 *   (message → visible effect: roll/question answer, room built,
 *   whispered sequence's first step). Over-budget stages log one
 *   `latency-over-budget` line; the summary carries the p50/p95
 *   report. A failed action records nothing — no effect landed.
 * - Everything else (open chat, requests, roleplay): logged as
 *   "needs-agent" and skipped. A human Muse can answer those from the
 *   log; the CLI does not improvise.
 *
 * Own messages never wake the monitor (same rule as waitForChat), and the
 * loop disconnects cleanly on SIGINT/SIGTERM.
 */
import type { FoundryLive } from "../live.js";
import type { ChatMessage } from "../types.js";
import { rollForChat, parseRollRequest, resolveGamemasterId } from "./dice.js";
import { CombatAutopilot } from "./autopilot.js";
import type { CombatStatus } from "./autopilot.js";
import { extractPin, handlePin, findOpenPins, PinProcessor } from "./pins.js";
import {
  BuildSession,
  loadBuildState,
  parseBuildRequest,
  parseBuildRequests,
  saveBuildState,
  type BuildParseContext,
} from "./build-loop.js";
import { loadPack, type Pack } from "../worldbuilding/tiles-layout.js";
import type { BuiltTileRoom } from "../worldbuilding/tiles.js";
import {
  isGmWhisper,
  classifyWhisper,
  loadNamedSequence,
  NAMED_SEQUENCES,
} from "./whisper.js";
import type { NamedSequenceKey } from "./whisper.js";
import { validateCutscene, playCutscene } from "./cutscene.js";
import {
  LatencyLog,
  cutsceneStepKind,
  latencyLine,
  realClock,
  type Clock,
  type LatencyRecord,
  type SessionLatencyReport,
} from "./perf.js";
import {
  loadModeState,
  modeSwitchLine,
  parseBriefRequest,
  parseModeSwitch,
  saveModeState,
  MODE_POLICIES,
  type SessionMode,
} from "./modes.js";

/** What the monitor does with one chat message. */
export type MessageClass =
  | "own" // our own message — never wake on it
  | "noise" // empty after stripping markup — nothing to answer
  | "roll" // parseRollRequest matched — roll it
  | "question" // parseQuestion matched — answer from live data
  | "build" // a build request parsed cleanly — build it
  | "clarify" // a build request too ambiguous to build — ask in chat
  | "unsupported" // a build request the kit can't do yet — say so
  | "chat"; // everything else — needs a Muse's judgment; log + skip

/** Strip HTML tags + common entities down to plain text. */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Route one chat message. Order matters: own first (never self-trigger),
 * then noise, then the deterministic handlers, then "chat". The build
 * parse runs after roll/question so a roll or a data question never
 * gets mistaken for a build request; it needs the build context (the
 * room being built) to resolve "that door" — without it, build
 * requests that need the room fall through to "chat".
 */
export function classifyMessage(
  msg: ChatMessage,
  ownUserId: string | null,
  ownAlias: string,
  buildCtx?: BuildParseContext,
): MessageClass {
  if (
    (ownUserId !== null && msg.author === ownUserId) ||
    msg.speaker?.alias === ownAlias
  ) {
    return "own";
  }
  const text = stripHtml(msg.content);
  if (!text) return "noise";
  if (parseRollRequest(text) !== null) return "roll";
  if (parseQuestion(text)) return "question";
  if (buildCtx) {
    const build = parseBuildRequest(text, buildCtx);
    if (build) return build.kind;
  }
  return "chat";
}

/** A question the monitor can answer from live data, and nothing else. */
export type QuestionIntent =
  | { kind: "turn" }
  | { kind: "round" }
  | { kind: "hp"; name: string }
  | { kind: "ac"; name: string }
  | { kind: "initiative"; name: string }
  | { kind: "scene" };

const NAME = "([A-Za-z][A-Za-z'\\- ]{0,29}?)";

/**
 * Parse a chat message into a question intent, or null when it isn't one
 * the monitor can answer from data. Case-insensitive; trailing "?" ok.
 *
 * Recognized (X = a character name):
 *   "whose turn is it" / "who's turn" / "whose turn"
 *   "what round is it" / "which round" / "what round are we on"
 *   "what is X's hp" / "how much hp does X have" / "X's hp" / "hp of X"
 *   "what is X's ac" / "X's ac" / "what's X's armor class" / "ac of X"
 *   "what is X's initiative" / "X's initiative"
 *   "where are we" / "what scene are we on" / "what scene is this"
 */
export function parseQuestion(text: string): QuestionIntent | null {
  // Match case-insensitively but capture names in their original case.
  const s = stripHtml(text).replace(/[?!.]+$/, "").trim();
  if (!s) return null;
  if (/\bwhose turn\b/i.test(s) || /\bwho'?s turn\b/i.test(s)) return { kind: "turn" };
  if (/\bwhat round\b/i.test(s) || /\bwhich round\b/i.test(s)) return { kind: "round" };
  if (/\bwhere are we\b/i.test(s) || /\bwhat scene\b/i.test(s)) return { kind: "scene" };
  let m = new RegExp(`\\bwhat(?:'s| is) ${NAME}'s initiative\\b`, "i").exec(s) ??
    new RegExp(`\\b${NAME}'s initiative\\b`, "i").exec(s);
  if (m) return { kind: "initiative", name: m[1].trim() };
  m = new RegExp(`\\bhow much hp does ${NAME} have\\b`, "i").exec(s) ??
    new RegExp(`\\bwhat(?:'s| is) ${NAME}'s hp\\b`, "i").exec(s) ??
    new RegExp(`\\bhp of ${NAME}\\b`, "i").exec(s) ??
    new RegExp(`\\b${NAME}'s hp\\b`, "i").exec(s);
  if (m) return { kind: "hp", name: m[1].trim() };
  m = new RegExp(`\\bwhat(?:'s| is) ${NAME}'s (?:ac|armor class)\\b`, "i").exec(s) ??
    new RegExp(`\\b${NAME}'s (?:ac|armor class)\\b`, "i").exec(s) ??
    new RegExp(`\\b(?:ac|armor class) of ${NAME}\\b`, "i").exec(s);
  if (m) return { kind: "ac", name: m[1].trim() };
  return null;
}

/**
 * Turn announcements from a combat snapshot diff. Returns the chat lines
 * to post (empty when nothing changed). ONLY turn/round changes are
 * announced — HP, downs, and combat end belong to the autopilot.
 */
export function combatAnnouncements(
  prev: CombatStatus | null,
  next: CombatStatus | null,
): string[] {
  if (!next) return [];
  if (!prev) return []; // combat start is the encounter builder's announcement
  if (prev.combatId !== next.combatId) return []; // a new combat — not ours to announce
  if (prev.round === next.round && prev.turn === next.turn) return [];
  const cur = next.current;
  if (!cur) return [];
  return [
    `➡️ Round ${next.round}, turn ${(next.turn ?? 0) + 1}/${next.combatants.length}: **${cur.name}** (HP ${cur.hp}/${cur.hpMax})`,
  ];
}

// ---------------------------------------------------------------- live layer

interface RawActor {
  _id: string;
  name: string;
  system?: {
    attributes?: {
      hp?: { value?: number; max?: number };
      ac?: { value?: number };
    };
  };
}

/** Resolve an actor by name (case-insensitive, substring match on name). */
async function findActorByName(
  live: FoundryLive,
  name: string,
): Promise<RawActor | null> {
  const res = (await live.searchActors(name, { limit: 10 })) as {
    actors?: RawActor[];
  };
  const needle = name.toLowerCase();
  const hit = (res.actors ?? []).find((a) => a.name.toLowerCase().includes(needle));
  if (!hit) return null;
  const full = (await live.getActorDetails(hit._id)) as RawActor | null;
  return full ?? hit;
}

/**
 * Answer one parsed question from live data. Returns the posted message
 * _id. A missing actor / field / combat is reported in chat as "couldn't
 * find it" — never invented. With `whisperTo`, the answer goes back as
 * a whisper to that user (the GM-whisper path) instead of public chat.
 */
export async function answerQuestion(
  live: FoundryLive,
  intent: QuestionIntent,
  whisperTo?: string,
): Promise<string> {
  const say = (text: string): Promise<string> =>
    whisperTo ? live.sendChat(text, { whisperTo: [whisperTo] }) : live.sendChat(text);
  switch (intent.kind) {
    case "turn":
    case "round": {
      const combat = live.getCombatState() as {
        _id: string;
        round: number;
        turn: number | null;
      } | null;
      if (!combat) return say("No combat is running right now.");
      try {
        const pilot = new CombatAutopilot(live, combat._id);
        const st = pilot.status();
        const cur = st.current;
        if (intent.kind === "round") {
          return say(`We're on round ${st.round}.`);
        }
        if (!cur) return say(`Round ${st.round} — no one's turn yet.`);
        return say(
          `It's **${cur.name}**'s turn — round ${st.round}, turn ${(st.turn ?? 0) + 1}/${st.combatants.length} (HP ${cur.hp}/${cur.hpMax}).`,
        );
      } catch {
        return say("I couldn't read the combat tracker right now.");
      }
    }
    case "hp":
    case "ac": {
      const actor = await findActorByName(live, intent.name);
      if (!actor) return say(`I couldn't find anyone named **${intent.name}**.`);
      if (intent.kind === "hp") {
        const hp = actor.system?.attributes?.hp;
        if (hp?.value === undefined) {
          return say(`**${actor.name}** has no HP on their sheet that I can read.`);
        }
        return say(`**${actor.name}** is at ${hp.value}/${hp.max ?? "?"} HP.`);
      }
      const ac = actor.system?.attributes?.ac?.value;
      if (ac === undefined) {
        return say(`**${actor.name}** has no AC on their sheet that I can read.`);
      }
      return say(`**${actor.name}**'s AC is ${ac}.`);
    }
    case "initiative": {
      const combat = live.getCombatState() as { _id: string } | null;
      if (!combat) return say("No combat is running right now.");
      try {
        const pilot = new CombatAutopilot(live, combat._id);
        const st = pilot.status();
        const c = st.combatants.find(
          (x) => x.name.toLowerCase() === intent.name.toLowerCase(),
        );
        if (!c) return say(`**${intent.name}** isn't in this combat.`);
        if (c.initiative === null) {
          return say(`**${c.name}** hasn't rolled initiative yet.`);
        }
        return say(`**${c.name}**'s initiative is ${c.initiative}.`);
      } catch {
        return say("I couldn't read the combat tracker right now.");
      }
    }
    case "scene": {
      const scene = (await live.getSceneInfo()) as { name?: string } | null;
      if (!scene?.name) return say("I couldn't tell which scene is active.");
      return say(`We're on **${scene.name}**.`);
    }
  }
}

// ---------------------------------------------------------------- GM whispers

/**
 * What the whisper channel can do, told to the GM when a whisper asks
 * for something else. Kept short — it is a private nudge, not a manual.
 */
export const WHISPER_CLARIFY =
  `Whisper received — from here I can play a sequence (paste the cutscene script JSON, or name one like "mice and the ogre"), build something, or answer a question from live data. What do you need?`;
export const WHISPER_ROLL_CLARIFY =
  `Rolls live in public chat — post the roll there and I'll answer it. From a whisper I can play a sequence, build, or answer a question.`;

/** What playing (or refusing) a whispered sequence resolved to. */
export type WhisperSequenceOutcome =
  | { state: "started"; name: string }
  | { state: "rejected"; name: string | null; reason: string };

/**
 * Latency events a whispered sequence reports to its caller (BRA-230):
 * `first-effect` fires once, when the first timeline step completes —
 * that is the first visible effect, and the ack whisper is not it.
 * `step` fires per executed step at run completion, with the duration
 * the player measured — the caller records it under `cutscene-step`
 * (or `cutscene-wait` for wait steps).
 */
export type WhisperLatencyEvent =
  | { type: "first-effect" }
  | { type: "step"; index: number; kind: string; durationMs: number };

/**
 * Play (or refuse) a sequence the GM whispered: an embedded script, a
 * named sequence, or a JSON block that failed to parse.
 *
 * Latency budget (FR-18): whisper → first visible effect in 1–2
 * minutes, or the moment is gone. So this acknowledges instantly
 * ("On it — playing …") and starts the timeline in the background:
 * a sequence can span combat rounds, and awaiting it here would make
 * the monitor deaf for the rest of the fight. The returned promise
 * resolves at "started" (ack sent, timeline running); completion and
 * failure are reported back to the GM by the background continuation
 * and in the log. The run key (`whisper:<message id>`) makes the play
 * itself retry-safe — a re-dispatch reproduces the run instead of
 * placing the tokens twice.
 *
 * Every reply here is a whisper to the GM: the players never see the
 * setup. A rejected script is refused with its validation errors, so
 * the GM can fix it and paste it again — never a silent skip, never
 * a half-broken start.
 */
export async function handleWhisperSequence(
  live: FoundryLive,
  msg: ChatMessage,
  gmId: string,
  w:
    | { kind: "script"; script: unknown }
    | { kind: "named"; key: NamedSequenceKey }
    | { kind: "script-invalid"; error: string },
  opts: {
    onLog?: (log: MonitorLog) => void;
    /** Latency hook (BRA-230): first completed step + per-step durations. */
    onLatency?: (ev: WhisperLatencyEvent) => void;
  } = {},
): Promise<WhisperSequenceOutcome> {
  const log = opts.onLog ?? (() => {});
  const whisperTo = (text: string): Promise<string> =>
    live.sendChat(text, { whisperTo: [gmId] });
  if (w.kind === "script-invalid") {
    await whisperTo(
      `I couldn't read that script — ${w.error}. Paste the full cutscene JSON and I'll play it.`,
    );
    log({ event: "whisper-rejected", id: msg.id, reason: "unparseable script" });
    return { state: "rejected", name: null, reason: w.error };
  }
  let script: unknown;
  let name: string;
  if (w.kind === "named") {
    const seq = NAMED_SEQUENCES.find((s) => s.key === w.key)!;
    name = seq.title;
    try {
      script = loadNamedSequence(w.key);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await whisperTo(`I couldn't load "${name}" — ${reason}`);
      log({ event: "whisper-rejected", id: msg.id, name, reason });
      return { state: "rejected", name, reason };
    }
  } else {
    script = w.script;
    const rawName = (script as { name?: unknown }).name;
    name = typeof rawName === "string" && rawName.length > 0 ? rawName : "that sequence";
  }
  const validated = validateCutscene(script);
  if (!validated.ok) {
    const shown = validated.errors.slice(0, 5);
    const more =
      validated.errors.length > 5 ? `\n…and ${validated.errors.length - 5} more.` : "";
    await whisperTo(
      `That script doesn't validate:\n- ${shown.join("\n- ")}${more}\nFix those and paste it again — I won't start a half-broken script.`,
    );
    log({ event: "whisper-rejected", id: msg.id, name, errors: validated.errors });
    return { state: "rejected", name, reason: validated.errors.join("; ") };
  }
  name = validated.script.name;
  await whisperTo(`On it — playing "${name}"…`);
  const runKey = `whisper:${msg.id}`;
  // First completed step = first visible effect (BRA-230). Fires once;
  // a rejected script never reaches here, so no phantom "effect".
  let firstStep = true;
  void playCutscene(live, validated.script, {
    runKey,
    onStep: (r) => {
      if (firstStep) {
        firstStep = false;
        opts.onLatency?.({ type: "first-effect" });
      }
      log({ event: "whisper-step", id: msg.id, name, index: r.index, kind: r.kind, ok: r.ok });
    },
  })
    .then(async (res) => {
      // Per-step execution times, as the player measured them — the
      // caller records them (wait steps land unbudgeted). Reported
      // even for a run that stopped mid-way: the steps that ran, ran.
      for (const s of res.steps) {
        opts.onLatency?.({
          type: "step",
          index: s.index,
          kind: s.kind,
          durationMs: s.durationMs,
        });
      }
      // The run resolves (never rejects) for a step failure, so check
      // `ok` before claiming it finished: a run that stopped mid-way
      // whispers "stopped" with the failing step, never "finished".
      // Only a throw (bad expansion, missing scene) reaches .catch.
      if (!res.ok) {
        const failed = res.steps.find((s) => !s.ok);
        const reason = failed
          ? `step ${failed.index} (${failed.kind}) failed: ${failed.error ?? "unknown error"}`
          : "a step failed";
        log({ event: "whisper-failed", id: msg.id, name, error: reason });
        try {
          await whisperTo(`"${name}" stopped: ${reason}`);
        } catch {
          // The table is unreachable; the log line above is the record.
        }
        return;
      }
      log({ event: "whisper-done", id: msg.id, name });
      try {
        await whisperTo(`"${name}" finished.`);
      } catch {
        // The table is unreachable; the log line above is the record.
      }
    })
    .catch(async (err) => {
      const reason = err instanceof Error ? err.message : String(err);
      log({ event: "whisper-failed", id: msg.id, name, error: reason });
      try {
        await whisperTo(`"${name}" stopped: ${reason}`);
      } catch {
        // As above.
      }
    });
  return { state: "started", name };
}

// ---------------------------------------------------------------- the loop

/** One JSON log line the monitor emits (stderr by default). */
export interface MonitorLog {
  event: string;
  [key: string]: unknown;
}

export interface MonitorOptions {
  /** Display name in chat. Default: "Meroki". */
  alias?: string;
  /** Seconds to wait after the first new message to merge a burst. Default: 3. */
  debounce?: number;
  /** Seconds per wait cycle (also bounds SIGINT latency). Default: 30. */
  timeout?: number;
  /** Classify + log, but post nothing and change nothing. Default: false. */
  dryRun?: boolean;
  /** Run one wait cycle + one pin drain + one combat check, then return. Default: false. */
  once?: boolean;
  /** Where log lines go. Default: a JSON line on stderr. */
  onLog?: (log: MonitorLog) => void;
  /** Checked between cycles; when true, the loop stops after the current cycle. */
  shouldStop?: () => boolean;
  /** Tile-pack manifest path for the build loop (default: the repo's
   *  own tiles/manifest.json). Loaded lazily on the first build. */
  packPath?: string;
  /** Server folder the pack was uploaded to (default: derived from
   *  the world title, e.g. "worlds/testbed"). */
  serverBase?: string;
  /** Clock for latency instrumentation (BRA-230, FR-10). Default: the
   *  wall clock. Inject a fake clock in tests to pin timings. */
  clock?: Clock;
  /** Build-session state file (default: $FOUNDRY_BUILD_STATE or the
   *  repo's .build-state.json). Restored on start, saved after each
   *  build, so a restart keeps the dungeon and the rooms already
   *  built on the server. */
  buildStatePath?: string;
  /** Starting session mode (BRA-233): "hands-on" (FR-1), "co-design"
   *  (FR-15), or "improvise" (FR-18). An explicit option wins over
   *  the state file and is saved, so the next start agrees. */
  mode?: SessionMode;
  /** Mode state file (default: $FOUNDRY_MODE_STATE or the repo's
   *  .mode-state.json). Read on start when no --mode is given;
   *  written on every switch, so a restart keeps the mode. */
  modeStatePath?: string;
}

export interface MonitorSummary {
  cycles: number;
  messagesSeen: number;
  answered: number;
  rollsHandled: number;
  pinsHandled: number;
  combatAnnouncements: number;
  buildsHandled: number;
  clarifications: number;
  /** GM whispers acted on as instructions (sequences, builds, questions, clarifications). */
  whispersHandled: number;
  skipped: number;
  /** Session mode at shutdown (BRA-233) + how many real switches this run made. */
  mode: SessionMode;
  modeSwitches: number;
  /** Speed-budget report (BRA-230, FR-10): p50/p95 per latency kind. */
  latency: SessionLatencyReport;
}

/**
 * The GM's "here" for a build request: their most recent ping or
 * cursor point, with the pinged scene resolved to a room we built.
 * A ping carries its scene; a cursor-only point has none, so it pairs
 * with the active room. Returns undefined when we've seen no point
 * from the GM, or the point is on a scene we didn't build (a ping
 * elsewhere in the world is not a build "here"). The live object may
 * not have lastPointFor (test fakes) — then there is no "here".
 */
export function gmHerePoint(
  live: FoundryLive,
  gmId: string | null,
  builtRooms: Map<string, BuiltTileRoom>,
  activeRoomId: string | null,
): { roomId: string; x: number; y: number } | undefined {
  if (!gmId) return undefined;
  const maybe = live as unknown as {
    lastPointFor?: (id: string) => { sceneId?: string; x: number; y: number } | null;
  };
  if (typeof maybe.lastPointFor !== "function") return undefined;
  const point = maybe.lastPointFor(gmId);
  if (!point) return undefined;
  if (point.sceneId) {
    for (const [roomId, ref] of builtRooms) {
      if (ref.sceneId === point.sceneId) return { roomId, x: point.x, y: point.y };
    }
    return undefined;
  }
  if (!activeRoomId) return undefined;
  return { roomId: activeRoomId, x: point.x, y: point.y };
}

/**
 * Run the monitor loop until `shouldStop()` is true (SIGINT in the CLI).
 * Returns a summary. Throws only on connect failure — a failed cycle is
 * logged and the loop continues, because a monitor that dies on the first
 * hiccup is worse than one that misses a message.
 */
export async function runMonitor(
  live: FoundryLive,
  opts: MonitorOptions = {},
): Promise<MonitorSummary> {
  const alias = opts.alias ?? "Meroki";
  const debounce = opts.debounce ?? 3;
  const timeout = opts.timeout ?? 30;
  const log = opts.onLog ?? ((l: MonitorLog) => {
    process.stderr.write(JSON.stringify(l) + "\n");
  });
  // Speed-budget instrumentation (BRA-230, FR-10): one record per
  // handled action, on the injected clock (wall clock live). The
  // helper logs the per-action latency line and, when a stage exceeds
  // its budget, one over-budget warning line.
  const perf = new LatencyLog(opts.clock ?? realClock);
  const recordLatency = (rec: LatencyRecord): void => {
    log({
      event: "latency",
      kind: rec.kind,
      label: rec.label,
      ms: rec.durationMs,
      budgetMs: rec.budgetMs,
      over: rec.overBudget,
      line: latencyLine(rec),
    });
    if (rec.overBudget) {
      log({
        event: "latency-over-budget",
        kind: rec.kind,
        label: rec.label,
        ms: rec.durationMs,
        budgetMs: rec.budgetMs,
      });
    }
  };
  // Session mode (BRA-233): the startup option wins over the state
  // file, which wins over the default. An explicit option is saved,
  // so the next start without one agrees with this one. A missing or
  // corrupt file starts hands-on — the mode is a stance, never a
  // reason to refuse to run.
  let mode: SessionMode =
    opts.mode ?? loadModeState(opts.modeStatePath) ?? "hands-on";
  if (opts.mode !== undefined) saveModeState(mode, opts.modeStatePath);
  const summary: MonitorSummary = {
    cycles: 0,
    messagesSeen: 0,
    answered: 0,
    rollsHandled: 0,
    pinsHandled: 0,
    combatAnnouncements: 0,
    buildsHandled: 0,
    clarifications: 0,
    whispersHandled: 0,
    skipped: 0,
    mode,
    modeSwitches: 0,
    latency: perf.summary(),
  };
  const pins = new PinProcessor();
  // The build loop's state lives for the whole monitor run: the
  // dungeon spec + edit history and the rooms already built on the
  // server, by room id. Restored from the state file when one exists
  // (a restart keeps the build); a missing or corrupt file starts
  // fresh, as with the pins/autopilot state.
  const restoredBuild = loadBuildState(opts.buildStatePath);
  const buildSession = restoredBuild?.session ?? new BuildSession();
  const builtRooms = new Map<string, BuiltTileRoom>(restoredBuild?.built ?? []);
  if (restoredBuild) {
    log({
      event: "build-state-restored",
      rooms: buildSession.current().dungeon.rooms.length,
      history: buildSession.history().length,
      built: builtRooms.size,
    });
  }
  let pack: Pack | null = null;
  const pinQueue: Record<string, unknown>[][] = [];
  const unsubscribe = live.on((event) => {
    if (event.kind === "document" && event.action === "create") {
      pinQueue.push(event.docs);
    }
  });
  let lastSeen: string | null = null;
  {
    const recent = live.getChatMessages(1);
    lastSeen = recent.length > 0 ? recent[recent.length - 1].id : null;
  }
  let prevCombat: CombatStatus | null = null;
  // The GM's user id, for whisper detection. Unresolvable (no role-4
  // user, no user named Gamemaster) disables whisper handling — the
  // loop keeps running; only whispers stop being instructions.
  let gmId: string | null = null;
  try {
    gmId = resolveGamemasterId(live);
  } catch {
    log({ event: "whisper-disabled", reason: "no gamemaster user found" });
  }
  log({
    event: "started",
    alias,
    debounce,
    timeout,
    dryRun: !!opts.dryRun,
    gmId,
    mode,
  });

  try {
    for (;;) {
      if (opts.shouldStop?.()) break;
      summary.cycles += 1;
      const result = await live.waitForChat({ lastSeen, timeout, debounce });
      lastSeen = result.lastSeen;
      for (const msg of result.newMessages) {
        summary.messagesSeen += 1;
        // Detect latency (BRA-230): message timestamp → the loop sees
        // it. Includes the waitForChat debounce, so ~3s is the loop
        // working as designed. A message without a usable timestamp
        // is skipped, not guessed (fakes use timestamp 0).
        const receivedAt = perf.now();
        if (typeof msg.timestamp === "number" && msg.timestamp > 0) {
          recordLatency(perf.record("detect", msg.timestamp, receivedAt, msg.id));
        }
        const text = stripHtml(msg.content);
        // A GM whisper is an instruction, not table chatter (BRA-185 /
        // FR-18). Checked first: a whispered roll or question must not
        // leak into the public branches below.
        const whisper = gmId !== null && isGmWhisper(msg, live.userId, gmId);
        if (whisper && gmId && text) {
          const w = classifyWhisper(text);
          if (w.kind !== "other") {
            if (opts.dryRun) {
              log({ event: "whisper", id: msg.id, class: w.kind, dryRun: true });
            } else {
              summary.whispersHandled += 1;
              summary.answered += 1;
              // First visible effect lands in the background timeline
              // (BRA-230): the timer finishes on the first completed
              // step. A rejected script drops the timer — no effect
              // will land, so nothing is recorded.
              const whisperTimer = perf.start("whisper-first-effect", msg.id);
              void handleWhisperSequence(live, msg, gmId, w, {
                onLog: log,
                onLatency: (ev) => {
                  if (ev.type === "first-effect") {
                    recordLatency(perf.finish(whisperTimer));
                  } else {
                    // Per-step execution time, as the player measured it.
                    recordLatency(
                      perf.recordDuration(
                        cutsceneStepKind(ev.kind),
                        ev.durationMs,
                        `${msg.id}:${ev.index}`,
                      ),
                    );
                  }
                },
                // A rejected script never calls playCutscene, so
                // onLatency never fires and the timer is dropped.
              }).catch((err) => {
                log({ event: "error", class: "whisper", id: msg.id, error: String(err) });
              });
            }
            continue;
          }
          // Not a sequence — fall through to the ordinary routing
          // below, but every reply goes back as a whisper to the GM.
        }
        // A mode switch (BRA-233): one chat message from the GM
        // ("let's go hands-on on this room" / "take the brief from
        // here"). Checked before the roll/question/build branches —
        // a switch is an instruction about the session, not a request
        // to act in it. Only the GM can switch; when no GM user
        // resolves at all there is no creator to gate on, so anyone
        // can. The switch is visible (a log line + a confirmation in
        // chat — a whisper back when it came by whisper) and
        // persisted, so a restart keeps the mode. The build session
        // is untouched — rooms, plan, and any running sequence
        // survive the switch.
        const switchTo = parseModeSwitch(text);
        if (switchTo !== null && (gmId === null || msg.author === gmId)) {
          const from = mode;
          if (opts.dryRun) {
            log({ event: "mode-switch", from, to: switchTo, dryRun: true });
          } else {
            const line = modeSwitchLine(from, switchTo);
            if (whisper && gmId) {
              await live.sendChat(line, { whisperTo: [gmId] });
            } else {
              await live.sendChat(line);
            }
            if (from !== switchTo) {
              mode = switchTo;
              summary.modeSwitches += 1;
              summary.mode = mode;
              saveModeState(mode, opts.modeStatePath);
            }
            summary.answered += 1;
            if (whisper) summary.whispersHandled += 1;
            log({ event: "mode-switch", from, to: switchTo, same: from === switchTo });
          }
          continue;
        }
        // The build context for this message: the room being built,
        // every room (for names), and the GM's last ping/cursor
        // ("here"). Built fresh per message — the session, the rooms,
        // and the ping all move.
        const cur = buildSession.current();
        const buildCtx: BuildParseContext = {
          room: buildSession.activeRoomSpec() ?? undefined,
          rooms: cur.dungeon.rooms,
          here: gmHerePoint(live, gmId, builtRooms, cur.activeRoom),
        };
        const cls = classifyMessage(msg, live.userId, alias, buildCtx);
        if (cls === "own" || cls === "noise") {
          summary.skipped += 1;
          log({ event: "skip", class: cls, id: msg.id });
          continue;
        }
        // Reply channel: a GM whisper is answered privately, everything
        // else in public chat. `say` is the build branch's sender.
        const replyWhisperTo = whisper ? gmId : null;
        const say = (line: string): Promise<string> =>
          replyWhisperTo
            ? live.sendChat(line, { whisperTo: [replyWhisperTo] })
            : live.sendChat(line);
        if (cls === "roll") {
          if (whisper) {
            // Rolls live in public chat — the whisper channel is for
            // sequences, builds, and questions.
            if (opts.dryRun) {
              log({ event: "whisper-clarify", id: msg.id, reason: "roll", dryRun: true });
            } else {
              await say(WHISPER_ROLL_CLARIFY);
              summary.whispersHandled += 1;
              summary.answered += 1;
              summary.clarifications += 1;
              log({ event: "whisper-clarify", id: msg.id, reason: "roll" });
            }
            continue;
          }
          if (opts.dryRun) {
            log({ event: "roll", id: msg.id, dryRun: true });
          } else {
            try {
              const rollTimer = perf.start("roll", msg.id);
              const id = await rollForChat(live, text);
              if (id) {
                recordLatency(perf.finish(rollTimer));
                summary.rollsHandled += 1;
                summary.answered += 1;
                log({ event: "roll", id: msg.id, posted: id });
              } else {
                // No roll posted, no visible effect — timer dropped.
                summary.skipped += 1;
                log({ event: "skip", class: "roll-unhandled", id: msg.id });
              }
            } catch (err) {
              log({ event: "error", class: "roll", id: msg.id, error: String(err) });
            }
          }
          continue;
        }
        if (cls === "question") {
          const intent = parseQuestion(text);
          if (!intent) {
            summary.skipped += 1;
            continue;
          }
          if (opts.dryRun) {
            log({ event: "question", id: msg.id, intent, dryRun: true });
          } else {
            try {
              const questionTimer = perf.start("question", msg.id);
              const id = await answerQuestion(live, intent, replyWhisperTo ?? undefined);
              recordLatency(perf.finish(questionTimer));
              summary.answered += 1;
              if (whisper) summary.whispersHandled += 1;
              log({ event: "question", id: msg.id, intent, posted: id });
            } catch (err) {
              log({ event: "error", class: "question", id: msg.id, error: String(err) });
            }
          }
          continue;
        }
        // Build / clarify / unsupported — the FR-1 loop. The parse runs
        // again here (classify only returned the class) with the
        // session's room, so "that door" resolves against the room
        // being built. Compound requests run their ops in order, one
        // confirmation line each.
        if (cls === "build" || cls === "clarify" || cls === "unsupported") {
          const parsed = parseBuildRequests(text, buildCtx);
          if (!parsed) {
            // Classify said build, the parse says otherwise — defensive;
            // treat as needs-agent rather than building the wrong thing.
            summary.skipped += 1;
            log({ event: "needs-agent", id: msg.id, text: text.slice(0, 200) });
            continue;
          }
          if (parsed.kind === "clarify") {
            if (opts.dryRun) {
              log({ event: "build-clarify", id: msg.id, question: parsed.question, dryRun: true });
            } else {
              await say(parsed.question);
              summary.clarifications += 1;
              summary.answered += 1;
              if (whisper) summary.whispersHandled += 1;
              log({ event: "build-clarify", id: msg.id, question: parsed.question });
            }
            continue;
          }
          if (parsed.kind === "unsupported") {
            const line = `I can't do that yet — ${parsed.reason}.`;
            if (opts.dryRun) {
              log({ event: "build-unsupported", id: msg.id, reason: parsed.reason, dryRun: true });
            } else {
              await say(line);
              summary.clarifications += 1;
              summary.answered += 1;
              if (whisper) summary.whispersHandled += 1;
              log({ event: "build-unsupported", id: msg.id, reason: parsed.reason });
            }
            continue;
          }
          if (opts.dryRun) {
            log({ event: "build", id: msg.id, ops: parsed.ops, dryRun: true });
            continue;
          }
          try {
            pack ??= loadPack(opts.packPath);
            // The executor imports the live composer — lazy, so the
            // pure tests never load the vendored client.
            const { executeBuilds, serverBaseForWorld } = await import("./build-exec.js");
            const world = live.getWorldSummary() as { title?: string | null };
            // Room-build latency (BRA-230): tiles synced + confirmation
            // posted. Pack load and the one-time import are setup, not
            // the build, so the timer starts here.
            const buildTimer = perf.start("room-build", msg.id);
            const lines = await executeBuilds(live, buildSession, parsed.ops, text, {
              pack,
              serverBase: opts.serverBase ?? serverBaseForWorld(world.title),
              built: builtRooms,
            });
            for (const line of lines) await say(line);
            recordLatency(perf.finish(buildTimer));
            summary.buildsHandled += lines.length;
            summary.answered += 1;
            if (whisper) summary.whispersHandled += 1;
            log({ event: "build", id: msg.id, ops: parsed.ops, lines });
            // The session changed — persist it (and the rooms now
            // built) so a restart keeps the build.
            saveBuildState(buildSession, builtRooms, opts.buildStatePath);
          } catch (err) {
            // A failed build never commits: the session is unchanged,
            // so the GM can rephrase and try again. (A compound that
            // fails mid-list keeps the ops before the failure —
            // executeBuilds reports those in its lines, not here.)
            const line = `I couldn't build that — ${err instanceof Error ? err.message : String(err)}`;
            try {
              await say(line);
            } catch {
              // The table is unreachable; the log line below is the record.
            }
            log({ event: "error", class: "build", id: msg.id, error: String(err) });
          }
          continue;
        }
        // "chat" — a GM whisper gets a clarification (privately);
        // anything else needs a Muse's judgment. Log it, don't improvise.
        if (whisper) {
          if (opts.dryRun) {
            log({ event: "whisper-clarify", id: msg.id, reason: "other", dryRun: true });
          } else {
            await say(WHISPER_CLARIFY);
            summary.whispersHandled += 1;
            summary.answered += 1;
            summary.clarifications += 1;
            log({ event: "whisper-clarify", id: msg.id, reason: "other" });
          }
          continue;
        }
        // A floor brief in co-design mode (BRA-233): the message is
        // about the plan, not a tile — log it as a `brief` event so
        // the human Muse runs the convergence loop on it, instead of
        // the generic needs-agent line. The monitor does not answer
        // a brief itself: the loop is not built yet, and posting a
        // promise it cannot keep would be worse than silence.
        if (MODE_POLICIES[mode].briefs === "log-brief") {
          const brief = parseBriefRequest(text);
          if (brief) {
            summary.skipped += 1;
            log({ event: "brief", id: msg.id, mode, signals: brief.signals, text: text.slice(0, 200) });
            continue;
          }
        }
        summary.skipped += 1;
        log({ event: "needs-agent", id: msg.id, text: text.slice(0, 200) });
      }

      // Pins: drain the document-event queue, then (first cycle only) scan
      // for pins dropped while the monitor was offline.
      if (summary.cycles === 1) {
        for (const pin of findOpenPins(live)) {
          pinQueue.push([pin.raw]);
        }
      }
      while (pinQueue.length > 0) {
        const docs = pinQueue.shift()!;
        for (const doc of docs) {
          const pin = extractPin(doc);
          if (!pin || pin.status !== "open") continue;
          if (opts.dryRun) {
            log({ event: "pin", entryId: pin.entryId, request: pin.request, dryRun: true });
            continue;
          }
          try {
            const handled = await handlePin(live, pin, { pins, alias });
            if (handled) {
              summary.pinsHandled += 1;
              log({ event: "pin", entryId: pin.entryId, request: pin.request });
            }
          } catch (err) {
            log({ event: "error", class: "pin", entryId: pin.entryId, error: String(err) });
          }
        }
      }

      // Combat: announce turn changes (only).
      try {
        const combat = live.getCombatState() as { _id: string } | null;
        let next: CombatStatus | null = null;
        if (combat) {
          next = new CombatAutopilot(live, combat._id).status();
        }
        const lines = combatAnnouncements(prevCombat, next);
        prevCombat = next;
        for (const line of lines) {
          if (opts.dryRun) {
            log({ event: "combat", dryRun: true, text: line });
          } else {
            await live.sendChat(line);
            summary.combatAnnouncements += 1;
            log({ event: "combat", text: line });
          }
        }
      } catch (err) {
        log({ event: "error", class: "combat", error: String(err) });
      }

      if (opts.once) break;
    }
  } finally {
    unsubscribe();
  }
  // The latency report is a snapshot at shutdown (BRA-230): background
  // plays that finish after this land in the log lines, not here.
  summary.latency = perf.summary();
  log({ event: "shutdown", ...summary });
  return summary;
}
