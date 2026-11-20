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
 *   per build; ambiguous requests get a clarifying question in chat;
 *   out-of-scope requests get "I can't do that yet". The loop never
 *   guesses a position and never hallucinates a build.
 * - Everything else (open chat, requests, roleplay): logged as
 *   "needs-agent" and skipped. A human Muse can answer those from the
 *   log; the CLI does not improvise.
 *
 * Own messages never wake the monitor (same rule as waitForChat), and the
 * loop disconnects cleanly on SIGINT/SIGTERM.
 */
import type { FoundryLive } from "../live.js";
import type { ChatMessage } from "../types.js";
import { rollForChat, parseRollRequest } from "./dice.js";
import { CombatAutopilot } from "./autopilot.js";
import type { CombatStatus } from "./autopilot.js";
import { extractPin, handlePin, findOpenPins, PinProcessor } from "./pins.js";
import {
  BuildSession,
  parseBuildRequest,
  type BuildParseContext,
} from "./build-loop.js";
import { loadPack, type Pack } from "../worldbuilding/tiles-layout.js";
import type { BuiltTileRoom } from "../worldbuilding/tiles.js";

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
 * find it" — never invented.
 */
export async function answerQuestion(
  live: FoundryLive,
  intent: QuestionIntent,
): Promise<string> {
  switch (intent.kind) {
    case "turn":
    case "round": {
      const combat = live.getCombatState() as {
        _id: string;
        round: number;
        turn: number | null;
      } | null;
      if (!combat) return live.sendChat("No combat is running right now.");
      try {
        const pilot = new CombatAutopilot(live, combat._id);
        const st = pilot.status();
        const cur = st.current;
        if (intent.kind === "round") {
          return live.sendChat(`We're on round ${st.round}.`);
        }
        if (!cur) return live.sendChat(`Round ${st.round} — no one's turn yet.`);
        return live.sendChat(
          `It's **${cur.name}**'s turn — round ${st.round}, turn ${(st.turn ?? 0) + 1}/${st.combatants.length} (HP ${cur.hp}/${cur.hpMax}).`,
        );
      } catch {
        return live.sendChat("I couldn't read the combat tracker right now.");
      }
    }
    case "hp":
    case "ac": {
      const actor = await findActorByName(live, intent.name);
      if (!actor) return live.sendChat(`I couldn't find anyone named **${intent.name}**.`);
      if (intent.kind === "hp") {
        const hp = actor.system?.attributes?.hp;
        if (hp?.value === undefined) {
          return live.sendChat(`**${actor.name}** has no HP on their sheet that I can read.`);
        }
        return live.sendChat(`**${actor.name}** is at ${hp.value}/${hp.max ?? "?"} HP.`);
      }
      const ac = actor.system?.attributes?.ac?.value;
      if (ac === undefined) {
        return live.sendChat(`**${actor.name}** has no AC on their sheet that I can read.`);
      }
      return live.sendChat(`**${actor.name}**'s AC is ${ac}.`);
    }
    case "initiative": {
      const combat = live.getCombatState() as { _id: string } | null;
      if (!combat) return live.sendChat("No combat is running right now.");
      try {
        const pilot = new CombatAutopilot(live, combat._id);
        const st = pilot.status();
        const c = st.combatants.find(
          (x) => x.name.toLowerCase() === intent.name.toLowerCase(),
        );
        if (!c) return live.sendChat(`**${intent.name}** isn't in this combat.`);
        if (c.initiative === null) {
          return live.sendChat(`**${c.name}** hasn't rolled initiative yet.`);
        }
        return live.sendChat(`**${c.name}**'s initiative is ${c.initiative}.`);
      } catch {
        return live.sendChat("I couldn't read the combat tracker right now.");
      }
    }
    case "scene": {
      const scene = (await live.getSceneInfo()) as { name?: string } | null;
      if (!scene?.name) return live.sendChat("I couldn't tell which scene is active.");
      return live.sendChat(`We're on **${scene.name}**.`);
    }
  }
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
  skipped: number;
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
  const summary: MonitorSummary = {
    cycles: 0,
    messagesSeen: 0,
    answered: 0,
    rollsHandled: 0,
    pinsHandled: 0,
    combatAnnouncements: 0,
    buildsHandled: 0,
    clarifications: 0,
    skipped: 0,
  };
  const pins = new PinProcessor();
  // The build loop's state lives for the whole monitor run: the
  // dungeon spec + edit history (in memory — a restart loses it; a
  // state file is a follow-up, see BACKLOG.md) and the rooms already
  // built on the server, by room id.
  const buildSession = new BuildSession();
  const builtRooms = new Map<string, BuiltTileRoom>();
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
  log({ event: "started", alias, debounce, timeout, dryRun: !!opts.dryRun });

  try {
    for (;;) {
      if (opts.shouldStop?.()) break;
      summary.cycles += 1;
      const result = await live.waitForChat({ lastSeen, timeout, debounce });
      lastSeen = result.lastSeen;
      for (const msg of result.newMessages) {
        summary.messagesSeen += 1;
        const cls = classifyMessage(msg, live.userId, alias, {
          room: buildSession.activeRoomSpec() ?? undefined,
        });
        if (cls === "own" || cls === "noise") {
          summary.skipped += 1;
          log({ event: "skip", class: cls, id: msg.id });
          continue;
        }
        if (cls === "roll") {
          if (opts.dryRun) {
            log({ event: "roll", id: msg.id, dryRun: true });
          } else {
            try {
              const id = await rollForChat(live, stripHtml(msg.content));
              if (id) {
                summary.rollsHandled += 1;
                summary.answered += 1;
                log({ event: "roll", id: msg.id, posted: id });
              } else {
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
          const intent = parseQuestion(stripHtml(msg.content));
          if (!intent) {
            summary.skipped += 1;
            continue;
          }
          if (opts.dryRun) {
            log({ event: "question", id: msg.id, intent, dryRun: true });
          } else {
            try {
              const id = await answerQuestion(live, intent);
              summary.answered += 1;
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
        // being built.
        if (cls === "build" || cls === "clarify" || cls === "unsupported") {
          const text = stripHtml(msg.content);
          const parsed = parseBuildRequest(text, {
            room: buildSession.activeRoomSpec() ?? undefined,
          });
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
              await live.sendChat(parsed.question);
              summary.clarifications += 1;
              summary.answered += 1;
              log({ event: "build-clarify", id: msg.id, question: parsed.question });
            }
            continue;
          }
          if (parsed.kind === "unsupported") {
            const line = `I can't do that yet — ${parsed.reason}.`;
            if (opts.dryRun) {
              log({ event: "build-unsupported", id: msg.id, reason: parsed.reason, dryRun: true });
            } else {
              await live.sendChat(line);
              summary.clarifications += 1;
              summary.answered += 1;
              log({ event: "build-unsupported", id: msg.id, reason: parsed.reason });
            }
            continue;
          }
          if (opts.dryRun) {
            log({ event: "build", id: msg.id, op: parsed.op, dryRun: true });
            continue;
          }
          try {
            pack ??= loadPack(opts.packPath);
            // The executor imports the live composer — lazy, so the
            // pure tests never load the vendored client.
            const { executeBuild, serverBaseForWorld } = await import("./build-exec.js");
            const world = live.getWorldSummary() as { title?: string | null };
            const line = await executeBuild(live, buildSession, parsed.op, text, {
              pack,
              serverBase: opts.serverBase ?? serverBaseForWorld(world.title),
              built: builtRooms,
            });
            await live.sendChat(line);
            summary.buildsHandled += 1;
            summary.answered += 1;
            log({ event: "build", id: msg.id, op: parsed.op, line });
          } catch (err) {
            // A failed build never commits: the session is unchanged,
            // so the GM can rephrase and try again.
            const line = `I couldn't build that — ${err instanceof Error ? err.message : String(err)}`;
            try {
              await live.sendChat(line);
            } catch {
              // The table is unreachable; the log line below is the record.
            }
            log({ event: "error", class: "build", id: msg.id, error: String(err) });
          }
          continue;
        }
        // "chat" — needs a Muse's judgment. Log it, don't improvise.
        summary.skipped += 1;
        log({ event: "needs-agent", id: msg.id, text: stripHtml(msg.content).slice(0, 200) });
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
  log({ event: "shutdown", ...summary });
  return summary;
}
