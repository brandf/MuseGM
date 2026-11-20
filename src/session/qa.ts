/**
 * Player Q&A (P2) — answer AC, HP, inventory, spells left, etc. straight
 * from actor data.
 *
 * HONESTY RULE: every value in an answer comes from the actor record.
 * When the sheet doesn't have the field, the answer says so — it never
 * invents a number, a spell, or an item. PF2e sheet layout varies by
 * version, so every reader walks the raw `system` record defensively
 * (several known paths, `undefined` when none of them exist).
 *
 * Two layers, kept separate on purpose (same pattern as src/session/dice.ts):
 * - Pure functions (parseQuestion / answerQuestion / readAc / readHp /
 *   readInventory / readSpellsLeft / findItem): no Foundry, no I/O, unit
 *   tested in tests/qa.test.ts on fixture actor data.
 * - Live function (answerForActor): reads the actor and posts the answer.
 *
 * Question shapes (case-insensitive, leading "?" allowed):
 *   "what's my ac" / "armor class" / "how much hp" / "health"
 *   "what do I have" / "inventory" / "do I have a healing potion"
 *   "spells left" / "spell slots" / "can I cast fireball"
 *   "what's my perception" / "stealth" / "my level" / "saves"
 *   "what's my strength" / "str" / ... (ability scores by name/abbrev)
 */
import type { FoundryLive } from "../live.js";

/** The minimal actor shape Q&A reads: a raw PF2e actor record. */
export interface ActorSheet {
  _id?: string;
  name: string;
  type?: string;
  system?: Record<string, unknown>;
  items?: { _id?: string; name: string; type: string; system?: Record<string, unknown> }[];
}

/** A parsed question: what kind of answer is wanted, and for what. */
export interface ParsedQuestion {
  intent:
    | "ac"
    | "hp"
    | "inventory"
    | "hasItem"
    | "spells"
    | "canCast"
    | "perception"
    | "level"
    | "saves"
    | "ability"
    | "skill";
  /** Item or spell name, for hasItem / canCast. */
  target?: string;
  /** Ability or skill name, for ability / skill. */
  stat?: string;
  raw: string;
}

const ABILITIES: Record<string, string> = {
  str: "strength",
  dex: "dexterity",
  con: "constitution",
  int: "intelligence",
  wis: "wisdom",
  cha: "charisma",
  strength: "strength",
  dexterity: "dexterity",
  constitution: "constitution",
  intelligence: "intelligence",
  wisdom: "wisdom",
  charisma: "charisma",
};

const SKILL_WORDS = [
  "acrobatics",
  "arcana",
  "athletics",
  "crafting",
  "deception",
  "diplomacy",
  "intimidation",
  "lore",
  "medicine",
  "nature",
  "occultism",
  "performance",
  "religion",
  "society",
  "stealth",
  "survival",
  "thievery",
];

/** Read a nested number from a record by a dotted path. */
function readPath(obj: unknown, path: string): number | undefined {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === "number" ? cur : undefined;
}

/** AC: PF2e keeps it at attributes.ac.value. */
export function readAc(actor: ActorSheet): number | undefined {
  return readPath(actor.system, "attributes.ac.value");
}

/** HP value/max/temp, from attributes.hp. */
export function readHp(
  actor: ActorSheet,
): { value: number; max: number; temp?: number } | undefined {
  const value = readPath(actor.system, "attributes.hp.value");
  const max = readPath(actor.system, "attributes.hp.max");
  if (value === undefined || max === undefined) return undefined;
  const temp = readPath(actor.system, "attributes.hp.temp");
  return { value, max, ...(temp !== undefined ? { temp } : {}) };
}

/** Perception modifier, from attributes.perception.value. */
export function readPerception(actor: ActorSheet): number | undefined {
  return readPath(actor.system, "attributes.perception.value");
}

/** Level, from details.level.value. */
export function readLevel(actor: ActorSheet): number | undefined {
  return readPath(actor.system, "details.level.value");
}

/** Fortitude / Reflex / Will save modifiers. */
export function readSaves(
  actor: ActorSheet,
): { fortitude?: number; reflex?: number; will?: number } {
  return {
    fortitude: readPath(actor.system, "saves.fortitude.value"),
    reflex: readPath(actor.system, "saves.reflex.value"),
    will: readPath(actor.system, "saves.will.value"),
  };
}

/** One ability score's modifier. PF2e keys abilities by abbreviation
 * (`int`), so try that first, then the full name. */
export function readAbility(actor: ActorSheet, ability: string): number | undefined {
  const key = ABILITIES[ability.toLowerCase()];
  if (!key) return undefined;
  const abbrev = Object.entries(ABILITIES).find(([, full]) => full === key)?.[0];
  return (
    (abbrev ? readPath(actor.system, `abilities.${abbrev}.mod`) : undefined) ??
    readPath(actor.system, `abilities.${key}.mod`)
  );
}

/** One skill's modifier, from skills.<name>.mod (PF2e keys are lowercase). */
export function readSkill(actor: ActorSheet, skill: string): number | undefined {
  const key = skill.toLowerCase().replace(/\s+/g, "");
  return readPath(actor.system, `skills.${key}.mod`);
}

/** Non-spell carried items, with quantities. */
export function readInventory(
  actor: ActorSheet,
): { name: string; type: string; quantity: number }[] {
  return (actor.items ?? [])
    .filter((i) => i.type !== "spell")
    .map((i) => ({
      name: i.name,
      type: i.type,
      quantity:
        typeof i.system?.quantity === "number" ? (i.system.quantity as number) : 1,
    }));
}

/** Find a carried item by (partial, case-insensitive) name. */
export function findItem(
  actor: ActorSheet,
  name: string,
): { name: string; type: string; quantity: number } | undefined {
  const needle = name.toLowerCase().trim();
  if (!needle) return undefined;
  return readInventory(actor).find((i) => i.name.toLowerCase().includes(needle));
}

/**
 * Spells left, per spellcasting entry: each rank's remaining slots.
 * PF2e slots come in two shapes — `slots.slotN.prepared` (a list of
 * prepared spell ids, length = used) with `max`, or `slots.slotN.value`
 * (remaining) with `max`. Both are read; anything else reports "unknown".
 */
export function readSpellsLeft(
  actor: ActorSheet,
): { entry: string; rank: number; remaining: number; max: number }[] {
  const entries = actor.system?.spellcasting as
    | { entries?: Record<string, { name?: string; slots?: Record<string, unknown> }> }
    | undefined;
  const out: { entry: string; rank: number; remaining: number; max: number }[] = [];
  const map = entries?.entries ?? {};
  for (const entry of Object.values(map)) {
    const slots = entry.slots ?? {};
    for (const [slotKey, slot] of Object.entries(slots)) {
      const rank = Number(slotKey.replace(/^slot/i, ""));
      if (!Number.isFinite(rank) || rank < 1) continue;
      const s = slot as Record<string, unknown>;
      const max = typeof s.max === "number" ? s.max : undefined;
      if (max === undefined) continue;
      let remaining: number | undefined;
      if (typeof s.value === "number") remaining = s.value;
      else if (Array.isArray(s.prepared)) remaining = max - s.prepared.length;
      if (remaining === undefined) continue;
      out.push({
        entry: entry.name ?? "Spells",
        rank,
        remaining: Math.max(0, remaining),
        max,
      });
    }
  }
  return out.sort((a, b) => a.rank - b.rank || a.entry.localeCompare(b.entry));
}

/** All spells the actor knows, by name (for "can I cast X"). */
export function readKnownSpells(actor: ActorSheet): string[] {
  return (actor.items ?? [])
    .filter((i) => i.type === "spell")
    .map((i) => i.name);
}

/** Parse a question into an intent, or null when it isn't a Q&A question. */
export function parseQuestion(text: string): ParsedQuestion | null {
  const raw = text;
  const s = text.trim().replace(/^[?\/]+/, "").trim().toLowerCase();
  if (!s) return null;

  if (/\b(ac|armor class|armour class)\b/.test(s)) return { intent: "ac", raw };
  if (/\b(hp|hit points|health|how hurt)\b/.test(s)) return { intent: "hp", raw };
  if (/\bperception\b/.test(s)) return { intent: "perception", raw };
  if (/\b(level|what level)\b/.test(s)) return { intent: "level", raw };
  if (/\b(saves|fortitude|reflex|will)\b/.test(s)) return { intent: "saves", raw };
  if (/\b(spell slots|spells left|how many spells)\b/.test(s)) return { intent: "spells", raw };

  const cast = /\b(?:can i cast|do i know|cast)\s+(.+?)\??$/.exec(s);
  if (cast) return { intent: "canCast", target: cast[1].trim(), raw };
  const has = /\b(?:do i have|have i got|do i carry|is there a|have we got)\s+(?:a\s+|an\s+|any\s+)?(.+?)\??$/.exec(s);
  if (has) return { intent: "hasItem", target: has[1].trim(), raw };
  if (/\b(inventory|what (?:do i|am i) (?:have|carrying)|what('s| is) (?:on me|in my (?:pack|bag)))\b/.test(s)) {
    return { intent: "inventory", raw };
  }

  for (const [key, full] of Object.entries(ABILITIES)) {
    if (new RegExp(`\\b${key}\\b`).test(s) && /\b(what|mod|modifier|score|how)\b/.test(s)) {
      return { intent: "ability", stat: full, raw };
    }
  }
  for (const skill of SKILL_WORDS) {
    if (s.includes(skill) && /\b(what|mod|modifier|how|bonus)\b/.test(s)) {
      return { intent: "skill", stat: skill, raw };
    }
  }
  return null;
}

/** Answer a parsed question from the actor record. Never invents a value. */
export function answerQuestion(actor: ActorSheet, question: string): string {
  const parsed = parseQuestion(question);
  if (!parsed) return `I don't know how to answer that — ask about AC, HP, inventory, spells, saves, or a skill.`;
  const name = actor.name;
  switch (parsed.intent) {
    case "ac": {
      const ac = readAc(actor);
      return ac === undefined
        ? `I can't find an AC on ${name}'s sheet.`
        : `**${name}** has AC ${ac}.`;
    }
    case "hp": {
      const hp = readHp(actor);
      if (!hp) return `I can't find HP on ${name}'s sheet.`;
      const temp = hp.temp ? ` (+${hp.temp} temp)` : "";
      return `**${name}** is at ${hp.value}/${hp.max} HP${temp}.`;
    }
    case "perception": {
      const p = readPerception(actor);
      return p === undefined
        ? `I can't find Perception on ${name}'s sheet.`
        : `**${name}** has Perception +${p}.`;
    }
    case "level": {
      const lvl = readLevel(actor);
      return lvl === undefined
        ? `I can't find a level on ${name}'s sheet.`
        : `**${name}** is level ${lvl}.`;
    }
    case "saves": {
      const saves = readSaves(actor);
      const parts: string[] = [];
      if (saves.fortitude !== undefined) parts.push(`Fortitude +${saves.fortitude}`);
      if (saves.reflex !== undefined) parts.push(`Reflex +${saves.reflex}`);
      if (saves.will !== undefined) parts.push(`Will +${saves.will}`);
      return parts.length === 0
        ? `I can't find saves on ${name}'s sheet.`
        : `**${name}** — ${parts.join(", ")}.`;
    }
    case "ability": {
      const mod = parsed.stat ? readAbility(actor, parsed.stat) : undefined;
      if (mod === undefined) return `I can't find ${parsed.stat ?? "that ability"} on ${name}'s sheet.`;
      const sign = mod >= 0 ? "+" : "";
      return `**${name}** has ${parsed.stat} ${sign}${mod}.`;
    }
    case "skill": {
      const mod = parsed.stat ? readSkill(actor, parsed.stat) : undefined;
      if (mod === undefined) return `I can't find ${parsed.stat ?? "that skill"} on ${name}'s sheet.`;
      const sign = mod >= 0 ? "+" : "";
      return `**${name}** has ${parsed.stat} ${sign}${mod}.`;
    }
    case "inventory": {
      const inv = readInventory(actor);
      if (inv.length === 0) return `**${name}** is carrying nothing I can see.`;
      const lines = inv.map((i) => `• ${i.name}${i.quantity > 1 ? ` ×${i.quantity}` : ""}`);
      return `**${name}** is carrying:\n${lines.join("\n")}`;
    }
    case "hasItem": {
      const found = parsed.target ? findItem(actor, parsed.target) : undefined;
      if (!found) return `No — ${name} doesn't seem to have ${parsed.target ?? "that"}.`;
      const qty = found.quantity > 1 ? ` (×${found.quantity})` : "";
      return `Yes — **${name}** has ${found.name}${qty}.`;
    }
    case "spells": {
      const slots = readSpellsLeft(actor);
      if (slots.length === 0) {
        return readKnownSpells(actor).length > 0
          ? `**${name}** knows spells, but I can't read the remaining slots from the sheet.`
          : `**${name}** has no spell slots on the sheet.`;
      }
      const lines = slots.map((s) => `• Rank ${s.rank}: ${s.remaining}/${s.max} left`);
      return `**${name}** — spell slots left:\n${lines.join("\n")}`;
    }
    case "canCast": {
      const known = readKnownSpells(actor);
      const target = parsed.target ?? "";
      const found = known.find((n) => n.toLowerCase().includes(target.toLowerCase()));
      if (!found) return `No — ${name} doesn't seem to know ${target}.`;
      const slots = readSpellsLeft(actor);
      if (slots.length === 0) return `Yes — **${name}** knows ${found} (I can't read the remaining slots).`;
      const anyLeft = slots.some((s) => s.remaining > 0);
      return anyLeft
        ? `Yes — **${name}** knows ${found} and has slots left.`
        : `**${name}** knows ${found} but has no spell slots left.`;
    }
  }
}

// ---------------------------------------------------------------- live layer

/** Answer a question about one actor, posting the answer to chat. */
export async function answerForActor(
  live: FoundryLive,
  actorId: string,
  question: string,
): Promise<{ answer: string; messageId: string }> {
  const raw = live.raw() as unknown as {
    getRawActor(id: string): ActorSheet | undefined;
  };
  const actor = raw.getRawActor(actorId);
  if (!actor) throw new Error(`Actor ${actorId} not found.`);
  const answer = answerQuestion(actor, question);
  const messageId = await live.sendChat(answer);
  return { answer, messageId };
}
