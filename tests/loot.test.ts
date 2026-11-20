/**
 * Unit tests for the loot pipeline pure functions (src/session/loot.ts).
 * No Foundry connection needed — run with `bun test`.
 */
import { describe, expect, it } from "bun:test";
import {
  formatLoot,
  generateLoot,
  lootValueGp,
  splitCoins,
} from "../src/session/loot.js";

describe("generateLoot", () => {
  it("is deterministic for a given seed", () => {
    const a = generateLoot({ level: 3, seed: 42 });
    const b = generateLoot({ level: 3, seed: 42 });
    expect(a).toEqual(b);
    const c = generateLoot({ level: 3, seed: 43 });
    expect(c.coinsGp).not.toBe(a.coinsGp);
  });

  it("scales coins with tier", () => {
    const poor = generateLoot({ level: 3, tier: "poor", seed: 7 });
    const rich = generateLoot({ level: 3, tier: "rich", seed: 7 });
    expect(rich.coinsGp).toBeGreaterThan(poor.coinsGp);
    expect(poor.coinsGp).toBeGreaterThan(0);
  });

  it("never duplicates an item name (quantities merge)", () => {
    for (let seed = 0; seed < 20; seed++) {
      const loot = generateLoot({ level: 5, tier: "rich", seed });
      const names = loot.items.map((i) => i.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("scales with level", () => {
    const low = generateLoot({ level: 1, seed: 1 });
    const high = generateLoot({ level: 10, seed: 1 });
    expect(high.coinsGp).toBeGreaterThan(low.coinsGp);
  });

  it("gems and consumables come from the level band", () => {
    const loot = generateLoot({ level: 1, seed: 3 });
    const gem = loot.items.find((i) => i.type === "treasure" && i.name !== "Coins");
    if (gem) expect(gem.price ?? 0).toBeLessThanOrEqual(12);
  });
});

describe("splitCoins", () => {
  it("round-trips to the gp total", () => {
    for (const total of [1, 7, 13, 125, 1000]) {
      const c = splitCoins(total);
      expect(c.pp * 1000 + c.gp * 100 + c.sp * 10 + c.cp).toBe(total * 100);
    }
  });

  it("breaks 12.34 gp into pp/gp/sp/cp", () => {
    expect(splitCoins(12.34)).toEqual({ pp: 1, gp: 2, sp: 3, cp: 4 });
  });

  it("returns zeros for zero", () => {
    expect(splitCoins(0)).toEqual({ pp: 0, gp: 0, sp: 0, cp: 0 });
  });
});

describe("lootValueGp", () => {
  it("sums price times quantity", () => {
    expect(
      lootValueGp([
        { name: "Gem", type: "treasure", price: 50, quantity: 2 },
        { name: "Potion", type: "consumable", price: 12 },
      ]),
    ).toBe(112);
  });

  it("treats a missing price as zero", () => {
    expect(lootValueGp([{ name: "Rock", type: "treasure" }])).toBe(0);
  });
});

describe("formatLoot", () => {
  it("names the coins and the items", () => {
    const loot = generateLoot({ level: 3, seed: 9 });
    const text = formatLoot(loot, "the Old Chest");
    expect(text).toContain("the Old Chest");
    expect(text).toMatch(/gp/);
    for (const item of loot.items) expect(text).toContain(item.name);
  });

  it("says when the chest is empty", () => {
    expect(
      formatLoot({ coinsGp: 0, coins: { pp: 0, gp: 0, sp: 0, cp: 0 }, items: [], itemsValueGp: 0 }),
    ).toContain("empty");
  });
});
