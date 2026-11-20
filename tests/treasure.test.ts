import { describe, expect, it } from "bun:test";
import {
  formatTreasure,
  generateTreasure,
  treasureValueGp,
  type TreasureHoard,
} from "../src/session/treasure.js";

describe("generateTreasure > budget fitting", () => {
  it("lands within 10% of the budget at 50 gp", () => {
    const hoard = generateTreasure({ budgetGp: 50, level: 1, seed: 7 });
    expect(hoard.totalGp).toBeGreaterThanOrEqual(45);
    expect(hoard.totalGp).toBeLessThanOrEqual(55);
    expect(treasureValueGp(hoard.items) + hoard.coinsGp).toBe(hoard.totalGp);
  });

  it("lands within 10% of the budget at 500 gp", () => {
    const hoard = generateTreasure({ budgetGp: 500, level: 3, seed: 7 });
    expect(hoard.totalGp).toBeGreaterThanOrEqual(450);
    expect(hoard.totalGp).toBeLessThanOrEqual(550);
    expect(treasureValueGp(hoard.items) + hoard.coinsGp).toBe(hoard.totalGp);
  });

  it("lands within 10% of the budget at 5000 gp", () => {
    const hoard = generateTreasure({ budgetGp: 5000, level: 8, seed: 7 });
    expect(hoard.totalGp).toBeGreaterThanOrEqual(4500);
    expect(hoard.totalGp).toBeLessThanOrEqual(5500);
    expect(treasureValueGp(hoard.items) + hoard.coinsGp).toBe(hoard.totalGp);
  });

  it("still fits a huge budget at a low level (thin pool, signature top-up)", () => {
    const hoard = generateTreasure({ budgetGp: 5000, level: 1, seed: 7 });
    expect(hoard.totalGp).toBeGreaterThanOrEqual(4500);
    expect(hoard.totalGp).toBeLessThanOrEqual(5500);
    // Coins stay a minority even when the pool is thin.
    expect(hoard.coinsGp).toBeLessThan(hoard.totalGp * 0.5);
  });

  it("handles a tiny budget without overshooting", () => {
    const hoard = generateTreasure({ budgetGp: 5, level: 1, seed: 3 });
    expect(hoard.totalGp).toBe(5);
    expect(treasureValueGp(hoard.items) + hoard.coinsGp).toBe(5);
  });

  it("is deterministic for the same seed", () => {
    const a = generateTreasure({ budgetGp: 500, level: 3, seed: 42 });
    const b = generateTreasure({ budgetGp: 500, level: 3, seed: 42 });
    expect(a).toEqual(b);
  });

  it("differs for a different seed", () => {
    const a = generateTreasure({ budgetGp: 500, level: 3, seed: 42 });
    const b = generateTreasure({ budgetGp: 500, level: 3, seed: 43 });
    expect(a).not.toEqual(b);
  });

  it("is never all coins and never one item type", () => {
    for (const budget of [50, 500, 5000]) {
      const hoard = generateTreasure({ budgetGp: budget, level: 8, seed: 11 });
      expect(hoard.coinsGp).toBeLessThan(hoard.totalGp * 0.5);
      expect(hoard.items.length).toBeGreaterThanOrEqual(3);
      const kinds = new Set(hoard.items.map((it) => it.kind));
      expect(kinds.size).toBeGreaterThanOrEqual(3);
    }
  });

  it("never repeats a non-stackable item name in one hoard", () => {
    const hoard = generateTreasure({ budgetGp: 5000, level: 8, seed: 5 });
    const names = hoard.items
      .filter((it) => it.kind !== "gem" && it.kind !== "consumable")
      .map((it) => it.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("generateTreasure > stories", () => {
  it("every item has a non-empty story", () => {
    const hoard = generateTreasure({ budgetGp: 500, level: 3, seed: 9 });
    for (const it of hoard.items) {
      expect(it.story.length).toBeGreaterThan(10);
    }
  });

  it("stories are unique within a hoard", () => {
    const hoard = generateTreasure({ budgetGp: 5000, level: 8, seed: 9 });
    const stories = hoard.items.map((it) => it.story);
    expect(new Set(stories).size).toBe(stories.length);
  });

  it("a theme changes the story flavor", () => {
    const gothic = generateTreasure({ budgetGp: 500, level: 3, seed: 9, theme: "gothic" });
    const dungeon = generateTreasure({ budgetGp: 500, level: 3, seed: 9, theme: "dungeon" });
    // Same seed, same items — but the story text differs by theme.
    expect(gothic.items.map((it) => it.name)).toEqual(dungeon.items.map((it) => it.name));
    expect(gothic.items.map((it) => it.story)).not.toEqual(
      dungeon.items.map((it) => it.story),
    );
  });
});

describe("generateTreasure > signature magic items", () => {
  it("has 1 signature item under 750 gp, 2 at or above", () => {
    const small = generateTreasure({ budgetGp: 500, level: 3, seed: 1 });
    expect(small.signatureItems.length).toBe(1);
    const big = generateTreasure({ budgetGp: 5000, level: 8, seed: 1 });
    expect(big.signatureItems.length).toBe(2);
  });

  it("signature abilities are unique within a hoard and labeled homebrew", () => {
    const hoard = generateTreasure({ budgetGp: 5000, level: 8, seed: 2 });
    const abilities = hoard.signatureItems.map((it) => it.ability);
    for (const ability of abilities) expect(ability!.length).toBeGreaterThan(10);
    expect(new Set(abilities).size).toBe(abilities.length);
    for (const it of hoard.signatureItems) {
      expect(it.homebrew).toBe(true);
      expect(it.kind).toBe("signature");
    }
    expect(formatTreasure(hoard)).toContain("(homebrew)");
  });

  it("signature names are unique within a hoard", () => {
    const hoard = generateTreasure({ budgetGp: 5000, level: 8, seed: 2 });
    const names = hoard.signatureItems.map((it) => it.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("carries the artwork hook: art null, artPrompt ready", () => {
    const hoard = generateTreasure({ budgetGp: 500, level: 3, seed: 4 });
    for (const it of hoard.signatureItems) {
      expect(it.art).toBeNull();
      expect(it.artPrompt).toBeTruthy();
      expect(it.artPrompt!).toContain(it.name);
      expect(it.artPrompt!.toLowerCase()).toContain("no text");
    }
    // Non-signature items carry no art fields at all.
    for (const it of hoard.items) {
      if (it.kind !== "signature") {
        expect(it.art).toBeUndefined();
        expect(it.artPrompt).toBeUndefined();
      }
    }
  });
});

describe("formatTreasure", () => {
  it("mentions the total, the budget, and every item", () => {
    const hoard: TreasureHoard = generateTreasure({ budgetGp: 500, level: 3, seed: 6 });
    const text = formatTreasure(hoard);
    expect(text).toContain("500 gp");
    for (const it of hoard.items) expect(text).toContain(it.name);
  });
});
