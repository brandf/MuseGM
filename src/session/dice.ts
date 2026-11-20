/**
 * Dice on demand (P1.5) — rolls requested in chat, secret GM rolls, and
 * group checks for the whole party.
 *
 * Two layers, kept separate on purpose:
 * - Pure functions (parseRollRequest / formatRollResult /
 *   formatGroupCheckResult / firstDieResult): no Foundry, no I/O, unit
 *   tested in tests/dice.test.ts. The monitor loop calls parseRollRequest
 *   on every new chat message; a non-null return means "this is a roll
 *   request, handle it" — it never has to guess from free text.
 * - Live functions (rollForChat / secretRoll / groupCheck / postVisibleRoll):
 *   thin wrappers over FoundryLive.rollDice + sendChat.
 *
 * Roll grammar: the local roller (vendored MCP, evaluateDiceFormula)
 * accepts `sign? term (sign term)*` where a term is `NdS` / `dS` / a
 * constant, joined by + or -. No parentheses, no kh/reroll modifiers.
 * The parser here only EXTRACTS the formula from chat text; the roller
 * itself validates it, and a roller error is reported to chat verbatim —
 * a formula is never silently re-interpreted.
 *
 * Visible rolls: /tmp/post-roll.mjs (the monitor's visible-roll helper)
 * was lost when /tmp was cleared — postVisibleRoll below is the
 * reconstruction from rollDice + sendChat. It posts the result as a chat
 * message; that IS the visible roll in this setup. A native Foundry roll
 * card (a ChatMessage `rolls` payload with dice animation) is not
 * reachable from the local roller: it returns totals and a breakdown
 * string, not per-die results, so there is nothing to serialize into a
 * Roll document. If the REST dice transport is ever used, its per-term
 * results could feed a real roll card — that's a future item, not this one.
 */
import type { FoundryLive } from "../live.js";
import type { DiceRollResult } from "../types.js";

/** A roll request parsed out of a chat message. */
export interface RollRequest {
  /** Dice formula as written, e.g. "1d20+5". */
  formula: string;
  /** Check / action name, e.g. "Perception". */
  flavor?: string;
  /** Character the roll is for ("for Ezren"). Display only. */
  actorName?: string;
  /** Roll in secret: result goes to the GM only, never public. */
  secret: boolean;
  /** Roll once per player character and summarize. */
  group: boolean;
  /** The original message text. */
  raw: string;
}

/** One rolled result, for formatting. */
export interface RollOutcome {
  formula: string;
  total: number;
  breakdown: string;
}

/** One member's result in a group check. */
export interface GroupCheckEntry {
  name: string;
  total: number;
  breakdown: string;
}

const SECRET_WORDS = ["secret", "secretly", "blind", "hidden", "gm"];
const GROUP_WORDS = ["group", "everyone", "party"];

/** A token that could be part of a dice formula: a dice term, a constant, or a bare +/-. */
const FORMULA_TOKEN = /^(?:[+-]?\d*d\d+|[+-]?\d+|[+-])$/i;
/** A token that contains a die (as opposed to a bare constant). */
const DICE_TOKEN = /\d*d\d+/i;
/** The first dice term of a formula, e.g. "1d20" in "1d20+5". */
const FIRST_DIE_TERM = /^\s*[+-]?\s*(?:(\d*)d(\d+))/i;

/**
 * Parse a chat message into a roll request, or null when it isn't one.
 *
 * Accepted shapes (case-insensitive, leading "/" allowed):
 *   "roll 1d20+5" / "/roll 1d20" / "1d20+5" (bare formula)
 *   "roll 2d6 fireball" / "roll 1d20+5 for Ezren"
 *   "secret roll 1d20+3" / "roll secretly 1d20" / "gm roll 1d20"
 *   "group check 1d20+2 perception" / "everyone roll 1d20" / "party roll 1d20+3"
 * The formula is the first run of formula-shaped tokens after "roll" /
 * "check" (or at the start for a bare formula). Everything after it is
 * flavor, with a leading "for <Name>" pulled out as the actor.
 */
export function parseRollRequest(text: string): RollRequest | null {
  const raw = text;
  let s = text.trim().replace(/^\/+/, "").trim();
  if (!s) return null;
  const lower = s.toLowerCase();

  // The request must contain "roll" or "check", or BE a bare formula.
  const hasRollWord = /\broll\b/.test(lower) || /\bcheck\b/.test(lower);
  const tokens = s.split(/\s+/);

  // Find where the formula starts: first token that looks like a dice term,
  // at the start (bare formula) or after the roll/check word.
  let formulaStart = -1;
  if (hasRollWord) {
    const wordIdx = tokens.findIndex(
      (t) => /^(roll|rolls|rolling|check|checks)$/i.test(t.replace(/[^a-z]/gi, "")),
    );
    if (wordIdx === -1) return null;
    for (let i = wordIdx + 1; i < tokens.length; i++) {
      if (DICE_TOKEN.test(tokens[i])) {
        formulaStart = i;
        break;
      }
      // A word between "roll" and the formula is only allowed if it is a
      // group/secret marker or "for" — anything else means this isn't a
      // roll request ("roll the barrel down the hill" must not roll dice).
      const w = tokens[i].toLowerCase().replace(/[^a-z]/g, "");
      if (
        !SECRET_WORDS.includes(w) &&
        !GROUP_WORDS.includes(w) &&
        w !== "for" &&
        w !== "a" &&
        w !== "an" &&
        w !== "the"
      ) {
        return null;
      }
    }
    if (formulaStart === -1) return null;
  } else {
    // Bare formula: the message must START with a dice term.
    if (!DICE_TOKEN.test(tokens[0])) return null;
    formulaStart = 0;
  }

  // Extend the formula over following formula-shaped tokens ("1d20 + 5").
  // Trailing chat punctuation ("1d20+5!") is stripped from formula tokens.
  let formulaEnd = formulaStart;
  const clean = (t: string): string => t.replace(/[.,!?;:]+$/, "");
  const formulaTokens: string[] = [clean(tokens[formulaStart])];
  for (let i = formulaStart + 1; i < tokens.length; i++) {
    if (FORMULA_TOKEN.test(clean(tokens[i]))) {
      formulaTokens.push(clean(tokens[i]));
      formulaEnd = i;
    } else {
      break;
    }
  }
  const formula = formulaTokens.join(" ").replace(/\s+/g, "");
  if (!DICE_TOKEN.test(formula)) return null;

  const head = tokens.slice(0, formulaStart).join(" ").toLowerCase();
  const tail = tokens.slice(formulaEnd + 1).join(" ").trim();
  const secret =
    SECRET_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(head)) ||
    /\bsecretly\b/.test(head);
  const group = GROUP_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(head));

  // Flavor: everything after the formula; a leading "for <Name>" is the actor.
  let flavor: string | undefined;
  let actorName: string | undefined;
  let rest = tail.replace(/^[:\-–—]\s*/, "");
  const forMatch = /^for\s+(\S+)\s*(.*)$/i.exec(rest);
  if (forMatch) {
    actorName = forMatch[1].replace(/[.,!?]+$/, "");
    rest = forMatch[2].trim().replace(/^[:\-–—]\s*/, "");
  }
  if (rest) flavor = rest;

  return { formula, flavor, actorName, secret, group, raw };
}

/**
 * First die result of a roll, from its breakdown string — the local roller
 * renders "1d20: [17] + 5 = 22", the server roller "17 + 5". Only used for
 * the natural-20 / natural-1 callout, which is display-only.
 */
export function firstDieResult(breakdown: string): number | null {
  const bracket = /\[(\d+)/.exec(breakdown);
  if (bracket) return Number(bracket[1]);
  // Server form: "17 + 5" or "3, 5 + 5" — the first number is a die result
  // only when more terms follow; a bare "5" is a constant, not a die.
  const plain = /^\s*(\d+)\s*[,+]/.exec(breakdown);
  return plain ? Number(plain[1]) : null;
}

/** True when the formula's first (and only deciding) die is a single d20. */
function isSingleD20(formula: string): boolean {
  const m = FIRST_DIE_TERM.exec(formula);
  if (!m) return false;
  const count = m[1] === "" || m[1] === undefined ? 1 : Number(m[1]);
  return count === 1 && Number(m[2]) === 20;
}

/** Drop the local roller's trailing " = <total>" so it isn't printed twice. */
function stripTotalSuffix(breakdown: string, total: number): string {
  return breakdown.replace(new RegExp(`\\s*=\\s*${total}\\s*$`), "");
}

/**
 * Chat text for one roll result. Includes a natural-20 / natural-1 callout
 * when the roll is a single d20.
 */
export function formatRollResult(
  result: RollOutcome,
  opts: { flavor?: string; actorName?: string } = {},
): string {
  const who = opts.actorName ? `**${opts.actorName}** rolls ` : "";
  const what = opts.flavor ? `${opts.flavor}: ` : "";
  const breakdown = stripTotalSuffix(result.breakdown, result.total);
  let text = `🎲 ${who}${what}${result.formula} = **${result.total}** (${breakdown})`;
  if (isSingleD20(result.formula)) {
    const first = firstDieResult(result.breakdown);
    if (first === 20) text += ` — 🌟 **Natural 20!**`;
    else if (first === 1) text += ` — 💥 **Natural 1!**`;
  }
  return text;
}

/** Chat text summarizing a group check, best roll first. */
export function formatGroupCheckResult(
  entries: GroupCheckEntry[],
  flavor?: string,
): string {
  const what = flavor ? ` — ${flavor}` : "";
  if (entries.length === 0) return `🎲 Group check${what}: no player characters found.`;
  const sorted = [...entries].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const lines = sorted.map((e) => {
    const d20 = firstDieResult(e.breakdown);
    const mark = d20 === 20 ? " 🌟" : d20 === 1 ? " 💥" : "";
    return `• **${e.name}**: ${e.total}${mark}`;
  });
  const best = sorted[0];
  return (
    `🎲 **Group check${what}** — ${entries.length} rolls, best: **${best.name}** (${best.total})\n` +
    lines.join("\n")
  );
}

// ---------------------------------------------------------------- live layer

/** Foundry user roles: 4 is GAMEMASTER. */
const ROLE_GAMEMASTER = 4;

/** The GM's user _id: role 4, falling back to a user named "Gamemaster". */
export function resolveGamemasterId(live: FoundryLive): string {
  const users = live.getUsers();
  const gm = users.find((u) => u.role === ROLE_GAMEMASTER);
  if (gm) return gm._id;
  const named = users.find((u) => u.name.toLowerCase() === "gamemaster");
  if (named) return named._id;
  throw new Error("No gamemaster user found (no role-4 user, no user named Gamemaster).");
}

/** Player characters: actors of type "character". */
export async function listPlayerCharacters(
  live: FoundryLive,
): Promise<{ id: string; name: string }[]> {
  const res = (await live.searchActors("", { type: "character", limit: 100 })) as {
    actors?: { _id?: string; id?: string; name?: string; type?: string }[];
  };
  const actors = res.actors ?? [];
  return actors
    .filter((a) => (a.type ?? "character") === "character")
    .map((a) => ({ id: String(a._id ?? a.id ?? ""), name: String(a.name ?? "") }))
    .filter((a) => a.id && a.name);
}

/**
 * Post a roll result to chat as a visible message — the reconstructed
 * visible-roll helper (see the module header: /tmp/post-roll.mjs was lost).
 * This is what the monitor calls after rolling: the message IS the roll
 * the table sees, since the local roller has no native roll card.
 */
export async function postVisibleRoll(
  live: FoundryLive,
  result: DiceRollResult,
  opts: { flavor?: string; actorName?: string } = {},
): Promise<string> {
  const text = formatRollResult(result, opts);
  return live.sendChat(text);
}

/**
 * Handle one chat message as a possible roll request. Returns the posted
 * message _id, or null when the message isn't a roll request. A bad formula
 * is reported in chat (the roller's own error) and returns null — the
 * requester sees what went wrong instead of silence.
 */
export async function rollForChat(
  live: FoundryLive,
  text: string,
): Promise<string | null> {
  const req = parseRollRequest(text);
  if (!req) return null;
  if (req.group) {
    const { messageId } = await groupCheck(live, req.formula, { flavor: req.flavor });
    return messageId;
  }
  if (req.secret) {
    const { publicMessageId } = await secretRoll(live, req.formula, {
      flavor: req.flavor,
      actorName: req.actorName,
    });
    return publicMessageId;
  }
  let result: DiceRollResult;
  try {
    result = await live.rollDice(req.formula, { flavor: req.flavor });
  } catch (err) {
    await live.sendChat(`🎲 Couldn't roll \`${req.formula}\`: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  return postVisibleRoll(live, result, { flavor: req.flavor, actorName: req.actorName });
}

/**
 * A secret GM roll: the result is whispered to the GM only. Chat gets a
 * single "rolls behind the screen" line with no result, so the requester
 * knows the roll happened.
 */
export async function secretRoll(
  live: FoundryLive,
  formula: string,
  opts: { flavor?: string; actorName?: string } = {},
): Promise<{ gmMessageId: string; publicMessageId: string; total: number }> {
  const gmId = resolveGamemasterId(live);
  const result = await live.rollDice(formula, { flavor: opts.flavor });
  const text = `🤫 ${formatRollResult(result, opts)} (secret — GM only)`;
  const gmMessageId = await live.sendChat(text, { whisperTo: [gmId] });
  const publicMessageId = await live.sendChat(
    `🤫 Meroki rolls behind the screen${opts.flavor ? ` (${opts.flavor})` : ""}…`,
  );
  return { gmMessageId, publicMessageId, total: result.total };
}

/**
 * A group check: roll the same formula once per player character (each PC
 * gets their own random result) and post a summary, best first.
 */
export async function groupCheck(
  live: FoundryLive,
  formula: string,
  opts: { flavor?: string; actorIds?: string[] } = {},
): Promise<{ messageId: string; entries: GroupCheckEntry[] }> {
  const pcs = opts.actorIds
    ? opts.actorIds.map((id) => ({ id, name: id }))
    : await listPlayerCharacters(live);
  const entries: GroupCheckEntry[] = [];
  for (const pc of pcs) {
    const result = await live.rollDice(formula, { flavor: opts.flavor });
    entries.push({ name: pc.name, total: result.total, breakdown: result.breakdown });
  }
  const messageId = await live.sendChat(formatGroupCheckResult(entries, opts.flavor));
  return { messageId, entries };
}
