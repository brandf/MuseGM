/**
 * Value-budgeted treasure generation (FR-14) — "I want 500 gp worth of
 * treasure, and make it interesting."
 *
 * Pure functions only (no Foundry, no I/O), unit tested in
 * tests/treasure.test.ts. Same two-layer pattern as src/session/loot.ts:
 * generation is deterministic for a given (budget, level, seed, theme).
 *
 * What this is:
 * - Budget fitting: given a target value in gp, select a hoard whose total
 *   lands on the target (coins fill the small remainder, so the total is
 *   exact up to rounding) from a valued item pool. Never all coins, never
 *   one item type, never the same generic weapon twice.
 * - Stories: every item gets a provenance line (previous owner, place,
 *   quirk), unique within the hoard, drawn from fragments keyed by item
 *   kind and theme.
 * - Signature magic items: 1–2 per hoard, each with a named homebrew
 *   ability. The ability and the item's value are HOMEBREW — clearly
 *   labeled in the data and in the formatted text, never presented as a
 *   PF2e rulebook item.
 * - Artwork hook: each signature item carries `art` (null until the art
 *   generator fills it) and `artPrompt` (the prompt the art generator
 *   should use). ART CONTRACT: a later offline/async step generates one
 *   square image per signature item and writes its path/URL into `art`;
 *   artwork never blocks the treasure drop.
 *
 * HONESTY: the valued pool below is a HOUSE table (real PF2e item names
 * with house prices, gems/art/equipment by level band). It is NOT the
 * PF2e rulebook "Treasure by Level" table — do not present it as one.
 */
import { rngFromSeed, splitCoins } from "./loot.js";

/** Kinds of treasure items. */
export type TreasureKind =
  | "coins"
  | "gem"
  | "art"
  | "weapon"
  | "armor"
  | "consumable"
  | "equipment"
  | "signature";

/** One item in a generated hoard. */
export interface TreasureItem {
  /** Display name, e.g. "Topaz" or "Emberfang". */
  name: string;
  kind: TreasureKind;
  /** Value in gp (per single item, before quantity). */
  valueGp: number;
  quantity: number;
  /** Provenance line: previous owner, place, quirk. Unique in a hoard. */
  story: string;
  /** True for signature items: the ability is homebrew, not rulebook. */
  homebrew?: boolean;
  /** Signature items only: the named homebrew magic ability. */
  ability?: string;
  /**
   * Signature items only: artwork for this item. Null until the art
   * generator fills it (see the ART CONTRACT in the header). Always null
   * from this module; non-signature items don't carry the field.
   */
  art?: string | null;
  /** Signature items only: the prompt the art generator should use. */
  artPrompt?: string;
}

/** One generated hoard. */
export interface TreasureHoard {
  /** Requested budget in gp. */
  targetGp: number;
  /** Actual total value (coins + items). Equals targetGp by construction. */
  totalGp: number;
  /** Loose coins in gp (the small remainder after the items). */
  coinsGp: number;
  /** Coins broken into denominations. */
  coins: { pp: number; gp: number; sp: number; cp: number };
  /** Every item (signatures included), distinct names except stackables. */
  items: TreasureItem[];
  /** The 1–2 signature items, for the art generator to pick up. */
  signatureItems: TreasureItem[];
  level: number;
  seed: number;
  theme: string;
}

/** Options for generating one hoard. */
export interface TreasureOptions {
  /** Requested total value in gp (1+). */
  budgetGp: number;
  /** Party level the hoard is for (1+). Gates the level bands. */
  level: number;
  /** Seed for deterministic generation. Default: random. */
  seed?: number;
  /** Story theme: "dungeon" (default), "gothic", "underwater", "crypt". */
  theme?: string;
}

/** A valued pool entry: [name, value in gp]. */
type PoolEntry = [string, number];

/** Gems by level band — same values as the loot module's house table. */
const GEM_POOL: { minLevel: number; gems: PoolEntry[] }[] = [
  { minLevel: 1, gems: [["Quartz", 5], ["Malachite", 8], ["Turquoise", 10], ["Banded agate", 12]] },
  { minLevel: 4, gems: [["Amethyst", 50], ["Jade", 60], ["Pearl", 75], ["Topaz", 100]] },
  { minLevel: 8, gems: [["Ruby", 250], ["Sapphire", 300], ["Emerald", 400], ["Diamond", 500]] },
];

/** Art objects by level band: [name, value in gp]. House prices. */
const ART_POOL: { minLevel: number; art: PoolEntry[] }[] = [
  {
    minLevel: 1,
    art: [
      ["Carved bone dice set", 15],
      ["Embroidered silk scarf", 18],
      ["Painted porcelain mask", 20],
      ["Ivory comb", 22],
      ["Silver locket with a miniature portrait", 25],
      ["Brass spyglass", 30],
    ],
  },
  {
    minLevel: 4,
    art: [
      ["Jeweled snuffbox", 90],
      ["Silvered mirror in an oak frame", 110],
      ["Gilded harp with silver strings", 120],
      ["Clockwork songbird", 140],
      ["Marble bust of a forgotten king", 150],
    ],
  },
  {
    minLevel: 8,
    art: [
      ["Tapestry of the drowned city", 250],
      ["Dragonbone chess set", 300],
      ["Obsidian throne miniature", 320],
      ["Star sapphire cameo", 350],
      ["Golden reliquary", 400],
    ],
  },
];

/** Weapons by level band: [name, value in gp]. House prices. */
const WEAPON_POOL: { minLevel: number; weapons: PoolEntry[] }[] = [
  {
    minLevel: 1,
    weapons: [
      ["Rapier", 2],
      ["Composite longbow", 20],
      ["Silver dagger", 22],
      ["Cold iron longsword", 35],
    ],
  },
  {
    minLevel: 4,
    weapons: [
      ["Silvered warhammer", 60],
      ["Cold iron breastplate", 80],
      ["Darkwood composite longbow", 100],
    ],
  },
  {
    minLevel: 8,
    weapons: [
      ["Dragonscale shield", 220],
      ["Adamantine longsword", 250],
      ["Mithral full plate", 300],
    ],
  },
];

/** Armor by level band: [name, value in gp]. House prices. */
const ARMOR_POOL: { minLevel: number; armor: PoolEntry[] }[] = [
  { minLevel: 1, armor: [["Chain mail", 6], ["Breastplate", 8], ["Steel shield", 2]] },
  { minLevel: 4, armor: [["Cold iron chain mail", 70], ["Mithral chain shirt", 110]] },
  { minLevel: 8, armor: [["Adamantine breastplate", 260]] },
];

/** Consumables by level band: [name, value in gp]. Same values as loot. */
const CONSUMABLE_POOL: { minLevel: number; items: PoolEntry[] }[] = [
  {
    minLevel: 1,
    items: [
      ["Caltrops", 1],
      ["Alchemist's Fire (lesser)", 3],
      ["Healing Potion (minor)", 4],
      ["Smokestick", 5],
      ["Antidote (lesser)", 8],
      ["Healing Potion (lesser)", 12],
    ],
  },
  {
    minLevel: 4,
    items: [
      ["Oil of Mending", 10],
      ["Bottled Lightning (lesser)", 11],
      ["Alchemist's Fire (moderate)", 12],
      ["Antidote (moderate)", 28],
      ["Healing Potion (moderate)", 50],
    ],
  },
  {
    minLevel: 8,
    items: [
      ["Alchemist's Fire (greater)", 50],
      ["Elixir of Life (moderate)", 70],
      ["Antidote (greater)", 100],
      ["Healing Potion (greater)", 200],
    ],
  },
];

/** Equipment (non-weapon, non-consumable gear) by level band. */
const EQUIPMENT_POOL: { minLevel: number; items: PoolEntry[] }[] = [
  {
    minLevel: 1,
    items: [
      ["Thieves' Tools (infiltrator)", 25],
      ["Healer's Tools (expanded)", 50],
      ["Climbing Kit", 5],
    ],
  },
  {
    minLevel: 4,
    items: [
      ["Alchemist's Tools (expanded)", 70],
      ["Spyglass (greater)", 90],
    ],
  },
  { minLevel: 8, items: [["Wayfinder (greater)", 200]] },
];

/** A signature-item base: name, what it is, and its ability options. */
interface SignatureBase {
  name: string;
  base: string;
  abilities: string[];
}

const SIGNATURE_POOL: SignatureBase[] = [
  {
    name: "Emberfang",
    base: "a longsword whose edge never cools",
    abilities: [
      "Once per day, the blade ignites; your next hit deals an extra 1d6 fire damage.",
      "The blade is always warm to the touch and sheds dim light in a 10-foot radius.",
    ],
  },
  {
    name: "The Warden's Oath",
    base: "a steel shield etched with a vow",
    abilities: [
      "Once per day, when an ally within 30 feet takes damage, you may take half of it instead.",
      "While you hold it, allies within 10 feet gain a +1 circumstance bonus to saves against fear.",
    ],
  },
  {
    name: "Whisperchain",
    base: "a fine silver chain that hums faintly",
    abilities: [
      "Once per day, you can send a whispered message to any creature you have met, no matter the distance.",
      "Once per day, you can hear the last words spoken within 30 feet of the chain, up to an hour ago.",
    ],
  },
  {
    name: "The Pale Lantern",
    base: "a lantern of bone-white glass",
    abilities: [
      "Its light reveals invisible creatures within 20 feet while lit.",
      "Once per day, its light flares and dispels magical darkness within 30 feet for 1 minute.",
    ],
  },
  {
    name: "Stormcaller's Chord",
    base: "a longbow strung with silver wire",
    abilities: [
      "Once per day, loose an arrow that calls down a bolt of lightning, dealing an extra 2d6 electricity damage.",
      "Arrows fired from it fly true in high wind; ignore wind penalties on ranged attacks.",
    ],
  },
  {
    name: "Duskveil",
    base: "a cloak woven from twilight",
    abilities: [
      "Once per day, wrap yourself in shadow; you are concealed for 1 minute.",
      "While worn, your footsteps make no sound on stone or wood.",
    ],
  },
  {
    name: "The Cartographer's Compass",
    base: "a brass compass that spins when secrets are near",
    abilities: [
      "Once per day, it points unerringly toward the nearest hidden door or secret passage within 100 feet.",
      "Once per day, it recalls the exact route you took to reach your current location, even through a maze.",
    ],
  },
  {
    name: "Glimmerhold",
    base: "a ring of pale blue crystal",
    abilities: [
      "Once per day, store a single spell cast at you (up to 2nd rank) and release it later as your own.",
      "Once per day, the ring steadies your hand; your next check to Craft, Disable, or Recall Knowledge gains a +2 circumstance bonus.",
    ],
  },
  {
    name: "Tidecaller Pearl",
    base: "a pearl that holds the sound of the sea",
    abilities: [
      "Once per day, calm or summon a 10-foot wave of water.",
      "While carried, you can breathe underwater for up to 10 minutes per day.",
    ],
  },
  {
    name: "The Thorned Vow",
    base: "a dagger bound in blackened briar",
    abilities: [
      "Once per day, a thrown strike returns to your hand at the end of your turn.",
      "Once per day, a hit with it leaves a thorn that deals 1d4 persistent bleed damage.",
    ],
  },
];

/** Story fragments: owners and places per theme. Unknown themes fall back to "dungeon". */
const STORY_PEOPLE: Record<string, string[]> = {
  dungeon: [
    "a dwarven merchant-prince",
    "the pirate queen Selka",
    "a disgraced knight of Lastwall",
    "a halfling smuggler named Pim",
    "an elven ambassador who never arrived",
    "a goblin king with delusions of grandeur",
    "a retired adventurer called Old Marrow",
    "a traveling priest of Desna",
  ],
  gothic: [
    "the dowager countess of Ustalav",
    "a pale violinist who played only at funerals",
    "a monk who walled himself into the abbey",
    "the last heir of a drowned noble house",
  ],
  underwater: [
    "a triton salvage-captain",
    "a sea-elf cartographer of the drowned roads",
    "a sahuagin priestess who traded in secrets",
    "a drowned sailor who never stopped rowing",
  ],
  crypt: [
    "a lich's former chamberlain",
    "a grave-robber who repented too late",
    "the high priestess of the bone chapel",
    "a wight who collects its own epitaphs",
  ],
};

const STORY_PLACES: Record<string, string[]> = {
  dungeon: [
    "the Sunken Chapel",
    "a collapsed mine in the Five Kings Mountains",
    "the back room of a Riddleport gambling den",
    "an abandoned waystation on the Ustalav road",
    "the vault of a bankrupt Absalom trading house",
    "a barrow on the Storval Plain",
  ],
  gothic: [
    "the black chapel at the edge of the moor",
    "a manor whose windows were bricked up from the inside",
    "the family crypt beneath the opera house",
  ],
  underwater: [
    "the drowned city of Azlant",
    "a wreck on the reef of the Broken Eye",
    "a tide-cave that only opens at low water",
  ],
  crypt: [
    "the bone chapel's reliquary",
    "a tomb that was sealed twice",
    "the lich's antechamber",
  ],
};

/** Story quirks: the small detail that makes an item memorable. */
const STORY_QUIRKS: string[] = [
  "it is warm to the touch, even in the cold",
  "it smells faintly of sea salt",
  "it bears a small notch for every owner it has outlived",
  "it hums a half-remembered tune when the wind blows",
  "it is scratched with a child's drawing of a dog",
  "it rattles softly, as if something inside is still awake",
  "it is wrapped in a strip of cloth embroidered with a name nobody recognizes",
  "it has a dent shaped exactly like a thumbprint",
];

/** Story templates per item kind. {owner}, {place}, {quirk} are filled in. */
const STORY_TEMPLATES: Record<Exclude<TreasureKind, "coins" | "signature">, string[]> = {
  gem: [
    "Pried from {place} by {owner}. {quirk}.",
    "Cut by {owner} and lost in a card game at {place}. {quirk}.",
    "Once the eye of a statue in {place}; {owner} took it and never looked back. {quirk}.",
  ],
  art: [
    "Commissioned by {owner} for a feast at {place} that never happened. {quirk}.",
    "Made for {owner}, who carried it from {place} to every posting. {quirk}.",
    "Looted from {place} by {owner}, who swore it was cursed and sold it the same night. {quirk}.",
  ],
  weapon: [
    "Carried by {owner} through the siege of {place}. {quirk}.",
    "Forged for {owner} and balanced for a hand that no longer exists. {quirk}.",
    "Taken from the body of {owner} at {place}; the sheath still smells of rain. {quirk}.",
  ],
  armor: [
    "Worn by {owner} at {place}; the straps were cut by someone in a hurry. {quirk}.",
    "Made to order for {owner}, who outgrew it in a single winter at {place}. {quirk}.",
    "Dented at {place}, where {owner} stood the line alone. {quirk}.",
  ],
  consumable: [
    "Brewed by {owner} in a cellar under {place}. {quirk}.",
    "Bought in bulk by {owner} before the road to {place} closed. {quirk}.",
    "Mixed from a recipe {owner} stole from a rival in {place}. {quirk}.",
  ],
  equipment: [
    "Used daily by {owner} on the road to {place}. {quirk}.",
    "Assembled by {owner} from parts scavenged at {place}. {quirk}.",
    "A gift to {owner} from a grateful stranger at {place}. {quirk}.",
  ],
};

/** Signature-item story templates: {owner}, {place}, {ability} are filled in. */
const SIGNATURE_STORY_TEMPLATES: string[] = [
  "Made for {owner}, who carried it out of {place} and never spoke of what it cost. Its power: {ability}",
  "Once belonged to {owner}; it was found in {place}, still warm, still waiting. Its power: {ability}",
  "{owner} swore an oath on it at {place} — the oath is gone, but the item remembers. Its power: {ability}",
];

const COIN_STORY_TEMPLATES: string[] = [
  "Loose coin from a purse cut at {place}; the owner's mark is still filed off one edge.",
  "Coinage of a dozen realms, swept up by {owner} after the market at {place} burned.",
  "A dead pay-chest's contents, counted twice by {owner} and short both times.",
];

/** Max distinct non-signature items in one hoard (keeps hoards readable). */
const MAX_ITEMS = 14;
/** Max quantity on a stackable item (gems / consumables). */
const MAX_STACK = 5;
/** Signature items take 20–35% of the budget each (before the cap). */
const SIGNATURE_FRACTION_MIN = 0.2;
const SIGNATURE_FRACTION_MAX = 0.35;
/** A signature item is never worth more than this share of the budget. */
const SIGNATURE_FRACTION_CAP = 0.45;

/**
 * All pool entries available at a level: the union of every band at or
 * below the level, not just the top band. A high-level hoard still
 * contains cheap gems and potions — and a small budget at a high level
 * needs cheap items to spend on, or the hoard degenerates to one
 * signature item plus a pile of coins.
 */
function eligiblePool(level: number): { name: string; kind: Exclude<TreasureKind, "coins">; valueGp: number; stackable: boolean }[] {
  const pool: { name: string; kind: Exclude<TreasureKind, "coins">; valueGp: number; stackable: boolean }[] = [];
  const pushBand = <T extends { minLevel: number }>(
    table: T[],
    get: (band: T) => PoolEntry[],
    kind: Exclude<TreasureKind, "coins">,
    stackable: boolean,
  ): void => {
    for (const band of table) {
      if (level < band.minLevel) continue;
      for (const [name, value] of get(band))
        pool.push({ name, kind, valueGp: value, stackable });
    }
  };
  pushBand(GEM_POOL, (b) => b.gems, "gem", true);
  pushBand(ART_POOL, (b) => b.art, "art", false);
  pushBand(WEAPON_POOL, (b) => b.weapons, "weapon", false);
  pushBand(ARMOR_POOL, (b) => b.armor, "armor", false);
  pushBand(CONSUMABLE_POOL, (b) => b.items, "consumable", true);
  pushBand(EQUIPMENT_POOL, (b) => b.items, "equipment", false);
  return pool;
}

/** Seeded Fisher–Yates shuffle. */
function shuffle<T>(rng: () => number, arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

/** Story context: the themed owner/place pools for one hoard. */
interface StoryContext {
  people: string[];
  places: string[];
}

function storyContext(theme: string): StoryContext {
  return {
    people: STORY_PEOPLE[theme] ?? STORY_PEOPLE.dungeon,
    places: STORY_PLACES[theme] ?? STORY_PLACES.dungeon,
  };
}

/**
 * Build one story line for an item. Unique within the hoard: the caller
 * passes the set of stories already used, and this retries until it finds
 * a combination that has not been used (the combo space is large; the
 * fallback appends a serial detail so uniqueness is guaranteed).
 */
function makeStory(
  rng: () => number,
  ctx: StoryContext,
  kind: Exclude<TreasureKind, "coins">,
  used: Set<string>,
  ability?: string,
): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const owner = pick(rng, ctx.people);
    const place = pick(rng, ctx.places);
    // Quirks start a new sentence after a period, so capitalize them.
    const quirkRaw = pick(rng, STORY_QUIRKS);
    const quirk = quirkRaw.charAt(0).toUpperCase() + quirkRaw.slice(1);
    let story: string;
    if (kind === "signature") {
      const template = pick(rng, SIGNATURE_STORY_TEMPLATES);
      story = template
        .replace("{owner}", owner)
        .replace("{place}", place)
        .replace("{ability}", ability ?? "a power nobody has named");
    } else {
      const template = pick(rng, STORY_TEMPLATES[kind]);
      story = template
        .replace("{owner}", owner)
        .replace("{place}", place)
        .replace("{quirk}", quirk);
    }
    if (!used.has(story)) return story;
  }
  // Extremely unlikely fallback: force uniqueness with a serial detail.
  const owner = pick(rng, ctx.people);
  const place = pick(rng, ctx.places);
  return `Kept by ${owner} after ${place}; it carries the mark ${used.size + 1} of its keeping.`;
}

function makeCoinStory(rng: () => number, ctx: StoryContext): string {
  const template = pick(rng, COIN_STORY_TEMPLATES);
  return template
    .replace("{owner}", pick(rng, ctx.people))
    .replace("{place}", pick(rng, ctx.places));
}

/**
 * Generate a hoard that totals exactly the requested budget (coins fill
 * the remainder). Deterministic for a given (budgetGp, level, seed, theme).
 */
export function generateTreasure(opts: TreasureOptions): TreasureHoard {
  const targetGp = Math.max(1, Math.floor(opts.budgetGp));
  const level = Math.max(1, Math.floor(opts.level));
  const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
  const theme = opts.theme ?? "dungeon";
  const rng = rngFromSeed(seed);
  const ctx = storyContext(theme);
  const usedStories = new Set<string>();

  // 1–2 signature items, each 20–35% of the budget (capped at 45%).
  const signatureCount = targetGp < 750 ? 1 : 2;
  const cap = Math.floor(targetGp * SIGNATURE_FRACTION_CAP);
  const signatureBases = shuffle(rng, SIGNATURE_POOL).slice(0, signatureCount);
  const signatureItems: TreasureItem[] = signatureBases.map((base) => {
    const ability = pick(rng, base.abilities);
    const frac =
      SIGNATURE_FRACTION_MIN + rng() * (SIGNATURE_FRACTION_MAX - SIGNATURE_FRACTION_MIN);
    // Clamped to the budget itself so a tiny budget (1–2 gp) can't
    // overshoot: value is at least 1 gp and at most the target.
    const valueGp = Math.max(
      1,
      Math.min(cap, Math.round(targetGp * frac), targetGp),
    );
    const story = makeStory(rng, ctx, "signature", usedStories, ability);
    usedStories.add(story);
    return {
      name: base.name,
      kind: "signature" as const,
      valueGp,
      quantity: 1,
      story,
      homebrew: true,
      ability,
      art: null,
      artPrompt: `Top-down tabletop RPG item art, ${base.name} — ${base.base}, ${theme} style, centered on a plain dark background, square image, no text`,
    };
  });

  let spent = signatureItems.reduce((s, it) => s + it.valueGp, 0);
  let remaining = targetGp - spent;

  // Pass 1: unique items from the pool, seeded order, until the budget
  // is nearly spent or the item cap is hit. Non-stackables never repeat.
  const pool = shuffle(rng, eligiblePool(level));
  const items: TreasureItem[] = [...signatureItems];
  const stackables: TreasureItem[] = [];
  for (const entry of pool) {
    if (items.length - signatureItems.length >= MAX_ITEMS) break;
    if (entry.valueGp > remaining) continue;
    const story = makeStory(rng, ctx, entry.kind, usedStories);
    usedStories.add(story);
    const item: TreasureItem = {
      name: entry.name,
      kind: entry.kind,
      valueGp: entry.valueGp,
      quantity: 1,
      story,
    };
    items.push(item);
    if (entry.stackable) stackables.push(item);
    remaining -= entry.valueGp;
  }

  // Pass 2: grow stacks (gems / consumables) while they fit.
  for (const item of shuffle(rng, stackables)) {
    while (item.quantity < MAX_STACK && item.valueGp <= remaining) {
      item.quantity += 1;
      remaining -= item.valueGp;
    }
    if (remaining <= 0) break;
  }

  // Top-up: if the pool was too thin to spend the budget (e.g. a huge
  // budget at a low level), raise the signature values — they are
  // homebrew items, so their value is assigned, not intrinsic — instead
  // of dumping the remainder into coins.
  if (remaining > targetGp * 0.2 && signatureItems.length > 0) {
    const headroom = signatureItems.reduce(
      (s, it) => s + (cap - it.valueGp),
      0,
    );
    const topUp = Math.min(headroom, remaining - Math.floor(targetGp * 0.05));
    if (topUp > 0) {
      // Spread the top-up across the signatures, round-robin.
      let left = topUp;
      let i = 0;
      while (left > 0) {
        const it = signatureItems[i % signatureItems.length];
        const room = cap - it.valueGp;
        if (room > 0) {
          const add = Math.min(room, left);
          it.valueGp += add;
          left -= add;
          remaining -= add;
        }
        i++;
        if (i > signatureItems.length * 2 && left > 0) break;
      }
    }
  }

  // Coins fill the remainder (small by construction).
  const coinsGp = Math.max(0, remaining);
  const totalGp = targetGp;
  return {
    targetGp,
    totalGp,
    coinsGp,
    coins: splitCoins(coinsGp),
    items,
    signatureItems,
    level,
    seed,
    theme,
  };
}

/** Total gp value of a list of treasure items (value × quantity). */
export function treasureValueGp(items: TreasureItem[]): number {
  return items.reduce((sum, it) => sum + it.valueGp * it.quantity, 0);
}

/** One-line chat text for a hoard. Signature abilities are labeled homebrew. */
export function formatTreasure(hoard: TreasureHoard): string {
  const lines: string[] = [
    `💰 Treasure worth ${hoard.totalGp} gp (budget ${hoard.targetGp} gp):`,
  ];
  for (const it of hoard.items) {
    const qty = it.quantity > 1 ? `${it.quantity}× ` : "";
    const value = it.valueGp * it.quantity;
    let line = `  • ${qty}${it.name} (${value} gp) — ${it.story}`;
    if (it.kind === "signature" && it.ability) {
      line += ` Ability (homebrew): ${it.ability}`;
    }
    lines.push(line);
  }
  if (hoard.coinsGp > 0) {
    const c = hoard.coins;
    const coinParts: string[] = [];
    if (c.pp > 0) coinParts.push(`${c.pp} pp`);
    if (c.gp > 0) coinParts.push(`${c.gp} gp`);
    if (c.sp > 0) coinParts.push(`${c.sp} sp`);
    if (c.cp > 0) coinParts.push(`${c.cp} cp`);
    lines.push(`  • Loose coins: ${coinParts.join(", ")} (${hoard.coinsGp} gp)`);
  }
  return lines.join("\n");
}
