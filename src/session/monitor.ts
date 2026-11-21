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
 *   Door verbs (BRA-234) ride the same branch — open/close/lock/
 *   unlock/listen are build ops, so "lock the south door" parses as
 *   a build, executes through the executor, and posts one line; a
 *   listen is a read (changed: false), so it posts its hint and
 *   touches nothing. No separate message class: classifyMessage
 *   returns "build" for a door verb, "clarify" when the door is
 *   ambiguous, exactly like any other build request.
 * - GM whispers (BRA-185, FR-18): a whisper from the GM to Meroki is
 *   an instruction, not table chatter. An embedded cutscene script or
 *   a named sequence ("mice and the ogre") is STAGED, not played —
 *   the stage-then-fire gate (BRA-244, below): the monitor whispers
 *   the staged preview back and waits for the GM's one-word nod
 *   ("fire" / "edit" / "drop") before anything moves. A whispered
 *   build or question routes through the normal paths with replies
 *   whispered back to the GM. A whispered rules question (BRA-205)
 *   is answered from the installed books, with citations — never a
 *   fabricated ruling. Anything else gets a whispered clarification.
 *   Rolls are out of scope for the whisper channel — they live in
 *   public chat.
 * - Stage-then-fire (BRA-244): a whispered script is validated and
 *   resolved against a live world snapshot (`stageCutscene`) without
 *   playing anything; the staged beat's preview (summary + first
 *   lines, never the whole script) goes to the GM by whisper, and a
 *   one-word reply on that thread fires it (hash-checked — a script
 *   edited after staging refuses), re-opens it for editing (the next
 *   pasted script re-stages it under a new id), or drops it. A bare
 *   "fire" with exactly one staged beat fires that one; with several
 *   staged, the GM names one by id. Beats live in memory for the
 *   run — a restart loses staged beats, and the GM re-pastes.
 * - Clocks (BRA-275): "start a 6-segment clock: the pursuit" starts
 *   a clock in one chat message (the pure parse is `parseClockStart`
 *   in clocks.ts); "tick the pursuit clock", "fill it to 4",
 *   "resolve", "reset", "stop" (drop) all route by name, and two
 *   clocks sharing a name are disambiguated by id — never guessed.
 *   A fired clock's consequence is delivered as the chat line. The
 *   clocks module has no pause: "pause" gets an honest clarification
 *   (clocks only tick on combat rounds, so ending combat pauses
 *   them). Every running clock also ticks once per new combat round
 *   from the monitor's combat check, with a chat line per tick.
 *   The store persists to a state file (same convention as the
 *   build/mode state), so a restart keeps the clocks.
 * - Cutscene prop recording (BRA-242): when the monitor plays a
 *   cutscene and the build session has an active room, the play
 *   carries the room spec (`roomSpec`) so played props are recorded
 *   into it — the updated spec is committed back into the build
 *   session (as an add-dressing history entry, so "undo that" takes
 *   the recording back) and the state file saved, so the next
 *   rebuild restores the prop. Only the newly recorded placements
 *   move in (rebased onto the session's current spec), so a GM edit
 *   made mid-play is never overwritten by the snapshot the play
 *   started from. With no active spec, props still play and the
 *   step result says so — the monitor adds nothing fake.
 * - Named lights (BRA-240, FR-7): "dim the braziers" routes to
 *   `animateNamedLights` — the name + target come from the pure
 *   parser (`src/session/light-commands.ts`), the scene is the
 *   active one, and the group animates in parallel with one
 *   confirmation line. Unknown or ambiguous names post the
 *   resolver's error verbatim as a clarification (it lists the names
 *   that exist) — never a guess. Checked after roll/question and
 *   before build, so "make the torches brighter" reaches the lights
 *   instead of the build parser's "can't do that yet". A light
 *   command is not GM-gated (same policy as build/question); a
 *   whispered one is confirmed privately, like any other reply.
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
import {
  animateNamedLights,
} from "./lights.js";
import {
  describeLightCommand,
  parseLightCommand,
} from "./light-commands.js";
import { lookupRuleLive } from "./rules.js";
import {
  stageCutscene,
  stageBeatInStore,
  fireBeat,
  dropBeat,
  editBeat,
  listBeats,
  emptyBeatStore,
  scriptHash,
  snapshotWorld,
  type BeatStore,
  type StagedBeat,
} from "./staging.js";
import {
  createClock,
  tickClock,
  fillClock,
  resolveClock,
  resetClock,
  dropClock,
  renderClock,
  renderClockStore,
  parseClockStart,
  advanceClocksToRound,
  readCombatRound,
  loadClockState,
  saveClockState,
  emptyClockStore,
  findClocksByName,
  type ClockStore,
} from "./clocks.js";
import type { RunSequenceOptions } from "./sequence.js";

/** What the monitor does with one chat message. */
export type MessageClass =
  | "own" // our own message — never wake on it
  | "noise" // empty after stripping markup — nothing to answer
  | "roll" // parseRollRequest matched — roll it
  | "question" // parseQuestion matched — answer from live data
  | "light" // parseLightCommand matched — animate a named light group
  | "clock" // parseClockCommand matched — start/tick/fill/resolve/reset/drop/list a clock
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
 * parse runs after roll/question/light/clock so a roll, a data question,
 * a light command, or a clock command never gets mistaken for a build
 * request — "make the torches brighter" would otherwise reach the
 * build parser's "can't do that yet". The light and clock parses need
 * no build context (their names resolve against live state at action
 * time).
 *
 * Branch order for the new routings (BRA-244/275/205/242): the
 * stage-then-fire reply is checked inside the whisper block before
 * classifyWhisper (a one-word "fire" is not a script); clocks
 * classify here, after light and before build; rules questions are
 * checked in the loop's fall-through, after every other branch, so
 * roll/question/light/clock/build always keep priority over them.
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
  if (parseLightCommand(text)) return "light";
  if (parseClockCommand(text)) return "clock";
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

// ---------------------------------------------------------------- stage replies, clocks, rules questions

/** A GM's one-word reply to a staged-beat preview (BRA-244). */
export type StageReply =
  | { action: "fire"; beatId?: string }
  | { action: "edit"; beatId?: string }
  | { action: "drop"; beatId?: string };

/**
 * Parse a one-word reply to a staged-beat preview: "fire", "edit",
 * or "drop", optionally naming the beat by id ("fire
 * staged-mice-ogre-a1b2c3d4") or with a filler ("fire it"). Anything
 * else — "fire the cannons", "fired", "drop the beat" — is not a
 * stage reply, so the message falls through to the ordinary routing
 * instead of firing the wrong thing.
 */
export function parseStageReply(text: string): StageReply | null {
  const s = stripHtml(text).trim();
  const m = /^(fire|edit|drop)\b\s*(.*)$/i.exec(s);
  if (!m) return null;
  const action = m[1].toLowerCase() as "fire" | "edit" | "drop";
  const rest = m[2].replace(/[?.!]+$/, "").trim();
  if (rest === "") return { action };
  if (/^(it|that|please|now)$/i.test(rest)) return { action };
  if (/^staged-[a-z0-9-]+$/i.test(rest)) return { action, beatId: rest };
  return null;
}

/**
 * The staged-beat preview whisper (BRA-244): the beat summary plus
 * the first lines of the preview — never the whole script — plus any
 * staging warnings and the one-word reply the GM answers with. The
 * beat id rides along so the GM can name it when several are staged.
 */
export function stagePreviewLine(beat: StagedBeat): string {
  const shown = beat.preview.slice(0, 3);
  const more = beat.preview.length - shown.length;
  const lines = [
    `🎭 Staged "${beat.name}" (${beat.id}):`,
    ...shown,
    ...(more > 0 ? [`…and ${more} more step${more === 1 ? "" : "s"}.`] : []),
    ...beat.warnings.map((w) => `⚠️ ${w}`),
    `Reply "fire" to play it, "edit" to change it, or "drop" to discard it.`,
  ];
  return lines.join("\n");
}

/** One clock instruction, parsed from a chat line (BRA-275). */
export type ClockCommand =
  | { kind: "create"; name: string; total: number; consequence?: string }
  | { kind: "clarify"; question: string }
  | { kind: "tick"; name: string; by: number }
  | { kind: "fill"; name: string; to: number }
  | { kind: "resolve"; name: string }
  | { kind: "reset"; name: string }
  | { kind: "drop"; name: string }
  | { kind: "pause"; name: string }
  | { kind: "list" };

/**
 * Parse a clock instruction in one chat message, or null when the
 * line is not a clock instruction at all (so the monitor falls
 * through to the other branches). Starts go through the clocks
 * module's own one-sentence parser (`parseClockStart`); the rest are
 * matched here. A line must name the clock and a clock verb — "the
 * clock is broken" and "build a clock tower" are not instructions.
 *
 * Recognized:
 *   "start a 6-segment clock: the pursuit" (create — via parseClockStart)
 *   "start the ritual clock" (clarify — how many segments?)
 *   "tick the ritual clock" / "tick the ritual clock by 2" / "advance the ritual clock"
 *   "the dragon clock ticks" / "the dragon clock ticks by 2"
 *   "fill the ritual clock to 4" (no count → clarify)
 *   "resolve the ritual clock" / "reset the ritual clock"
 *   "stop the omen clock" / "drop the omen clock" (stop = drop)
 *   "pause the ritual clock" (no pause op exists — a clarify)
 *   "show the clocks" / "list clocks" / "what clocks are running"
 */
export function parseClockCommand(text: string): ClockCommand | null {
  const s = stripHtml(text).trim();
  if (!/\bclock/i.test(s)) return null;
  const start = parseClockStart(s);
  if (start) {
    if (start.kind === "create") {
      return {
        kind: "create",
        name: start.name,
        total: start.total,
        ...(start.consequence !== undefined ? { consequence: start.consequence } : {}),
      };
    }
    return { kind: "clarify", question: start.question };
  }
  if (/^(show|list)\b[^.?!]*\bclocks?\b/i.test(s)) return { kind: "list" };
  if (/^what\s+clocks?\s+(are|do we|have we)\b/i.test(s)) return { kind: "list" };
  const verbFirst =
    /^(tick|advance|fill|resolve|reset|drop|stop|pause)\s+(?:the\s+)?(.+?)\s+clock\b\s*(.*)$/i.exec(s);
  if (verbFirst) {
    const verb = verbFirst[1].toLowerCase();
    const name = verbFirst[2].replace(/\s+/g, " ").trim();
    if (!name) return null;
    const rest = verbFirst[3].replace(/[?.!]+$/, "").trim();
    if (verb === "tick" || verb === "advance") {
      const byM = /^by\s+(\d+)$/i.exec(rest);
      if (rest !== "" && !byM) return null;
      return { kind: "tick", name, by: byM ? Number(byM[1]) : 1 };
    }
    if (verb === "fill") {
      const toM = /^to\s+(\d+)$/i.exec(rest);
      if (!toM) {
        return { kind: "clarify", question: `Fill the "${name}" clock to how many segments?` };
      }
      return { kind: "fill", name, to: Number(toM[1]) };
    }
    if (rest !== "") return null;
    if (verb === "resolve") return { kind: "resolve", name };
    if (verb === "reset") return { kind: "reset", name };
    if (verb === "drop" || verb === "stop") return { kind: "drop", name };
    return { kind: "pause", name };
  }
  const subjectFirst =
    /^(?:the\s+)?(.+?)\s+clock\s+ticks?(?:\s+by\s+(\d+))?\s*[?.!]*$/i.exec(s);
  if (subjectFirst) {
    const name = subjectFirst[1].replace(/\s+/g, " ").trim();
    if (name) return { kind: "tick", name, by: subjectFirst[2] ? Number(subjectFirst[2]) : 1 };
  }
  return null;
}

/** What applying a clock command produces: a chat line, or a clarifying question. */
export type ClockActionResult =
  | { store: ClockStore; line: string }
  | { store: ClockStore; clarify: string };

/**
 * The name a clock command names, with the leading article toggled
 * when the name as spoken matches nothing: the GM says "tick the
 * ritual clock" whether the clock is named "ritual" or "the ritual"
 * (the clocks module keeps the article from the start line, the
 * command parser drops it from the tick line). Never a guess between
 * two clocks — the toggle only fires when the direct name matches
 * nothing, and the op below still throws the module's own listing
 * error when neither form matches, and its ambiguity error when a
 * form matches more than one.
 */
function resolveClockName(store: ClockStore, name: string): string {
  if (findClocksByName(store, name).length > 0) return name;
  const toggled = /^the\s+/i.test(name)
    ? name.replace(/^the\s+/i, "")
    : `the ${name}`;
  if (findClocksByName(store, toggled).length > 0) return toggled;
  return name;
}

/**
 * Apply a parsed clock command to a store (pure — the monitor posts
 * the line and persists the store). Clock errors (unknown name, a
 * tick on a fired clock) throw the clocks module's own error, which
 * names the clocks that exist — the caller posts it as a
 * clarification, never a guess. A second clock with the same name
 * gets its id in the line, so the table can tell them apart.
 */
export function applyClockCommand(
  store: ClockStore,
  cmd: ClockCommand,
  source: string,
): ClockActionResult {
  switch (cmd.kind) {
    case "create": {
      const { store: next, clock } = createClock(store, {
        name: cmd.name,
        total: cmd.total,
        ...(cmd.consequence !== undefined ? { consequence: cmd.consequence } : {}),
        source,
      });
      const sameName = findClocksByName(next, cmd.name).length > 1;
      return {
        store: next,
        line: renderClock(clock) + (sameName ? ` (id: ${clock.id})` : ""),
      };
    }
    case "clarify":
      return { store, clarify: cmd.question };
    case "tick": {
      const res = tickClock(store, resolveClockName(store, cmd.name), { by: cmd.by, source });
      return { store: res.store, line: renderClock(res.clock) };
    }
    case "fill": {
      const res = fillClock(store, resolveClockName(store, cmd.name), { to: cmd.to, source });
      return { store: res.store, line: renderClock(res.clock) };
    }
    case "resolve": {
      const { store: next, clock } = resolveClock(store, resolveClockName(store, cmd.name), {
        source,
      });
      return { store: next, line: renderClock(clock) };
    }
    case "reset": {
      const { store: next, clock } = resetClock(store, resolveClockName(store, cmd.name), {
        source,
      });
      return { store: next, line: renderClock(clock) };
    }
    case "drop": {
      const { store: next, clock } = dropClock(store, resolveClockName(store, cmd.name), {
        source,
      });
      return { store: next, line: renderClock(clock) };
    }
    case "pause":
      return {
        store,
        clarify: `Clocks only tick on combat rounds, so ending combat pauses the "${cmd.name}" clock — or say "stop the ${cmd.name} clock" to drop it.`,
      };
    case "list":
      return { store, line: renderClockStore(store) };
  }
}

/**
 * PF2e rules vocabulary a whispered question must contain to route
 * to the rule lookup (BRA-205): conditions, named actions, and core
 * nouns. Deliberately distinctive words — a bare "check" or "save"
 * would steal ordinary sentences ("save the prince"), so those stay
 * out and the lookup's own tokeniser does the rest.
 */
const RULES_TERMS: readonly string[] = [
  "flat-footed", "off-guard", "frightened", "grabbed", "prone", "stunned", "slowed",
  "sickened", "concealed", "hidden", "undetected", "observed", "dazzled", "deafened",
  "blinded", "confused", "controlled", "dying", "unconscious", "paralyzed", "petrified",
  "restrained", "immobilized", "fascinated", "fleeing", "encumbered", "clumsy", "drained",
  "enfeebled", "stupefied", "quickened", "invisible", "doomed", "wounded", "broken",
  "reload", "stride", "strike", "treat wounds", "demoralize", "feint", "grapple", "shove",
  "trip", "disarm", "escape", "seek", "hide", "sneak", "recall knowledge", "cast a spell",
  "raise a shield", "take cover", "ready", "delay", "aid", "defend", "leap", "swim", "climb",
  "interact", "release", "drop",
  "action", "actions", "reaction", "free action", "saving throw", "armor class", "spell",
  "feat", "skill", "proficiency", "critical", "crit", "hero point", "initiative",
  "attack roll", "damage", "resistance", "weakness", "immunity", "multiple attack penalty", "dc",
];

/**
 * Does this whisper read as a rules question ("what does flat-footed
 * do?", "how many actions to reload?")? It must carry a rules term
 * AND a question shape (a question word, or a "?"). "What does the
 * door do?" has the shape but no term; "the flat-footed condition"
 * has the term but no question — neither routes. Returns the question
 * text when it routes, else null. The lookup itself decides whether
 * the books answer it — this only decides whether to ask them.
 */
export function parseRulesQuestion(text: string): string | null {
  const s = stripHtml(text).trim();
  if (!s) return null;
  const lower = ` ${s.toLowerCase().replace(/[^a-z0-9-]+/g, " ")} `;
  const hasTerm = RULES_TERMS.some((t) => lower.includes(` ${t} `));
  if (!hasTerm) return null;
  const questionShape =
    /^(what|how|does|do|can|could|is|are|when|why|which)\b/i.test(s) || s.includes("?");
  return questionShape ? s : null;
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
    /** Room spec the played props belong to (BRA-242): when given,
     *  the play records played props into it (see runSequence's
     *  roomSpec) and hands the updated spec back through onSpec —
     *  the caller persists it. */
    roomSpec?: RunSequenceOptions["roomSpec"];
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
    roomSpec: opts.roomSpec,
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

// ---------------------------------------------------------------- stage-then-fire (BRA-244)

/** What staging (or refusing) a whispered sequence resolved to. */
export type WhisperStageOutcome =
  | { state: "staged"; id: string; name: string; duplicate: boolean }
  | { state: "rejected"; name: string | null; reason: string };

/**
 * Stage a sequence the GM whispered — validate it and resolve every
 * reference against a live world snapshot, WITHOUT playing anything
 * — and whisper the staged preview back. The GM fires, edits, or
 * drops the beat with a one-word reply (handleStageReply); nothing
 * plays here, so a whispered script is never a silent big moment.
 *
 * A revision: when the GM answered "edit" on a staged beat and then
 * pastes a script, the old beat is dropped and the new one takes its
 * place under a new id (the id is the script's hash); a failed
 * re-stage leaves the old beat exactly as it was, and the wait stays
 * open. A named sequence stages fresh and clears any edit wait — the
 * GM moved on to a different beat.
 */
export async function handleWhisperStage(
  live: FoundryLive,
  msg: ChatMessage,
  gmId: string,
  w:
    | { kind: "script"; script: unknown }
    | { kind: "named"; key: NamedSequenceKey }
    | { kind: "script-invalid"; error: string },
  opts: {
    onLog?: (log: MonitorLog) => void;
    beatStore: BeatStore;
    /** A beat awaiting a revised script ("edit" was answered). */
    pendingEditBeatId?: string | null;
  },
): Promise<{
  outcome: WhisperStageOutcome;
  store: BeatStore;
  pendingEdit: string | null;
}> {
  const log = opts.onLog ?? (() => {});
  const whisperTo = (text: string): Promise<string> =>
    live.sendChat(text, { whisperTo: [gmId] });
  const pendingEdit = opts.pendingEditBeatId ?? null;
  if (w.kind === "script-invalid") {
    await whisperTo(
      `I couldn't read that script — ${w.error}. Paste the full cutscene JSON and I'll stage it.`,
    );
    log({ event: "whisper-rejected", id: msg.id, reason: "unparseable script" });
    return {
      outcome: { state: "rejected", name: null, reason: w.error },
      store: opts.beatStore,
      pendingEdit,
    };
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
      return {
        outcome: { state: "rejected", name, reason },
        store: opts.beatStore,
        pendingEdit,
      };
    }
  } else {
    script = w.script;
    const rawName = (script as { name?: unknown }).name;
    name = typeof rawName === "string" && rawName.length > 0 ? rawName : "that sequence";
  }
  let world;
  try {
    world = await snapshotWorld(live);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await whisperTo(`I couldn't read the world to stage "${name}" — ${reason}`);
    log({ event: "whisper-rejected", id: msg.id, name, reason });
    return {
      outcome: { state: "rejected", name, reason },
      store: opts.beatStore,
      pendingEdit,
    };
  }
  if (pendingEdit !== null && w.kind === "script") {
    const edited = editBeat(opts.beatStore, pendingEdit, script, world);
    if (!edited.ok) {
      await whisperTo(
        `That revision doesn't stage:\n- ${edited.errors.slice(0, 5).join("\n- ")}\nThe old beat is unchanged — paste another revision, or reply "drop" to discard it.`,
      );
      log({
        event: "whisper-edit-rejected",
        id: msg.id,
        beatId: pendingEdit,
        errors: edited.errors,
      });
      return {
        outcome: { state: "rejected", name, reason: edited.errors.join("; ") },
        store: opts.beatStore,
        pendingEdit,
      };
    }
    const beat = edited.beat;
    await whisperTo(stagePreviewLine(beat));
    log({
      event: "whisper-staged",
      id: msg.id,
      beatId: beat.id,
      name: beat.name,
      editedFrom: pendingEdit,
    });
    return {
      outcome: { state: "staged", id: beat.id, name: beat.name, duplicate: false },
      store: edited.store,
      pendingEdit: null,
    };
  }
  const staged = stageCutscene(script, world);
  if (!staged.ok) {
    const shown = staged.errors.slice(0, 5);
    const more =
      staged.errors.length > 5 ? `\n…and ${staged.errors.length - 5} more.` : "";
    await whisperTo(
      `That script doesn't stage:\n- ${shown.join("\n- ")}${more}\nFix those and paste it again — I won't stage a beat that can't play.`,
    );
    log({ event: "whisper-rejected", id: msg.id, name, errors: staged.errors });
    return {
      outcome: { state: "rejected", name, reason: staged.errors.join("; ") },
      store: opts.beatStore,
      pendingEdit: null,
    };
  }
  const beat = staged.beat;
  const added = stageBeatInStore(opts.beatStore, beat);
  if (added.duplicate) {
    await whisperTo(
      `"${beat.name}" is already staged as ${beat.id} — reply "fire" to play it, "edit" to change it, or "drop" to discard it.`,
    );
    log({ event: "whisper-staged", id: msg.id, beatId: beat.id, name: beat.name, duplicate: true });
    return {
      outcome: { state: "staged", id: beat.id, name: beat.name, duplicate: true },
      store: opts.beatStore,
      pendingEdit: null,
    };
  }
  await whisperTo(stagePreviewLine(beat));
  log({ event: "whisper-staged", id: msg.id, beatId: beat.id, name: beat.name });
  return {
    outcome: { state: "staged", id: beat.id, name: beat.name, duplicate: false },
    store: added.store,
    pendingEdit: null,
  };
}

/**
 * Act on the GM's one-word reply to a staged-beat preview: fire it
 * (hash-checked, then played in the background through the normal
 * whisper play path), open it for editing (the next pasted script
 * re-stages it), or drop it (one confirmation line). A reply that
 * names no staged beat — a bare "fire" with nothing staged — is not
 * handled here, so the caller falls through to the ordinary routing
 * instead of answering a question nobody asked.
 */
export async function handleStageReply(
  live: FoundryLive,
  msg: ChatMessage,
  gmId: string,
  beatStore: BeatStore,
  reply: StageReply,
  opts: {
    onLog?: (log: MonitorLog) => void;
    onLatency?: (ev: WhisperLatencyEvent) => void;
    roomSpec?: RunSequenceOptions["roomSpec"];
    pendingEditBeatId?: string | null;
  } = {},
): Promise<{
  handled: boolean;
  store: BeatStore;
  pendingEdit: string | null;
  beatId?: string;
  action?: StageReply["action"];
}> {
  const log = opts.onLog ?? (() => {});
  const pendingEdit = opts.pendingEditBeatId ?? null;
  const whisperTo = (text: string): Promise<string> =>
    live.sendChat(text, { whisperTo: [gmId] });
  const staged = listBeats(beatStore).filter((b) => b.status === "staged");
  let target: { id: string; name: string } | undefined;
  if (reply.beatId !== undefined) {
    const rec = beatStore.beats[reply.beatId];
    if (!rec || rec.status !== "staged") {
      const known =
        staged.length === 0
          ? "nothing is staged right now"
          : `staged now: ${staged.map((b) => b.beat.id).join(", ")}`;
      await whisperTo(`No staged beat "${reply.beatId}" — ${known}.`);
      log({
        event: "stage-reply",
        id: msg.id,
        action: reply.action,
        beatId: reply.beatId,
        ok: false,
      });
      return { handled: true, store: beatStore, pendingEdit };
    }
    target = { id: rec.beat.id, name: rec.beat.name };
  } else if (staged.length === 0) {
    return { handled: false, store: beatStore, pendingEdit };
  } else if (staged.length === 1) {
    target = { id: staged[0].beat.id, name: staged[0].beat.name };
  } else {
    await whisperTo(
      `More than one beat is staged — which one? ${staged
        .map((b) => `"${b.beat.name}" (${b.beat.id})`)
        .join(", ")} — reply "fire <id>", "edit <id>", or "drop <id>".`,
    );
    log({ event: "stage-reply", id: msg.id, action: reply.action, ok: false, reason: "ambiguous" });
    return { handled: true, store: beatStore, pendingEdit };
  }
  if (reply.action === "drop") {
    const dropped = dropBeat(beatStore, target.id);
    if (!dropped.ok) {
      await whisperTo(dropped.error);
      return { handled: true, store: beatStore, pendingEdit };
    }
    await whisperTo(`Dropped "${target.name}".`);
    log({ event: "stage-reply", id: msg.id, action: "drop", beatId: target.id });
    return {
      handled: true,
      store: dropped.store,
      pendingEdit: pendingEdit === target.id ? null : pendingEdit,
      beatId: target.id,
      action: "drop",
    };
  }
  if (reply.action === "edit") {
    await whisperTo(
      `Paste the revised script for "${target.name}" and I'll re-stage it — or reply "drop" to discard it.`,
    );
    log({ event: "stage-reply", id: msg.id, action: "edit", beatId: target.id });
    return {
      handled: true,
      store: beatStore,
      pendingEdit: target.id,
      beatId: target.id,
      action: "edit",
    };
  }
  // Fire: the hash check first — a beat edited after staging never
  // fires, and stays staged so the GM can re-stage or drop it.
  const beat = beatStore.beats[target.id].beat;
  if (scriptHash(beat.script) !== beat.scriptHash) {
    await whisperTo(`"${target.name}" was edited after staging — re-stage it before firing.`);
    log({
      event: "stage-reply",
      id: msg.id,
      action: "fire",
      beatId: target.id,
      ok: false,
      reason: "hash mismatch",
    });
    return { handled: true, store: beatStore, pendingEdit, beatId: target.id, action: "fire" };
  }
  const outcome = await handleWhisperSequence(
    live,
    msg,
    gmId,
    { kind: "script", script: beat.script },
    {
      onLog: log,
      onLatency: opts.onLatency,
      roomSpec: opts.roomSpec,
    },
  );
  if (outcome.state !== "started") {
    // The play refused. Validation is deterministic on an unchanged
    // script, so this should not happen — but the beat stays staged
    // either way, never marked fired for a play that did not start.
    log({
      event: "stage-reply",
      id: msg.id,
      action: "fire",
      beatId: target.id,
      ok: false,
      reason: outcome.reason,
    });
    return { handled: true, store: beatStore, pendingEdit, beatId: target.id, action: "fire" };
  }
  const fired = fireBeat(beatStore, target.id);
  if (!fired.ok) {
    log({
      event: "stage-reply",
      id: msg.id,
      action: "fire",
      beatId: target.id,
      ok: false,
      reason: fired.error,
    });
    return { handled: true, store: beatStore, pendingEdit, beatId: target.id, action: "fire" };
  }
  log({ event: "stage-reply", id: msg.id, action: "fire", beatId: target.id });
  return {
    handled: true,
    store: fired.store,
    pendingEdit: pendingEdit === target.id ? null : pendingEdit,
    beatId: target.id,
    action: "fire",
  };
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
  /** Clock state file (default: $FOUNDRY_CLOCK_STATE or the repo's
   *  .clock-state.json). Read on start, written after every clock
   *  change and every combat-round tick, so a restart keeps the
   *  clocks and their history. */
  clockStatePath?: string;
}

export interface MonitorSummary {
  cycles: number;
  messagesSeen: number;
  answered: number;
  rollsHandled: number;
  pinsHandled: number;
  combatAnnouncements: number;
  buildsHandled: number;
  /** Named-light commands animated (BRA-240, FR-7). */
  lightsHandled: number;
  /** Clock commands acted on (BRA-275): starts, ticks, fills,
   *  resolves, resets, drops, lists, and combat-round ticks. */
  clocksHandled: number;
  /** GM-whisper rules questions answered from the books (BRA-205). */
  rulesHandled: number;
  /** Stage-then-fire actions (BRA-244): staged previews sent and
   *  fire/edit/drop replies handled. */
  stagesHandled: number;
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
    lightsHandled: 0,
    clocksHandled: 0,
    rulesHandled: 0,
    stagesHandled: 0,
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
  // Clocks (BRA-275): the store lives for the whole run, persisted
  // to the state file after every change, so a restart keeps the
  // clocks and their history. A missing or corrupt file starts
  // fresh, as with the build/mode state.
  let clockStore: ClockStore = loadClockState(opts.clockStatePath) ?? emptyClockStore();
  if (clockStore.clocks.length > 0) {
    log({ event: "clock-state-restored", clocks: clockStore.clocks.length });
  }
  // Stage-then-fire beats (BRA-244): in memory for the run only — a
  // restart loses staged beats, and the GM re-pastes the script.
  // `pendingEditBeatId` is the beat awaiting a revised script after
  // the GM answered "edit" on its preview.
  let beatStore: BeatStore = emptyBeatStore();
  let pendingEditBeatId: string | null = null;
  // Whisper latency (BRA-230): one timer per whispered play, finished
  // on the first completed step (first visible effect); per-step
  // durations are recorded as the player measures them. A play that
  // never starts leaves its timer dropped — no phantom "effect".
  const whisperLatency = (messageId: string): ((ev: WhisperLatencyEvent) => void) => {
    const timer = perf.start("whisper-first-effect", messageId);
    return (ev) => {
      if (ev.type === "first-effect") {
        recordLatency(perf.finish(timer));
      } else {
        recordLatency(
          perf.recordDuration(
            cutsceneStepKind(ev.kind),
            ev.durationMs,
            `${messageId}:${ev.index}`,
          ),
        );
      }
    };
  };
  // Cutscene prop recording (BRA-242): the room spec a play's props
  // belong to — the build session's active room, with the pack the
  // room was built from. Only the newly recorded placements move
  // into the session (rebased onto its current spec, by placement
  // id), so a GM edit made mid-play is never overwritten by the
  // snapshot the play started from. Each recording commits as an
  // add-dressing history entry and saves the state file, so the next
  // rebuild restores the prop and "undo that" takes it back. No
  // active room, or a pack that will not load, means no spec — the
  // props still play, and the step result says so.
  const buildRoomSpecOption = (): RunSequenceOptions["roomSpec"] | undefined => {
    const cur = buildSession.current();
    const roomId = cur.activeRoom;
    if (!roomId) return undefined;
    const spec = cur.dungeon.rooms.find((r) => r.id === roomId);
    if (!spec) return undefined;
    try {
      pack ??= loadPack(opts.packPath);
    } catch (err) {
      log({
        event: "room-spec-unavailable",
        reason: `tile pack did not load: ${err instanceof Error ? err.message : String(err)}`,
      });
      return undefined;
    }
    if (!pack) return undefined;
    const snapshot = spec;
    const snapshotIds = new Set(
      (snapshot.dressing ?? []).map((p) => p.id).filter((id): id is string => !!id),
    );
    return {
      spec: snapshot,
      pack,
      onSpec: (updated) => {
        const added = (updated.dressing ?? []).filter(
          (p) => p.id !== undefined && !snapshotIds.has(p.id),
        );
        if (added.length === 0) return;
        const now = buildSession.current();
        const room = now.dungeon.rooms.find((r) => r.id === roomId);
        if (!room) return;
        const existingIds = new Set(
          (room.dressing ?? []).map((p) => p.id).filter((id): id is string => !!id),
        );
        const fresh = added.filter((p) => p.id !== undefined && !existingIds.has(p.id));
        if (fresh.length === 0) return;
        const next = {
          ...now,
          dungeon: {
            ...now.dungeon,
            rooms: now.dungeon.rooms.map((r) =>
              r.id === roomId
                ? { ...r, dressing: [...(r.dressing ?? []), ...fresh] }
                : r,
            ),
          },
        };
        const first = fresh[0];
        buildSession.commit(
          next,
          `Cutscene recorded a prop in ${room.name}`,
          { type: "add-dressing", tile: first.tile, where: { kind: "cell", gx: first.gx, gy: first.gy } },
          `Recorded ${fresh.map((p) => `the ${p.tile} at (${p.gx}, ${p.gy})`).join(", ")} in ${room.name} (cutscene prop).`,
        );
        saveBuildState(buildSession, builtRooms, opts.buildStatePath);
        log({ event: "prop-recorded", room: roomId, props: fresh.map((p) => p.tile) });
      },
    };
  };
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
          // --- Stage-then-fire replies (BRA-244): checked before
          // classifyWhisper, because a one-word "fire" is not a
          // script and must never be read as one. A bare fire/edit/
          // drop with nothing staged is not handled here — it falls
          // through to the ordinary routing below, which ends at
          // WHISPER_CLARIFY. Staging is awaited (unlike the old
          // background play): the beat store must hold the staged
          // beat before the GM's next message — "fire" — is read.
          const stageReply = parseStageReply(text);
          if (stageReply) {
            if (opts.dryRun) {
              log({
                event: "stage-reply",
                id: msg.id,
                action: stageReply.action,
                dryRun: true,
              });
              continue;
            }
            const handled = await handleStageReply(live, msg, gmId, beatStore, stageReply, {
              onLog: log,
              onLatency: whisperLatency(msg.id),
              roomSpec: buildRoomSpecOption(),
              pendingEditBeatId,
            });
            beatStore = handled.store;
            pendingEditBeatId = handled.pendingEdit;
            if (handled.handled) {
              summary.whispersHandled += 1;
              summary.stagesHandled += 1;
              summary.answered += 1;
              continue;
            }
            // Not handled (nothing staged) — fall through to the
            // ordinary routing below, which ends at WHISPER_CLARIFY.
          }
          const w = classifyWhisper(text);
          if (w.kind !== "other") {
            if (opts.dryRun) {
              log({ event: "whisper", id: msg.id, class: w.kind, dryRun: true });
            } else {
              // A whispered sequence is STAGED, not played (BRA-244):
              // validated and resolved against a live snapshot, then
              // a preview goes to the GM by whisper and the GM's
              // one-word reply fires it. Nothing moves until the GM
              // nods. The play itself now starts from handleStageReply
              // ("fire"), which backgrounds it the same way the old
              // whisper play was backgrounded.
              summary.whispersHandled += 1;
              summary.answered += 1;
              const staged = await handleWhisperStage(live, msg, gmId, w, {
                onLog: log,
                beatStore,
                pendingEditBeatId,
              });
              beatStore = staged.store;
              pendingEditBeatId = staged.pendingEdit;
              if (staged.outcome.state === "staged") {
                summary.stagesHandled += 1;
              }
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
        // Named lights (BRA-240, FR-7): "dim the braziers" animates
        // the group on the active scene, in parallel, with one
        // confirmation line. The name resolves at action time, so an
        // unknown or ambiguous name posts the resolver's error
        // verbatim as a clarification (it lists the names that
        // exist) — never a guess. No active scene is a clarification
        // too. A whispered command is confirmed privately, like any
        // other reply. The parse runs again here (classify only
        // returned the class).
        if (cls === "light") {
          const cmd = parseLightCommand(text);
          if (!cmd) {
            // Classify said light, the parse says otherwise —
            // defensive; treat as needs-agent rather than acting on
            // the wrong thing.
            summary.skipped += 1;
            log({ event: "needs-agent", id: msg.id, text: text.slice(0, 200) });
            continue;
          }
          if (opts.dryRun) {
            log({ event: "light", id: msg.id, name: cmd.name, target: cmd.target, dryRun: true });
            continue;
          }
          try {
            const sceneId = live.getActiveSceneId();
            if (!sceneId) {
              await say("I couldn't tell which scene is active.");
              summary.clarifications += 1;
              summary.answered += 1;
              if (whisper) summary.whispersHandled += 1;
              log({ event: "light-clarify", id: msg.id, reason: "no active scene" });
              continue;
            }
            const { name } = await animateNamedLights(live, sceneId, cmd.name, cmd.target);
            await say(describeLightCommand(cmd, name));
            summary.lightsHandled += 1;
            summary.answered += 1;
            if (whisper) summary.whispersHandled += 1;
            log({ event: "light", id: msg.id, name, target: cmd.target });
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            try {
              await say(reason);
            } catch {
              // The table is unreachable; the log line below is the record.
            }
            summary.clarifications += 1;
            summary.answered += 1;
            if (whisper) summary.whispersHandled += 1;
            log({ event: "light-clarify", id: msg.id, error: reason });
          }
          continue;
        }
        // Clocks (BRA-275): start/tick/fill/resolve/reset/drop/list by
        // name, one confirmation line with the clock's new state. The
        // parse runs again here (classify only returned the class).
        // Unknown names and bad states surface the clocks module's
        // own error as a clarification (it lists the clocks that
        // exist) — never a guess. The store is saved after every
        // change, so a restart keeps the clocks. A whispered command
        // is confirmed privately, like any other reply.
        if (cls === "clock") {
          const cmd = parseClockCommand(text);
          if (!cmd) {
            // Classify said clock, the parse says otherwise —
            // defensive; treat as needs-agent rather than acting on
            // the wrong thing.
            summary.skipped += 1;
            log({ event: "needs-agent", id: msg.id, text: text.slice(0, 200) });
            continue;
          }
          if (opts.dryRun) {
            log({ event: "clock", id: msg.id, command: cmd.kind, dryRun: true });
            continue;
          }
          try {
            const res = applyClockCommand(clockStore, cmd, msg.id);
            clockStore = res.store;
            if ("clarify" in res) {
              await say(res.clarify);
              summary.clarifications += 1;
              summary.answered += 1;
              if (whisper) summary.whispersHandled += 1;
              log({ event: "clock-clarify", id: msg.id, command: cmd.kind, question: res.clarify });
            } else {
              await say(res.line);
              saveClockState(clockStore, opts.clockStatePath);
              summary.clocksHandled += 1;
              summary.answered += 1;
              if (whisper) summary.whispersHandled += 1;
              log({ event: "clock", id: msg.id, command: cmd.kind, line: res.line });
            }
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            try {
              await say(reason);
            } catch {
              // The table is unreachable; the log line below is the record.
            }
            summary.clarifications += 1;
            summary.answered += 1;
            if (whisper) summary.whispersHandled += 1;
            log({ event: "clock-clarify", id: msg.id, command: cmd.kind, error: reason });
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
        // Rules questions by whisper (BRA-205): checked after every
        // other branch, so roll/question/light/clock/build always
        // keep priority — "what's Valeros's ac?" is a data question,
        // not a rules question, and was answered above. Whisper-only:
        // a public-chat rules question stays needs-agent. The answer
        // carries its Source lines; a not-found answer says so with
        // the closest matches, never a fabricated ruling. Latency is
        // recorded under the unbudgeted "question" kind (measured,
        // never flagged).
        if (whisper) {
          const rulesQuestion = parseRulesQuestion(text);
          if (rulesQuestion) {
            if (opts.dryRun) {
              log({ event: "rules", id: msg.id, dryRun: true });
            } else {
              try {
                const rulesTimer = perf.start("question", msg.id);
                const answer = await lookupRuleLive(live, rulesQuestion);
                recordLatency(perf.finish(rulesTimer));
                await say(answer.answer);
                summary.rulesHandled += 1;
                summary.answered += 1;
                summary.whispersHandled += 1;
                log({
                  event: "rules",
                  id: msg.id,
                  found: answer.found,
                  citations: answer.citations.length,
                });
              } catch (err) {
                try {
                  await say("I couldn't look that up right now.");
                } catch {
                  // The table is unreachable; the log line below is the record.
                }
                log({ event: "error", class: "rules", id: msg.id, error: String(err) });
              }
            }
            continue;
          }
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

      // Clocks tick on combat rounds (BRA-275): in its own try block
      // after the combat announcements, so an autopilot failure never
      // blocks the clocks (and vice versa). One tick per new round,
      // idempotent per round through the store's cursor; a new combat
      // resets the tracking. Each tick posts one chat line per clock
      // that advanced — a fired clock's line carries its consequence.
      // Never run the clocks --watch CLI against the same state file
      // at the same time: two writers to one state file could
      // double-tick.
      try {
        const round = readCombatRound(live);
        if (round) {
          const before = clockStore;
          const { store: next, events } = advanceClocksToRound(clockStore, {
            combatId: round.combatId,
            round: round.round,
            source: `combat:${round.combatId}:round:${round.round}`,
          });
          if (next !== before) {
            clockStore = next;
            if (!opts.dryRun) saveClockState(clockStore, opts.clockStatePath);
            for (const ev of events) {
              const line = renderClock(ev.clock);
              if (opts.dryRun) {
                log({ event: "clock-tick", dryRun: true, text: line });
              } else {
                await live.sendChat(line);
                summary.clocksHandled += 1;
                log({ event: "clock-tick", text: line });
              }
            }
          }
        }
      } catch (err) {
        log({ event: "error", class: "clock-tick", error: String(err) });
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
