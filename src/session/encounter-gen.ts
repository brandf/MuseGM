/**
 * Rapid custom encounter generation (FR-11) — story-aware NPCs, built in
 * seconds from one sentence instead of hours by hand.
 *
 * Two layers, kept separate on purpose (same pattern as src/session/dice.ts
 * and src/session/loot.ts):
 * - Pure functions (templates / gear / spells / backstories / formations /
 *   generateEncounter): no Foundry, no I/O, unit tested in
 *   tests/encounter-gen.test.ts. Deterministic for a given spec + seed, so
 *   a table can re-roll the same encounter.
 * - Live functions (createCustomActors / createCustomEncounter): thin
 *   wrappers over FoundryLive.modifyDocument — Actor create, then Item
 *   creates with `parentUuid: Actor.<id>` (the proven compendium-import
 *   pattern), then the P1 encounter builder for tokens + combat.
 *
 * HOUSE TABLES — everything below (role stats, weapons, spells, loot) is a
 * house table chosen for speed and fiction fit. It is NOT the PF2e
 * rulebook — do not present it as one. Spell and weapon entries use real
 * PF2e names as picks; the numbers are house numbers. For full compendium
 * data, import the real item (see src/session/compendium.ts).
 *
 * TWO RULES THAT MAKE IT FEEL REAL (Brandon, Nov 19):
 * 1. Every NPC gets a LIVING KIT, not just weapons: rations, waterskin,
 *    bedroll, rope, torches, whetstone, plus one personal item (a letter
 *    from home, etc.). A guard is never just "a dagger and a rapier and
 *    nothing else" — the kit is how players learn who the person was
 *    after the fight.
 * 2. Every NPC gets ONE UNIQUE SIGNATURE ITEM that drops on death — a
 *    named item with a one-line story, never the same generic weapon
 *    list twice. The loot IS characterization.
 *
 * HONESTY RULE (backstories): a backstory is built ONLY from (a) the
 * Muse-authored one-liner in the spec, (b) verbatim facts/people from
 * the story context it was given, and (c) generic role text that
 * contains no proper nouns at all. It never invents plot facts. With no
 * context it is explicitly labeled generic.
 *
 * FORMATIONS: the ring/line/wedge helpers here are local and small. The
 * cutscene builder (FR-5) is writing formation helpers of its own in
 * src/session/cutscene.ts — when it lands, these two should merge into
 * one shared module. Do not "fix" the duplication by importing a file
 * that does not exist yet.
 */
import type { FoundryLive } from "../live.js";
import { rngFromSeed } from "./loot.js";
import { buildEncounter } from "./encounter.js";
import { moveTokenTo } from "./movement.js";

// ---------------------------------------------------------------- types

/** NPC roles the generator knows. */
export type NpcRole = "guard" | "mage" | "priest" | "rogue" | "brute" | "leader";

/** Themes filter gear and spells (a lich's honor guard gets death-flavored picks, not random loot). */
export type EncounterTheme =
  | "death"
  | "nature"
  | "holy"
  | "fire"
  | "shadow"
  | "arcane"
  | "generic";

/** Story context the generator may draw on. It is DATA, not prose: the
 * generator quotes facts/people verbatim and invents nothing beyond them. */
export interface StoryContext {
  /** Campaign name, e.g. "Menace Under Otari". Used for flavor only. */
  campaign?: string;
  /** Where this is happening, e.g. "the Lich's Lair". Used for flavor only. */
  location?: string;
  /** Plot facts from recaps/journals, as plain strings. The ONLY plot facts the generator may use. */
  facts?: string[];
  /** Named people/factions from the story. The ONLY proper nouns (besides NPC names) the generator may use. */
  people?: string[];
}

/** One NPC as Muse authors it: the creative calls only. */
export interface NpcSpec {
  name: string;
  role: NpcRole;
  /** One-line backstory seed from Muse, e.g. "swore an oath to the lich after the fall of Otari". */
  oneLiner?: string;
  /** Muse-authored signature item (name + one-line story). If omitted, code picks one. */
  signature?: { name: string; story: string };
}

/** Where the encounter stands. `center` is the anchor; `focus` is the point everyone faces (default: center). */
export interface FormationSpec {
  type: "ring" | "line" | "wedge";
  center: { x: number; y: number };
  /** Ring radius in px. Default: 300. */
  radius?: number;
  /** Line/wedge spacing in px. Default: 100 (one grid square). */
  spacing?: number;
  focus?: { x: number; y: number };
}

/** The compact encounter spec Muse authors. */
export interface EncounterSpec {
  npcs: NpcSpec[];
  formation: FormationSpec;
  theme?: EncounterTheme;
  /** Party level the encounter is scaled to (1+). */
  partyLevel: number;
  story: StoryContext;
  /** Seed for deterministic generation. Default: random. */
  seed?: number;
}

/** One generated item (weapon, gear, spell, or signature). */
export interface GenItem {
  name: string;
  /** "weapon" | "equipment" | "spell" | "consumable". */
  type: string;
  /** PF2e-ish system payload (house-shaped; see actorDocFor). */
  system: Record<string, unknown>;
  /** One-line story (signature items and personal items always have one). */
  story?: string;
  /** True only for the one signature item. */
  signature?: boolean;
  /** True for the signature item: it drops on death. */
  dropsOnDeath?: boolean;
}

/** One fully generated NPC. */
export interface GeneratedNpc {
  name: string;
  role: NpcRole;
  level: number;
  hp: number;
  hpMax: number;
  ac: number;
  perception: number;
  attackBonus: number;
  /** Weapon damage, e.g. "1d8+2 slashing". */
  damage: string;
  saves: { fortitude: number; reflex: number; will: number };
  abilities: { str: number; dex: number; con: number; int: number; wis: number; cha: number };
  /** Role weapons (theme-flavored). */
  weapons: GenItem[];
  /** The living kit: rations, waterskin, bedroll, rope, torches, whetstone + one personal item. */
  livingKit: GenItem[];
  /** Theme-filtered spells (mages and priests only; others get none). */
  spells: GenItem[];
  /** Exactly one signature item, unique within the encounter, drops on death. */
  signature: GenItem;
  /** 2–3 sentences, built only from the spec + story context (see header). */
  backstory: string;
  /** Personality hook, e.g. "Steady, patient, and hard to surprise." */
  personality: string;
  /** True when there was no story context to draw on — the backstory is generic and says so. */
  generic: boolean;
}

/** One token placement in the formation. */
export interface Placement {
  name: string;
  x: number;
  y: number;
  /** Facing in degrees, 0 = east, increasing clockwise in screen coordinates (y down). Convention to verify live. */
  facing: number;
}

/** A fully generated encounter (pure data — no Foundry involved). */
export interface GeneratedEncounter {
  npcs: GeneratedNpc[];
  placements: Placement[];
  theme: EncounterTheme;
  partyLevel: number;
  /** One-line chat summary. */
  summary: string;
}

// ---------------------------------------------------------------- role templates (house table)

/** Base stats at level 1 + per-level growth. All numbers are house numbers. */
interface RoleTemplate {
  hpBase: number;
  hpPerLevel: number;
  acBase: number;
  attackBase: number;
  perceptionBase: number;
  savesBase: { fortitude: number; reflex: number; will: number };
  abilities: { str: number; dex: number; con: number; int: number; wis: number; cha: number };
  /** Weapon pool: [name, damage dice, damage type]. */
  weapons: [string, string, string][];
  /** Whether this role gets spells (mages and priests only). */
  castsSpells: boolean;
  /** Role label used in backstories. */
  label: string;
  /** Personality hooks (no proper nouns). */
  hooks: string[];
}

const ROLE_TEMPLATES: Record<NpcRole, RoleTemplate> = {
  guard: {
    hpBase: 12, hpPerLevel: 9, acBase: 16, attackBase: 5, perceptionBase: 1,
    savesBase: { fortitude: 4, reflex: 1, will: 1 },
    abilities: { str: 2, dex: 1, con: 2, int: 0, wis: 1, cha: 0 },
    weapons: [["Longsword", "1d8", "slashing"], ["Spear", "1d6", "piercing"], ["Warhammer", "1d8", "bludgeoning"]],
    castsSpells: false, label: "guard",
    hooks: ["Steady, patient, and hard to surprise.", "Stands the watch like the wall itself.", "Counts heads twice and trusts no silence."],
  },
  mage: {
    hpBase: 6, hpPerLevel: 5, acBase: 13, attackBase: 3, perceptionBase: 2,
    savesBase: { fortitude: 0, reflex: 2, will: 4 },
    abilities: { str: 0, dex: 1, con: 0, int: 3, wis: 1, cha: 1 },
    weapons: [["Staff", "1d4", "bludgeoning"], ["Dagger", "1d4", "piercing"]],
    castsSpells: true, label: "mage",
    hooks: ["Curious to a fault — asks questions first, casts second.", "Mutters the words under their breath even when not casting.", "Keeps their spellbook closer than their coin."],
  },
  priest: {
    hpBase: 8, hpPerLevel: 7, acBase: 15, attackBase: 4, perceptionBase: 2,
    savesBase: { fortitude: 3, reflex: 1, will: 4 },
    abilities: { str: 1, dex: 0, con: 1, int: 0, wis: 3, cha: 1 },
    weapons: [["Mace", "1d6", "bludgeoning"], ["Warhammer", "1d8", "bludgeoning"]],
    castsSpells: true, label: "priest",
    hooks: ["Gentle with the living, implacable with the dead.", "Prays before a fight and counts the dead after.", "Carries the rites in their head and the dead in their heart."],
  },
  rogue: {
    hpBase: 8, hpPerLevel: 6, acBase: 15, attackBase: 5, perceptionBase: 3,
    savesBase: { fortitude: 1, reflex: 4, will: 2 },
    abilities: { str: 0, dex: 3, con: 1, int: 1, wis: 1, cha: 1 },
    weapons: [["Shortsword", "1d6", "piercing"], ["Dagger", "1d4", "piercing"], ["Shortbow", "1d6", "piercing"]],
    castsSpells: false, label: "rogue",
    hooks: ["Quick with a joke and quicker with a knife.", "Never stands where the light falls.", "Knows every exit in a room before saying hello."],
  },
  brute: {
    hpBase: 14, hpPerLevel: 11, acBase: 14, attackBase: 6, perceptionBase: 0,
    savesBase: { fortitude: 5, reflex: 0, will: 0 },
    abilities: { str: 3, dex: 0, con: 3, int: -1, wis: 0, cha: 0 },
    weapons: [["Greataxe", "1d12", "slashing"], ["Maul", "1d12", "bludgeoning"], ["Club", "1d6", "bludgeoning"]],
    castsSpells: false, label: "brute",
    hooks: ["Lets their weapon do the talking.", "Laughs loud and hits harder.", "Has never once run from a fight."],
  },
  leader: {
    hpBase: 10, hpPerLevel: 8, acBase: 17, attackBase: 5, perceptionBase: 2,
    savesBase: { fortitude: 3, reflex: 2, will: 3 },
    abilities: { str: 2, dex: 1, con: 1, int: 1, wis: 1, cha: 2 },
    weapons: [["Longsword", "1d8", "slashing"], ["Battle axe", "1d8", "slashing"]],
    castsSpells: false, label: "commander",
    hooks: ["Carries themself like someone used to being obeyed.", "Gives orders like they expect them followed — because they are.", "Watches the whole fight, not just their own foe."],
  },
};

export const NPC_ROLES: NpcRole[] = ["guard", "mage", "priest", "rogue", "brute", "leader"];

/** Scale a role template to a level. Deterministic. */
export function scaleStats(role: NpcRole, level: number): {
  hp: number; ac: number; attackBonus: number; perception: number;
  saves: { fortitude: number; reflex: number; will: number };
  abilities: { str: number; dex: number; con: number; int: number; wis: number; cha: number };
} {
  const t = ROLE_TEMPLATES[role];
  const l = Math.max(1, Math.floor(level)) - 1;
  const bump = Math.floor(l / 2);
  return {
    hp: t.hpBase + t.hpPerLevel * l,
    ac: t.acBase + Math.floor(l / 3),
    attackBonus: t.attackBase + l,
    perception: t.perceptionBase + bump,
    saves: {
      fortitude: t.savesBase.fortitude + bump,
      reflex: t.savesBase.reflex + bump,
      will: t.savesBase.will + bump,
    },
    abilities: { ...t.abilities },
  };
}

// ---------------------------------------------------------------- spells (house picks, real PF2e names)

const SPELL_TABLE: Record<EncounterTheme, string[]> = {
  death: ["Chill Touch", "Grim Tendrils", "Harm", "Vampiric Feast", "Enervation", "Animate Dead", "Death Knell", "Spectral Hand"],
  nature: ["Tanglefoot", "Heal", "Entangle", "Summon Animal", "Barkskin", "Lightning Bolt", "Gust of Wind"],
  holy: ["Heal", "Bless", "Divine Lance", "Sanctuary", "Searing Light", "Heroism", "Restoration"],
  fire: ["Ignition", "Burning Hands", "Fireball", "Scorching Ray", "Flaming Sphere", "Fire Shield"],
  shadow: ["Daze", "Illusory Disguise", "Invisibility", "Shadow Blast", "Darkness", "Paralyze"],
  arcane: ["Magic Missile", "Shield", "Force Barrage", "Telekinetic Projectile", "Acid Grip", "Haste"],
  generic: ["Magic Missile", "Heal", "Shield", "Daze", "Bless", "Ignition"],
};

/** Pick `count` spells for a role+theme, without replacement, seeded. Non-casters get none. */
export function pickSpells(role: NpcRole, theme: EncounterTheme, rng: () => number, count = 3): string[] {
  if (!ROLE_TEMPLATES[role].castsSpells) return [];
  const pool = [...SPELL_TABLE[theme]];
  const picked: string[] = [];
  while (picked.length < count && pool.length > 0) {
    picked.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }
  return picked;
}

/** Weapon flavor prefix by theme (the lich's guard carries grave-touched steel, not plain steel). */
function weaponFlavor(theme: EncounterTheme): string {
  switch (theme) {
    case "death": return "grave-touched ";
    case "nature": return "bark-bound ";
    case "holy": return "blessed ";
    case "fire": return "ember-forged ";
    case "shadow": return "gloom-darkened ";
    case "arcane": return "rune-etched ";
    default: return "";
  }
}

/** Pick a role weapon, theme-flavored, seeded. */
export function pickWeapon(role: NpcRole, theme: EncounterTheme, rng: () => number): { name: string; damage: string; damageType: string } {
  const pool = ROLE_TEMPLATES[role].weapons;
  const [name, dice, damageType] = pool[Math.floor(rng() * pool.length)];
  return { name: `${weaponFlavor(theme)}${name}`, damage: dice, damageType };
}

// ---------------------------------------------------------------- living kit (every NPC, always)

/** Personal items: one per NPC, seeded. Notes are personal (about the NPC), never plot — they contain no proper nouns. */
const PERSONAL_ITEMS: { name: string; note: string }[] = [
  { name: "A letter from home, half-finished", note: "The last line trails off mid-sentence. It was never sent." },
  { name: "A carved wooden figure of a dog", note: "Worn smooth from years in a pocket." },
  { name: "A lucky copper coin, bent", note: "Flipped before every fight. It has never once landed on edge." },
  { name: "A locket with a painted portrait", note: "The paint is fading. The face is not forgotten." },
  { name: "Worn prayer beads", note: "Counted every night, whatever the day held." },
  { name: "A child's drawing, creased from folding", note: "A house, a sun, and a figure with a sword." },
  { name: "A pressed flower in a tin", note: "Kept flat and dry. It still smells faintly of summer." },
  { name: "A broken arrowhead, kept for luck", note: "The arrow that missed. Carried ever since." },
  { name: "A set of bone dice", note: "Loaded, probably. Nobody has ever proven it." },
  { name: "A small wooden flute", note: "Three notes only, played the same way every time." },
  { name: "A ribbon from a festival", note: "The color has faded. The day has not." },
  { name: "A smooth river stone", note: "Picked up on the march and never put down." },
];

/**
 * The living kit: the stuff that keeps a person alive, on every NPC.
 * Kit items are characterization, not loot — price 0, so the encounter's
 * loot value is the signature item, not the bedroll.
 */
export function livingKit(rng: () => number): GenItem[] {
  const kit: GenItem[] = [
    { name: "Rations (1 day)", type: "equipment", system: { quantity: 1, price: { value: 0, denomination: "gp" } } },
    { name: "Waterskin", type: "equipment", system: { quantity: 1, price: { value: 0, denomination: "gp" } } },
    { name: "Bedroll", type: "equipment", system: { quantity: 1, price: { value: 0, denomination: "gp" } } },
    { name: "Rope (50 ft.)", type: "equipment", system: { quantity: 1, price: { value: 0, denomination: "gp" } } },
    { name: "Torches (2)", type: "equipment", system: { quantity: 2, price: { value: 0, denomination: "gp" } } },
    { name: "Whetstone", type: "equipment", system: { quantity: 1, price: { value: 0, denomination: "gp" } } },
  ];
  const personal = PERSONAL_ITEMS[Math.floor(rng() * PERSONAL_ITEMS.length)];
  kit.push({
    name: personal.name,
    type: "equipment",
    system: { quantity: 1, price: { value: 0, denomination: "gp" } },
    story: personal.note,
  });
  return kit;
}

// ---------------------------------------------------------------- signature items (one per NPC, unique in the encounter)

/** Signature pool entry. `{name}` is filled with the NPC's name at generation time. */
interface SignatureEntry {
  name: string;
  story: string;
  /** Themes this entry fits. Entries with no `themes` fit any theme; themed entries are preferred when the theme matches. */
  themes?: EncounterTheme[];
}

const SIGNATURE_POOLS: Record<NpcRole, SignatureEntry[]> = {
  guard: [
    { name: "The Oath-Etched Blade", story: "{name} swore their oath on this blade, and the words are still readable in the notches along its edge.", themes: ["death", "holy"] },
    { name: "A Dented Shield, Painted Sigil", story: "The paint is chipped but the sigil is repainted after every battle. {name} would rather lose the shield than the mark." },
    { name: "The Captain's War Horn", story: "One blast and every guard in earshot stands to attention. {name} has never blown it in retreat." },
  ],
  mage: [
    { name: "A Cracked Focus That Still Hums", story: "The crack runs the whole length of the crystal, and it hums when {name} is angry. Nobody knows why it never broke.", themes: ["death", "arcane", "shadow"] },
    { name: "A Spellbook Bound in Another's Skin", story: "The binding is old and the handwriting inside is not {name}'s. They have never explained whose it was.", themes: ["death", "shadow"] },
    { name: "A Ring That Whispers Counts", story: "It counts {name}'s heartbeats aloud in the dark. The count has never once been wrong." },
  ],
  priest: [
    { name: "A Reliquary of Small Bones", story: "Each bone inside is named, and {name} can say all the names from memory. The last one is still warm.", themes: ["death", "holy"] },
    { name: "A Chipped Holy Symbol", story: "Chipped the night {name} lost their faith and found it again in the same hour. They never had it repaired." },
    { name: "Prayer Beads of Black Glass", story: "One bead for every soul {name} has sent on. The string is getting short." },
  ],
  rogue: [
    { name: "A Lucky Dagger, Twice Stolen", story: "{name} has stolen this dagger twice and lost it three times. It always comes back. They stopped asking how." },
    { name: "A Lockpick Set in a Velvet Case", story: "Every pick is engraved with the name of a door it opened. The case is nearly full." },
    { name: "A Mask of Plain Wood", story: "No eye holes — {name} wears it anyway, and sees just fine. At least, that is what they say." },
  ],
  brute: [
    { name: "A Maul With Tally Marks", story: "Every mark is a fight {name} walked away from. The handle is almost out of room.", themes: ["death"] },
    { name: "A Belt of Giant's Teeth", story: "Each tooth is bigger than {name}'s fist. Nobody has ever asked where they came from, twice." },
    { name: "A Broken Shield Worn as a Pauldron", story: "It stopped a blow that should have killed {name}. They wear the proof on their shoulder." },
  ],
  leader: [
    { name: "A Banner Fragment, Battle-Torn", story: "{name} carried this banner out of a rout and never let it fall. The rest of the banner did not make it.", themes: ["death", "holy"] },
    { name: "A Signet Ring, Worn Smooth", story: "The seal is worn past reading, but every soldier in the company still salutes it." },
    { name: "A Commander's Horn, Silver-Plated", story: "Three notes, and the whole patrol moves as one. {name} has never once sounded it by mistake." },
  ],
};

/**
 * Pick a signature item for one NPC. `used` is the set of signature names
 * already taken in this encounter — a pick never repeats a name. If the
 * pool is exhausted for the role, a fallback name is composed from a
 * distinctive adjective (still unique via `used`).
 */
export function pickSignature(
  role: NpcRole,
  theme: EncounterTheme,
  rng: () => number,
  used: Set<string>,
  authored?: { name: string; story: string },
  npcName?: string,
): GenItem {
  if (authored) {
    return {
      name: authored.name,
      type: "weapon",
      system: {
        quantity: 1,
        price: { value: 0, denomination: "gp" },
        description: { value: `<p>${authored.story}</p>` },
      },
      story: authored.story,
      signature: true,
      dropsOnDeath: true,
    };
  }
  const pool = SIGNATURE_POOLS[role];
  const themed = pool.filter((e) => e.themes?.includes(theme));
  const generic = pool.filter((e) => !e.themes);
  const ordered = [...themed, ...generic];
  // Seeded shuffle of the preferred order, then first unused name wins.
  for (let i = ordered.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
  }
  for (const entry of ordered) {
    if (!used.has(entry.name)) {
      used.add(entry.name);
      const story = entry.story.replaceAll("{name}", npcName ?? "they");
      return {
        name: entry.name,
        type: "weapon",
        system: {
          quantity: 1,
          price: { value: 0, denomination: "gp" },
          description: { value: `<p>${story}</p>` },
        },
        story,
        signature: true,
        dropsOnDeath: true,
      };
    }
  }
  // Pool exhausted (only reachable with many same-role NPCs): compose a fallback.
  const fallbacks = ["Oathbound", "Grave-marked", "Hollow", "Widow's", "Pale", "Thrice-blooded", "Silent", "Ashen"];
  for (const adj of fallbacks) {
    const name = `The ${adj} Blade`;
    if (!used.has(name)) {
      used.add(name);
      const story = `${npcName ?? "Its bearer"} carried this blade through every fight and never named it. The name found it instead.`;
      return {
        name,
        type: "weapon",
        system: {
          quantity: 1,
          price: { value: 0, denomination: "gp" },
          description: { value: `<p>${story}</p>` },
        },
        story,
        signature: true,
        dropsOnDeath: true,
      };
    }
  }
  throw new Error(`No unique signature item left for role "${role}" — too many NPCs of one role in one encounter.`);
}

// ---------------------------------------------------------------- backstories (honesty rule)

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * Build a 2–3 sentence backstory. Sources, in order:
 * - the NPC's name and role (always),
 * - Muse's one-liner from the spec (trusted input, used verbatim),
 * - ONE verbatim fact or person from the story context (seeded pick),
 * - generic role text (no proper nouns at all).
 * With no one-liner and no usable context, the backstory is explicitly
 * generic and `generic` is true — it never invents a plot.
 */
export function buildBackstory(
  spec: NpcSpec,
  story: StoryContext,
  rng: () => number,
): { text: string; personality: string; generic: boolean } {
  const template = ROLE_TEMPLATES[spec.role];
  const personality = pick(rng, template.hooks);
  const facts = (story.facts ?? []).filter((f) => f.trim() !== "");
  const people = (story.people ?? []).filter((p) => p.trim() !== "");
  const sentences: string[] = [];
  sentences.push(`${spec.name} is a ${template.label}. ${personality}`);
  if (spec.oneLiner?.trim()) {
    sentences.push(spec.oneLiner.trim());
  }
  if (facts.length > 0) {
    const fact = pick(rng, facts);
    sentences.push(`Tied to the story: "${fact}"`);
    return { text: sentences.join(" "), personality, generic: false };
  }
  if (people.length > 0) {
    const person = pick(rng, people);
    sentences.push(`Serves ${person}.`);
    return { text: sentences.join(" "), personality, generic: false };
  }
  sentences.push("No story on record — a hireling with no known ties.");
  return { text: sentences.join(" "), personality, generic: true };
}

// ---------------------------------------------------------------- formations (local — merge with cutscene.ts helpers when they land)

/** Angle in degrees from (x, y) toward (tx, ty). 0 = east, clockwise in screen coordinates (y down). Convention to verify live. */
export function angleTo(x: number, y: number, tx: number, ty: number): number {
  return (Math.atan2(ty - y, tx - x) * 180) / Math.PI;
}

/**
 * Positions for a formation. Ring: evenly spaced around the center, all
 * facing it. Line: a row starting at the center, facing the focus.
 * Wedge: a V opening toward the focus, point at the center.
 */
export function formationPositions(formation: FormationSpec, count: number): Placement[] {
  const { center } = formation;
  const focus = formation.focus ?? center;
  const out: Placement[] = [];
  if (formation.type === "ring") {
    const radius = formation.radius ?? 300;
    for (let i = 0; i < count; i++) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / count;
      const x = Math.round(center.x + radius * Math.cos(a));
      const y = Math.round(center.y + radius * Math.sin(a));
      out.push({ name: "", x, y, facing: angleTo(x, y, center.x, center.y) });
    }
    return out;
  }
  const spacing = formation.spacing ?? 100;
  if (formation.type === "line") {
    const startX = Math.round(center.x - ((count - 1) * spacing) / 2);
    for (let i = 0; i < count; i++) {
      const x = startX + i * spacing;
      out.push({ name: "", x, y: center.y, facing: angleTo(x, center.y, focus.x, focus.y) });
    }
    return out;
  }
  // Wedge: point at the center, arms opening away from the focus.
  const dx = center.x - focus.x;
  const dy = center.y - focus.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  for (let i = 0; i < count; i++) {
    const rank = Math.ceil(i / 2);
    const side = i % 2 === 0 ? -1 : 1;
    const x = Math.round(center.x + ux * rank * spacing + px * side * rank * spacing);
    const y = Math.round(center.y + uy * rank * spacing + py * side * rank * spacing);
    out.push({ name: "", x, y, facing: angleTo(x, y, focus.x, focus.y) });
  }
  return out;
}

// ---------------------------------------------------------------- generation (pure)

/** Validate an encounter spec. Throws with a clear message on bad input. */
export function validateSpec(spec: EncounterSpec): void {
  if (!Array.isArray(spec.npcs) || spec.npcs.length === 0) {
    throw new Error("Encounter spec needs at least one NPC.");
  }
  if (spec.npcs.length > 12) {
    throw new Error(`Encounter spec has ${spec.npcs.length} NPCs — max 12 in one encounter.`);
  }
  if (!Number.isFinite(spec.partyLevel) || spec.partyLevel < 1) {
    throw new Error(`Party level must be 1 or higher (got ${spec.partyLevel}).`);
  }
  const names = new Set<string>();
  for (const npc of spec.npcs) {
    if (!npc.name?.trim()) throw new Error("Every NPC needs a name.");
    const key = npc.name.trim().toLowerCase();
    if (names.has(key)) throw new Error(`Duplicate NPC name in spec: "${npc.name}".`);
    names.add(key);
    if (!NPC_ROLES.includes(npc.role)) throw new Error(`Unknown NPC role: "${npc.role}".`);
  }
  const authored = spec.npcs
    .map((n) => n.signature?.name?.trim().toLowerCase())
    .filter((n): n is string => !!n);
  const seen = new Set<string>();
  for (const name of authored) {
    if (seen.has(name)) throw new Error(`Duplicate signature item name in spec: "${name}".`);
    seen.add(name);
  }
  if (!spec.formation || !spec.formation.center || !Number.isFinite(spec.formation.center.x) || !Number.isFinite(spec.formation.center.y)) {
    throw new Error("Encounter spec needs a formation with a numeric center {x, y}.");
  }
  if (!["ring", "line", "wedge"].includes(spec.formation.type)) {
    throw new Error(`Unknown formation type: "${spec.formation.type}".`);
  }
}

function generateOneNpc(
  spec: NpcSpec,
  level: number,
  theme: EncounterTheme,
  story: StoryContext,
  rng: () => number,
  usedSignatures: Set<string>,
): GeneratedNpc {
  const stats = scaleStats(spec.role, level);
  const weapon = pickWeapon(spec.role, theme, rng);
  const attackMod = stats.attackBonus;
  const damageBonus = spec.role === "rogue" ? stats.abilities.dex : stats.abilities.str;
  const damage = `${weapon.damage}${damageBonus >= 0 ? "+" : ""}${damageBonus} ${weapon.damageType}`;
  const weapons: GenItem[] = [
    {
      name: weapon.name,
      type: "weapon",
      system: {
        quantity: 1,
        price: { value: 0, denomination: "gp" },
        bonus: { value: attackMod },
        damageRolls: [{ damage: weapon.damage, damageType: weapon.damageType }],
        description: { value: `<p>A ${ROLE_TEMPLATES[spec.role].label}'s ${weapon.name.toLowerCase()}.</p>` },
      },
    },
  ];
  const spellNames = pickSpells(spec.role, theme, rng);
  const spells: GenItem[] = spellNames.map((name) => ({
    name,
    type: "spell",
    system: {
      description: {
        value: `<p>House spell pick (${theme}): ${name}. Full spell data should be imported from the compendium — see src/session/compendium.ts.</p>`,
      },
    },
  }));
  const signature = pickSignature(spec.role, theme, rng, usedSignatures, spec.signature, spec.name);
  const { text, personality, generic } = buildBackstory(spec, story, rng);
  return {
    name: spec.name,
    role: spec.role,
    level,
    hp: stats.hp,
    hpMax: stats.hp,
    ac: stats.ac,
    perception: stats.perception,
    attackBonus: stats.attackBonus,
    damage,
    saves: stats.saves,
    abilities: stats.abilities,
    weapons,
    livingKit: livingKit(rng),
    spells,
    signature,
    backstory: text,
    personality,
    generic,
  };
}

/**
 * Generate a full encounter from a compact spec. Deterministic for a
 * given spec + seed: same input, same NPCs, same gear, same placements.
 */
export function generateEncounter(spec: EncounterSpec): GeneratedEncounter {
  validateSpec(spec);
  const theme = spec.theme ?? "generic";
  const level = Math.max(1, Math.floor(spec.partyLevel));
  const rng = rngFromSeed(spec.seed ?? Math.floor(Math.random() * 2 ** 31));
  const usedSignatures = new Set<string>();
  const npcs = spec.npcs.map((npc) =>
    generateOneNpc(npc, level, theme, spec.story, rng, usedSignatures),
  );
  const positions = formationPositions(spec.formation, npcs.length);
  const placements: Placement[] = npcs.map((npc, i) => ({ ...positions[i], name: npc.name }));
  const summary = `⚔️ **${npcs.length} foes** (${theme}): ${npcs.map((n) => `${n.name} (${n.role})`).join(", ")} — level ${level}.`;
  return { npcs, placements, theme, partyLevel: level, summary };
}

/** Chat text for a generated encounter: names, roles, one line each, and the signature drops. */
export function formatEncounter(enc: GeneratedEncounter): string {
  const lines = enc.npcs.map(
    (n) =>
      `• **${n.name}** (${n.role}) — HP ${n.hp}, AC ${n.ac}. ${n.personality} Drops: *${n.signature.name}* — ${n.signature.story ?? ""}`,
  );
  return `${enc.summary}\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------- actor doc (house-shaped PF2e NPC)

/**
 * Build the world Actor create payload for a generated NPC.
 *
 * Minimal house-shaped PF2e NPC doc, using only field paths this codebase
 * already reads (see src/session/qa.ts): attributes.ac.value,
 * attributes.hp.value/max, attributes.perception.value,
 * details.level.value, saves.{fortitude,reflex,will}.value,
 * abilities.{str,dex,con,int,wis,cha}.mod.
 *
 * One wart, documented honestly: this codebase reads perception from TWO
 * paths — qa.ts uses attributes.perception.value, encounter.ts uses
 * perception.mod — so the doc writes both until the discrepancy is
 * resolved live. The backstory lives in flags.musegm (free-form, always
 * safe) because no biography field path has been verified in this
 * codebase yet — that is a live-test item for the next session.
 */
export function actorDocFor(npc: GeneratedNpc): Record<string, unknown> {
  return {
    name: npc.name,
    type: "npc",
    img: "icons/svg/mystery-man.svg",
    system: {
      attributes: {
        hp: { value: npc.hp, max: npc.hpMax, temp: 0 },
        ac: { value: npc.ac },
        perception: { value: npc.perception },
      },
      perception: { mod: npc.perception },
      details: { level: { value: npc.level } },
      saves: {
        fortitude: { value: npc.saves.fortitude },
        reflex: { value: npc.saves.reflex },
        will: { value: npc.saves.will },
      },
      abilities: {
        str: { mod: npc.abilities.str },
        dex: { mod: npc.abilities.dex },
        con: { mod: npc.abilities.con },
        int: { mod: npc.abilities.int },
        wis: { mod: npc.abilities.wis },
        cha: { mod: npc.abilities.cha },
      },
      traits: { size: { value: "medium" } },
    },
    prototypeToken: {
      name: npc.name,
      texture: { src: "icons/svg/mystery-man.svg" },
      disposition: -1,
      actorLink: true,
    },
    flags: {
      musegm: {
        generatedBy: "musegm-encounter-gen",
        house: true,
        role: npc.role,
        backstory: npc.backstory,
        signatureStory: npc.signature.story ?? "",
        genericBackstory: npc.generic,
      },
    },
  };
}

/** Item create payload for one generated item (weapon / gear / spell / signature). */
function itemDocFor(item: GenItem): Record<string, unknown> {
  return {
    name: item.name,
    type: item.type,
    system: { ...item.system },
  };
}

// ---------------------------------------------------------------- live layer

export interface CreatedNpc {
  name: string;
  actorId: string;
  itemIds: string[];
}

/**
 * Create world actors for every generated NPC (Actor first, then its
 * items with parentUuid — the proven compendium-import pattern).
 */
export async function createCustomActors(
  live: FoundryLive,
  enc: GeneratedEncounter,
): Promise<CreatedNpc[]> {
  const created: CreatedNpc[] = [];
  for (const npc of enc.npcs) {
    const actorDocs = await live.modifyDocument("Actor", "create", { data: [actorDocFor(npc)] });
    const actorId = String(actorDocs[0]?._id ?? "");
    if (!actorId) throw new Error(`Actor create returned no _id for "${npc.name}".`);
    const items = [...npc.weapons, ...npc.livingKit, ...npc.spells, npc.signature];
    let itemIds: string[] = [];
    if (items.length > 0) {
      const createdItems = await live.modifyDocument("Item", "create", {
        data: items.map(itemDocFor),
        parentUuid: `Actor.${actorId}`,
      });
      itemIds = createdItems.map((d) => String(d._id));
    }
    created.push({ name: npc.name, actorId, itemIds });
  }
  return created;
}

export interface CustomEncounterResult {
  encounter: GeneratedEncounter;
  combatId: string;
  tokens: { name: string; tokenId: string; x: number; y: number }[];
}

/**
 * Generate the encounter, create its actors, place the tokens in
 * formation, and start combat — via the P1 encounter builder.
 *
 * Tokens are placed by the builder in a row first, then glided to their
 * formation positions with moveTokenTo (they visibly take their places —
 * the right feel for an ambush forming up). The announcement is the
 * custom one (names, roles, signature drops), not the builder's generic
 * line.
 */
export async function createCustomEncounter(
  live: FoundryLive,
  spec: EncounterSpec,
  opts: { sceneId?: string; announce?: boolean } = {},
): Promise<CustomEncounterResult> {
  const enc = generateEncounter(spec);
  await createCustomActors(live, enc);
  const built = await buildEncounter(
    live,
    enc.npcs.map((n) => ({ name: n.name })),
    { sceneId: opts.sceneId, announce: false },
  );
  const tokens: { name: string; tokenId: string; x: number; y: number }[] = [];
  for (const placed of built.tokens) {
    const target = enc.placements.find((p) => p.name === placed.name);
    if (!target) continue;
    await moveTokenTo(live, built.sceneId, placed.tokenId, target.x, target.y, { speed: 300 });
    tokens.push({ name: placed.name, tokenId: placed.tokenId, x: target.x, y: target.y });
  }
  if (opts.announce !== false) {
    await live.sendChat(`${formatEncounter(enc)}\nInitiative order: ${built.order.join(" → ")}`);
  }
  return { encounter: enc, combatId: built.combatId, tokens };
}
