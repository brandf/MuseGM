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

/** What the monitor does with one chat message. */
export type MessageClass =
  | "own" // our own message — never wake on it
  | "noise" // empty after stripping markup — nothing to answer
  | "roll" // parseRollRequest matched — roll it
  | "question" // parseQuestion matched — answer from live data
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
 * then noise, then the deterministic handlers, then "chat".
 */
export function classifyMessage(
  msg: ChatMessage,
  ownUserId: string | null,
  ownAlias: string,
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
}

export interface MonitorSummary {
  cycles: number;
  messagesSeen: number;
  answered: number;
  rollsHandled: number;
  pinsHandled: number;
  combatAnnouncements: number;
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
    skipped: 0,
  };
  const pins = new PinProcessor();
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
        const cls = classifyMessage(msg, live.userId, alias);
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
