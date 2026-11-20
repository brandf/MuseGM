/**
 * Session recaps (P2) — read the chat log after a game and write the recap
 * into a journal entry.
 *
 * HONESTY RULE: a recap only reports what the log actually contains. Every
 * extracted event quotes the message it came from, and the recap says
 * "nothing notable happened" when the log has nothing to report. It never
 * invents kills, loot, decisions, or story beats that aren't in the log.
 * Messages from Meroki (the assistant) are announcements, not player
 * actions — kills and loot are taken from those announcement lines, and
 * player speech is quoted, never paraphrased into facts.
 *
 * Two layers, kept separate on purpose (same pattern as src/session/dice.ts):
 * - Pure functions (buildRecap / recapToText / recapToJournalHtml): no
 *   Foundry, no I/O, unit tested in tests/recap.test.ts on a fixture log.
 * - Live function (postRecap): reads the chat log, builds the recap, and
 *   creates a journal entry + posts a summary to chat.
 *
 * What is extracted (pattern-matched, case-insensitive, on plain text
 * stripped of HTML tags):
 * - Kills/downs: "X is down", "X dies", "X is defeated", "X falls".
 * - Combat milestones: "Combat over", "Round N" turn lines (counted,
 *   not listed one by one), "combat" starts.
 * - Loot: lines mentioning gp/gold/chest/loot/potion with an amount.
 * - Notable rolls: "Natural 20" / "Natural 1" callouts.
 * - Room entries: "🏰 <name>" scene-build announcements.
 * Everything else is ignored — a quiet log makes a quiet recap.
 */
import type { FoundryLive } from "../live.js";
import type { ChatMessage } from "../types.js";

/** One event extracted from the log, with its source message. */
export interface RecapEvent {
  /** "kill" | "loot" | "combat" | "roll" | "room". */
  kind: string;
  /** Short human-readable line. */
  text: string;
  /** The message _id it came from. */
  messageId: string;
}

/** A built recap, ready to render as text or a journal page. */
export interface Recap {
  title: string;
  /** ISO date of the recap (today, unless given). */
  date: string;
  events: RecapEvent[];
  /** Kills/downs, in log order. */
  kills: RecapEvent[];
  /** Loot lines, in log order. */
  loot: RecapEvent[];
  /** Combat milestones (starts/ends/rounds). */
  combat: RecapEvent[];
  /** Natural 20 / natural 1 lines. */
  notableRolls: RecapEvent[];
  /** Rooms entered. */
  rooms: RecapEvent[];
  /** How many chat messages the recap was built from. */
  messageCount: number;
}

/** Strip HTML tags and collapse whitespace, for pattern matching. */
export function plainText(content: string): string {
  return content
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** A message is one of Meroki's own announcements (alias "Meroki"). */
function isMerokiMessage(m: ChatMessage): boolean {
  return m.speaker?.alias === "Meroki";
}

const DOWN_RE = /^(.+?)\s+(?:is down|dies|is defeated|falls)\b/i;
const COMBAT_OVER_RE = /combat over/i;
const COMBAT_START_RE = /combat (?:begins|starts)|initiative/i;
const ROUND_RE = /round\s+(\d+)/i;
const LOOT_RE = /\b(\d+)\s*(gp|gold|pp|sp|cp)\b|chest|loot|potion/i;
const NAT20_RE = /natural 20/i;
const NAT1_RE = /natural 1/i;
const ROOM_RE = /^🏰\s*\*\*(.+?)\*\*/;

/**
 * Build a recap from a chat log (oldest first). Only reports what the log
 * contains — see the module header.
 */
export function buildRecap(
  messages: ChatMessage[],
  opts: { title?: string; date?: string } = {},
): Recap {
  const kills: RecapEvent[] = [];
  const loot: RecapEvent[] = [];
  const combat: RecapEvent[] = [];
  const notableRolls: RecapEvent[] = [];
  const rooms: RecapEvent[] = [];
  let roundsSeen = 0;

  for (const m of messages) {
    const text = plainText(m.content);
    if (!text) continue;

    // Room entries: Meroki's scene-build announcements.
    const room = ROOM_RE.exec(text);
    if (room && isMerokiMessage(m)) {
      rooms.push({ kind: "room", text: `Entered ${room[1]}.`, messageId: m.id });
      continue;
    }
    // Kills/downs: announcement lines ("X is down! (0 HP)").
    const down = DOWN_RE.exec(text);
    if (down && isMerokiMessage(m)) {
      // The announcement line may start with an emoji ("💀 **X** is down").
      const name = down[1].trim().replace(/^[^\p{L}\d]+/u, "").trim();
      kills.push({ kind: "kill", text: `${name} went down.`, messageId: m.id });
      continue;
    }
    // Combat milestones.
    if (COMBAT_OVER_RE.test(text) && isMerokiMessage(m)) {
      combat.push({ kind: "combat", text: "Combat ended.", messageId: m.id });
      continue;
    }
    if (COMBAT_START_RE.test(text) && isMerokiMessage(m)) {
      combat.push({ kind: "combat", text: "Combat began.", messageId: m.id });
      continue;
    }
    const round = ROUND_RE.exec(text);
    if (round && isMerokiMessage(m)) {
      roundsSeen = Math.max(roundsSeen, Number(round[1]));
      continue;
    }
    // Notable rolls.
    if (NAT20_RE.test(text)) {
      notableRolls.push({ kind: "roll", text: "A natural 20 was rolled.", messageId: m.id });
      continue;
    }
    if (NAT1_RE.test(text)) {
      notableRolls.push({ kind: "roll", text: "A natural 1 was rolled.", messageId: m.id });
      continue;
    }
    // Loot: any line mentioning coins, chests, or potions.
    if (LOOT_RE.test(text)) {
      loot.push({ kind: "loot", text, messageId: m.id });
      continue;
    }
  }

  if (roundsSeen > 0) {
    combat.push({
      kind: "combat",
      text: `Combat ran ${roundsSeen} round${roundsSeen === 1 ? "" : "s"}.`,
      messageId: "",
    });
  }

  const events = [...rooms, ...combat, ...kills, ...notableRolls, ...loot];
  return {
    title: opts.title ?? "Session recap",
    date: opts.date ?? new Date().toISOString().slice(0, 10),
    events,
    kills,
    loot,
    combat,
    notableRolls,
    rooms,
    messageCount: messages.length,
  };
}

/** Render a recap as plain chat text. */
export function recapToText(recap: Recap): string {
  const lines: string[] = [`📖 **${recap.title}** — ${recap.date}`];
  const section = (heading: string, items: RecapEvent[]): void => {
    if (items.length === 0) return;
    lines.push(`\n${heading}`);
    for (const e of items) lines.push(`• ${e.text}`);
  };
  section("🏰 Rooms", recap.rooms);
  section("⚔️ Combat", recap.combat);
  section("💀 Downs", recap.kills);
  section("🌟 Notable rolls", recap.notableRolls);
  section("💰 Loot", recap.loot);
  if (recap.events.length === 0) {
    lines.push(`\nNothing notable in the log — a quiet session (${recap.messageCount} messages).`);
  }
  return lines.join("\n");
}

/** Render a recap as HTML for a journal entry page. */
export function recapToJournalHtml(recap: Recap): string {
  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const section = (heading: string, items: RecapEvent[]): string => {
    if (items.length === 0) return "";
    const lis = items.map((e) => `<li>${esc(e.text)}</li>`).join("");
    return `<h2>${heading}</h2><ul>${lis}</ul>`;
  };
  return (
    `<h1>${esc(recap.title)}</h1><p><em>${esc(recap.date)} — built from ${recap.messageCount} chat messages.</em></p>` +
    section("Rooms", recap.rooms) +
    section("Combat", recap.combat) +
    section("Downs", recap.kills) +
    section("Notable rolls", recap.notableRolls) +
    section("Loot", recap.loot) +
    (recap.events.length === 0 ? `<p>Nothing notable in the log — a quiet session.</p>` : "")
  );
}

// ---------------------------------------------------------------- live layer

/**
 * Read the recent chat log, build the recap, create a journal entry for
 * it, and post a summary to chat. Returns the recap and the journal _id.
 */
export async function postRecap(
  live: FoundryLive,
  opts: { title?: string; limit?: number; date?: string } = {},
): Promise<{ recap: Recap; journalId: string; messageId: string }> {
  const messages = live.getChatMessages(opts.limit ?? 200);
  const recap = buildRecap(messages, { title: opts.title, date: opts.date });
  const raw = live.raw() as unknown as {
    createJournalEntry(
      name: string,
      pages: { name: string; content: string }[],
    ): Promise<{ _id: string }>;
  };
  const journal = await raw.createJournalEntry(recap.title, [
    { name: "Recap", content: recapToJournalHtml(recap) },
  ]);
  const messageId = await live.sendChat(recapToText(recap));
  return { recap, journalId: journal._id, messageId };
}
