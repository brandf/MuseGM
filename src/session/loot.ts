/**
 * Loot pipeline (P2) — generate treasure, fill a chest's loot actor, and
 * hand the contents to a character sheet on open.
 *
 * Two layers, kept separate on purpose (same pattern as src/session/dice.ts):
 * - Pure functions (generateLoot / splitCoins / lootValueGp / formatLoot):
 *   no Foundry, no I/O, unit tested in tests/loot.test.ts. Generation is
 *   deterministic for a given seed, so a table can re-roll the same hoard.
 * - Live functions (fillChest / openChest): thin wrappers over
 *   FoundryLive.modifyDocument, following the chest route in
 *   src/worldbuilding/index.ts (a `loot`-type Actor holding Item docs;
 *   players open the token and take items onto their own sheets).
 *
 * The treasure table below is a simple HOUSE table (coins scale with level,
 * gems and consumables from a small curated list of real PF2e item names).
 * It is NOT the PF2e rulebook "Treasure by Level" table — do not present
 * it as one. If the table wants rulebook-exact treasure, the GM rolls it.
 */
import type { FoundryLive } from "../live.js";
import type { LootSpec } from "../worldbuilding/index.js";

/** Loot tiers: how generous this hoard is. */
export type LootTier = "poor" | "standard" | "rich";

/** Options for generating one hoard. */
export interface LootOptions {
  /** Party level the hoard is for (1+). */
  level: number;
  /** How generous. Default: "standard". */
  tier?: LootTier;
  /** Seed for deterministic generation. Default: random. */
  seed?: number;
  /** Name of the hoard, e.g. "Old Chest". Used in the chat line only. */
  name?: string;
}

/** One generated hoard: coins plus item specs ready for a chest. */
export interface GeneratedLoot {
  /** Total coin value in gp (before splitting into denominations). */
  coinsGp: number;
  /** Coins broken into denominations. */
  coins: { pp: number; gp: number; sp: number; cp: number };
  /** Items (gems + consumables/treasure), as LootSpecs. */
  items: LootSpec[];
  /** Total value of the items in gp. */
  itemsValueGp: number;
}

/** Deterministic RNG (mulberry32) so a seed re-rolls the same hoard. */
export function rngFromSeed(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Roll NdS on a seeded RNG. */
function rollDiceSeeded(rng: () => number, count: number, sides: number): number {
  let total = 0;
  for (let i = 0; i < count; i++) total += 1 + Math.floor(rng() * sides);
  return total;
}

/** Gems by level band: [name, value in gp]. */
const GEM_TABLE: { minLevel: number; gems: [string, number][] }[] = [
  {
    minLevel: 1,
    gems: [
      ["Malachite", 8],
      ["Turquoise", 10],
      ["Banded agate", 12],
      ["Quartz", 5],
    ],
  },
  {
    minLevel: 4,
    gems: [
      ["Amethyst", 50],
      ["Jade", 60],
      ["Pearl", 75],
      ["Topaz", 100],
    ],
  },
  {
    minLevel: 8,
    gems: [
      ["Ruby", 250],
      ["Sapphire", 300],
      ["Emerald", 400],
      ["Diamond", 500],
    ],
  },
];

/** Consumables by level band: [name, item type, price in gp]. */
const CONSUMABLE_TABLE: { minLevel: number; items: [string, string, number][] }[] = [
  {
    minLevel: 1,
    items: [
      ["Healing Potion (minor)", "consumable", 4],
      ["Healing Potion (lesser)", "consumable", 12],
      ["Antidote (lesser)", "consumable", 8],
      ["Alchemist's Fire (lesser)", "consumable", 3],
      ["Caltrops", "equipment", 1],
      ["Smokestick", "consumable", 5],
    ],
  },
  {
    minLevel: 4,
    items: [
      ["Healing Potion (moderate)", "consumable", 50],
      ["Antidote (moderate)", "consumable", 28],
      ["Alchemist's Fire (moderate)", "consumable", 12],
      ["Bottled Lightning (lesser)", "consumable", 11],
      ["Oil of Mending", "consumable", 10],
    ],
  },
  {
    minLevel: 8,
    items: [
      ["Healing Potion (greater)", "consumable", 200],
      ["Antidote (greater)", "consumable", 100],
      ["Alchemist's Fire (greater)", "consumable", 50],
      ["Elixir of Life (moderate)", "consumable", 70],
    ],
  },
];

function bandFor<T extends { minLevel: number }>(table: T[], level: number): T {
  let band = table[0];
  for (const b of table) if (level >= b.minLevel) band = b;
  return band;
}

/**
 * Generate one hoard. Deterministic for a given (level, tier, seed).
 * Coins scale with level; gems and consumables come from the level band.
 */
export function generateLoot(opts: LootOptions): GeneratedLoot {
  const level = Math.max(1, Math.floor(opts.level));
  const tier = opts.tier ?? "standard";
  const rng = rngFromSeed(opts.seed ?? Math.floor(Math.random() * 2 ** 31));

  // Coins: (level + 2) d6 gp base, scaled by tier.
  const tierMult = tier === "poor" ? 0.5 : tier === "rich" ? 2 : 1;
  const coinsGp = Math.max(
    1,
    Math.round(rollDiceSeeded(rng, level + 2, 6) * tierMult),
  );

  // Gems: 0–2, more likely on richer tiers. Names merge into quantities
  // when the same gem is picked twice.
  const gemBand = bandFor(GEM_TABLE, level);
  const gemRolls = tier === "rich" ? 2 : tier === "poor" ? 0 : 1;
  const gemCount = gemRolls + (rng() < 0.5 ? 1 : 0);
  const items: LootSpec[] = [];
  const addItem = (spec: LootSpec): void => {
    const existing = items.find((it) => it.name === spec.name);
    if (existing) existing.quantity = (existing.quantity ?? 1) + (spec.quantity ?? 1);
    else items.push({ ...spec });
  };
  for (let i = 0; i < gemCount; i++) {
    const [name, price] = gemBand.gems[Math.floor(rng() * gemBand.gems.length)];
    addItem({ name, type: "treasure", price, quantity: 1 });
  }

  // Consumables: 1–3, richer tiers get more.
  const consBand = bandFor(CONSUMABLE_TABLE, level);
  const consCount =
    (tier === "rich" ? 3 : tier === "poor" ? 1 : 2) + (rng() < 0.4 ? 1 : 0);
  for (let i = 0; i < consCount; i++) {
    const [name, type, price] =
      consBand.items[Math.floor(rng() * consBand.items.length)];
    addItem({ name, type, price, quantity: 1 });
  }

  return {
    coinsGp,
    coins: splitCoins(coinsGp),
    items,
    itemsValueGp: lootValueGp(items),
  };
}

/** Break a gp total into pp/gp/sp/cp (whole coins, remainder in cp). */
export function splitCoins(totalGp: number): { pp: number; gp: number; sp: number; cp: number } {
  const totalCp = Math.max(0, Math.round(totalGp * 100));
  const pp = Math.floor(totalCp / 1000);
  const gp = Math.floor((totalCp - pp * 1000) / 100);
  const sp = Math.floor((totalCp - pp * 1000 - gp * 100) / 10);
  const cp = totalCp - pp * 1000 - gp * 100 - sp * 10;
  return { pp, gp, sp, cp };
}

/** Total gp value of a list of loot items (price × quantity). */
export function lootValueGp(items: LootSpec[]): number {
  return items.reduce((sum, it) => sum + (it.price ?? 0) * (it.quantity ?? 1), 0);
}

/** One-line chat text for a hoard. */
export function formatLoot(loot: GeneratedLoot, name = "the chest"): string {
  const parts: string[] = [];
  const c = loot.coins;
  const coinParts: string[] = [];
  if (c.pp > 0) coinParts.push(`${c.pp} pp`);
  if (c.gp > 0) coinParts.push(`${c.gp} gp`);
  if (c.sp > 0) coinParts.push(`${c.sp} sp`);
  if (c.cp > 0) coinParts.push(`${c.cp} cp`);
  if (coinParts.length > 0) parts.push(coinParts.join(", "));
  for (const it of loot.items) {
    parts.push(it.quantity && it.quantity > 1 ? `${it.quantity}× ${it.name}` : it.name);
  }
  if (parts.length === 0) return `💰 ${name} is empty.`;
  return `💰 ${name} contains: ${parts.join("; ")} (about ${loot.coinsGp + loot.itemsValueGp} gp in all).`;
}

// ---------------------------------------------------------------- live layer

interface RawItem {
  _id: string;
  name: string;
  type: string;
  system?: { quantity?: number; price?: { value?: number } };
}

/**
 * Fill a chest's loot actor with generated items. Coins go in as a single
 * "Coins" treasure item priced at the total gp value (PF2e loot actors
 * have no coin purse of their own — the GM splits coins on handover).
 * Returns the created item _ids.
 */
export async function fillChest(
  live: FoundryLive,
  chestActorId: string,
  loot: GeneratedLoot,
): Promise<string[]> {
  const items: LootSpec[] = [...loot.items];
  if (loot.coinsGp > 0) {
    items.unshift({ name: "Coins", type: "treasure", price: loot.coinsGp, quantity: 1 });
  }
  if (items.length === 0) return [];
  const created = await live.modifyDocument("Item", "create", {
    data: items.map((item) => ({
      name: item.name,
      type: item.type ?? "treasure",
      system: {
        quantity: item.quantity ?? 1,
        price: { value: item.price ?? 0, denomination: "gp" },
      },
    })),
    parentUuid: `Actor.${chestActorId}`,
  });
  return created.map((d) => String(d._id));
}

/** Generate a hoard and fill a chest with it in one call. */
export async function generateAndFillChest(
  live: FoundryLive,
  chestActorId: string,
  opts: LootOptions,
): Promise<{ loot: GeneratedLoot; itemIds: string[] }> {
  const loot = generateLoot(opts);
  const itemIds = await fillChest(live, chestActorId, loot);
  return { loot, itemIds };
}

/**
 * Open a chest: move every item on the chest's loot actor onto a
 * character's sheet (create a copy on the character, delete the original),
 * then report what was taken to chat. Coins arrive as the "Coins" treasure
 * item — the GM converts them to the character's purse in Foundry.
 * Returns the names of the items moved.
 */
export async function openChest(
  live: FoundryLive,
  chestActorId: string,
  characterActorId: string,
  characterName?: string,
): Promise<string[]> {
  const raw = live.raw() as unknown as {
    getRawActor(id: string): { items?: RawItem[] } | undefined;
  };
  const chest = raw.getRawActor(chestActorId);
  const chestItems = chest?.items ?? [];
  if (chestItems.length === 0) {
    await live.sendChat(`💰 The chest is empty.`);
    return [];
  }
  const moved: string[] = [];
  for (const item of chestItems) {
    await live.modifyDocument("Item", "create", {
      data: [
        {
          name: item.name,
          type: item.type,
          system: {
            quantity: item.system?.quantity ?? 1,
            price: { value: item.system?.price?.value ?? 0, denomination: "gp" },
          },
        },
      ],
      parentUuid: `Actor.${characterActorId}`,
    });
    await live.modifyDocument("Item", "delete", {
      ids: [item._id],
      parentUuid: `Actor.${chestActorId}`,
    });
    moved.push(item.name);
  }
  const who = characterName ? `**${characterName}** takes` : "Taken";
  await live.sendChat(`💰 ${who}: ${moved.join("; ")}.`);
  return moved;
}
