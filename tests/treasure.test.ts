import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  fillTreasureChest,
  formatTreasure,
  generateAndFillTreasureChest,
  generateTreasure,
  treasureItemDescription,
  treasureToItemDocs,
  treasureValueGp,
  type TreasureHoard,
  type TreasureItem,
} from "../src/session/treasure.js";
import {
  applyTreasureArt,
  formatTreasureArtPlan,
  formatTreasureArtReport,
  planTreasureArt,
  treasureArtFileName,
} from "../src/session/treasure-art.js";
import type { FoundryLive } from "../src/live.js";

/**
 * A minimal FoundryLive stand-in: only modifyDocument, with behavior
 * injected per test. No connection, no Foundry — the live layer is
 * exercised against the same call shape the real client uses.
 */
function fakeLive(
  impl: (
    type: string,
    action: string,
    operation: Record<string, unknown>,
  ) => Promise<Record<string, unknown>[]>,
): {
  live: FoundryLive;
  calls: { type: string; action: string; operation: Record<string, unknown> }[];
} {
  const calls: {
    type: string;
    action: string;
    operation: Record<string, unknown>;
  }[] = [];
  const live = {
    async modifyDocument(
      type: string,
      action: string,
      operation: Record<string, unknown>,
    ) {
      calls.push({ type, action, operation });
      return impl(type, action, operation);
    },
  } as unknown as FoundryLive;
  return { live, calls };
}

/** A hand-built hoard with one item of every kind, for mapping tests. */
function everyKindHoard(): TreasureHoard {
  const signature: TreasureItem = {
    name: "Emberfang",
    kind: "signature",
    valueGp: 40,
    quantity: 1,
    story: "A signature story.",
    homebrew: true,
    ability: "Once per day, the blade ignites.",
    art: null,
    artPrompt: "Top-down tabletop RPG item art, Emberfang — a longsword whose edge never cools, dungeon style, centered on a plain dark background, square image, no text",
  };
  return {
    targetGp: 104,
    totalGp: 104,
    coinsGp: 7,
    coins: { pp: 0, gp: 7, sp: 0, cp: 0 },
    items: [
      { name: "Topaz", kind: "gem", valueGp: 10, quantity: 2, story: "A gem story." },
      { name: "Jeweled snuffbox", kind: "art", valueGp: 20, quantity: 1, story: "An art story." },
      { name: "Rapier", kind: "weapon", valueGp: 2, quantity: 1, story: "A weapon story." },
      { name: "Chain mail", kind: "armor", valueGp: 6, quantity: 1, story: "An armor story." },
      { name: "Healing Potion (minor)", kind: "consumable", valueGp: 4, quantity: 1, story: "A potion story." },
      { name: "Climbing Kit", kind: "equipment", valueGp: 5, quantity: 1, story: "A kit story." },
      signature,
    ],
    signatureItems: [signature],
    level: 1,
    seed: 1,
    theme: "dungeon",
  };
}

describe("generateTreasure > budget fitting", () => {
  it("lands exactly on the budget at 50 gp", () => {
    const hoard = generateTreasure({ budgetGp: 50, level: 1, seed: 7 });
    expect(hoard.totalGp).toBe(50);
    expect(treasureValueGp(hoard.items) + hoard.coinsGp).toBe(hoard.totalGp);
  });

  it("lands exactly on the budget at 500 gp", () => {
    const hoard = generateTreasure({ budgetGp: 500, level: 3, seed: 7 });
    expect(hoard.totalGp).toBe(500);
    expect(treasureValueGp(hoard.items) + hoard.coinsGp).toBe(hoard.totalGp);
  });

  it("lands exactly on the budget at 5000 gp", () => {
    const hoard = generateTreasure({ budgetGp: 5000, level: 8, seed: 7 });
    expect(hoard.totalGp).toBe(5000);
    expect(treasureValueGp(hoard.items) + hoard.coinsGp).toBe(hoard.totalGp);
  });

  it("still fits a huge budget at a low level (thin pool, signature top-up)", () => {
    const hoard = generateTreasure({ budgetGp: 5000, level: 1, seed: 7 });
    expect(hoard.totalGp).toBe(5000);
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

describe("treasureItemDescription", () => {
  it("carries the story and nothing else for a plain item", () => {
    const item: TreasureItem = {
      name: "Topaz",
      kind: "gem",
      valueGp: 10,
      quantity: 1,
      story: "A gem story.",
    };
    const desc = treasureItemDescription(item);
    expect(desc).toContain("A gem story.");
    expect(desc).not.toContain("homebrew");
  });

  it("labels the homebrew ability for a signature item", () => {
    const hoard = everyKindHoard();
    const sig = hoard.signatureItems[0];
    const desc = treasureItemDescription(sig);
    expect(desc).toContain("A signature story.");
    expect(desc).toContain("homebrew");
    expect(desc).toContain("Once per day, the blade ignites.");
  });
});

describe("treasureToItemDocs", () => {
  it("puts the Coins item first, priced at the loose coins", () => {
    const docs = treasureToItemDocs(everyKindHoard());
    expect(docs[0].name).toBe("Coins");
    expect(docs[0].type).toBe("treasure");
    expect(docs[0].system.price.value).toBe(7);
    expect(docs.length).toBe(everyKindHoard().items.length + 1);
  });

  it("maps every kind to its PF2e item type", () => {
    const docs = treasureToItemDocs(everyKindHoard());
    const byName = new Map(docs.map((d) => [d.name, d.type]));
    expect(byName.get("Topaz")).toBe("treasure");
    expect(byName.get("Jeweled snuffbox")).toBe("treasure");
    expect(byName.get("Rapier")).toBe("weapon");
    expect(byName.get("Chain mail")).toBe("armor");
    expect(byName.get("Healing Potion (minor)")).toBe("consumable");
    expect(byName.get("Climbing Kit")).toBe("equipment");
    // Signature items are unique named homebrew items: "treasure", not a
    // rulebook weapon type the GM never asked for.
    expect(byName.get("Emberfang")).toBe("treasure");
  });

  it("preserves prices and quantities, and the docs sum to the hoard total", () => {
    const hoard = everyKindHoard();
    const docs = treasureToItemDocs(hoard);
    const byName = new Map(docs.map((d) => [d.name, d]));
    expect(byName.get("Topaz")!.system.price.value).toBe(10);
    expect(byName.get("Topaz")!.system.quantity).toBe(2);
    const total = docs.reduce(
      (s, d) => s + d.system.price.value * d.system.quantity,
      0,
    );
    expect(total).toBe(hoard.coinsGp + treasureValueGp(hoard.items));
  });

  it("carries the story and the homebrew ability in the description", () => {
    const docs = treasureToItemDocs(everyKindHoard());
    const byName = new Map(docs.map((d) => [d.name, d]));
    expect(byName.get("Topaz")!.system.description.value).toContain("A gem story.");
    const sig = byName.get("Emberfang")!.system.description.value;
    expect(sig).toContain("A signature story.");
    expect(sig).toContain("homebrew");
    expect(sig).toContain("Once per day, the blade ignites.");
  });

  it("sets img only for a URL art value, never for a local path", () => {
    const withUrl = everyKindHoard();
    withUrl.signatureItems[0] = {
      ...withUrl.signatureItems[0],
      art: "https://example.com/emberfang.png",
    };
    withUrl.items = withUrl.items.map((it) =>
      it.kind === "signature" ? withUrl.signatureItems[0] : it,
    );
    const urlDocs = treasureToItemDocs(withUrl);
    expect(
      urlDocs.find((d) => d.name === "Emberfang")!.img,
    ).toBe("https://example.com/emberfang.png");

    const withLocal = everyKindHoard();
    withLocal.signatureItems[0] = {
      ...withLocal.signatureItems[0],
      art: "treasure-art/treasure-art-emberfang.png",
    };
    withLocal.items = withLocal.items.map((it) =>
      it.kind === "signature" ? withLocal.signatureItems[0] : it,
    );
    const localDocs = treasureToItemDocs(withLocal);
    expect(localDocs.find((d) => d.name === "Emberfang")!.img).toBeUndefined();
  });
});

describe("fillTreasureChest", () => {
  it("places every doc in the chest actor and reports the ids", async () => {
    const hoard = generateTreasure({ budgetGp: 500, level: 3, seed: 7 });
    const docs = treasureToItemDocs(hoard);
    const { live, calls } = fakeLive(async (_t, _a, op) => {
      const data = op.data as unknown[];
      return data.map((_, i) => ({ _id: `item-${i}` }));
    });
    const placement = await fillTreasureChest(live, "chest-123", hoard);
    expect(calls.length).toBe(1);
    expect(calls[0].type).toBe("Item");
    expect(calls[0].action).toBe("create");
    expect(calls[0].operation.parentUuid).toBe("Actor.chest-123");
    expect((calls[0].operation.data as unknown[]).length).toBe(docs.length);
    expect(placement.placedItemIds).toEqual(
      docs.map((_, i) => `item-${i}`),
    );
    expect(placement.placedNames[0]).toBe("Coins");
    expect(placement.failed).toEqual([]);
    expect(placement.placedValueGp).toBe(hoard.totalGp);
  });

  it("reports every item as failed with the reason when the create throws", async () => {
    const hoard = everyKindHoard();
    const { live, calls } = fakeLive(async () => {
      throw new Error("Actor not found");
    });
    const placement = await fillTreasureChest(live, "no-such-chest", hoard);
    expect(calls.length).toBe(1);
    expect(placement.placedItemIds).toEqual([]);
    expect(placement.placedNames).toEqual([]);
    expect(placement.placedValueGp).toBe(0);
    expect(placement.failed.length).toBe(treasureToItemDocs(hoard).length);
    for (const f of placement.failed) {
      expect(f.reason).toContain("Actor not found");
    }
    expect(placement.failed.map((f) => f.name)).toContain("Emberfang");
  });

  it("reports the uncreated tail when Foundry creates fewer docs", async () => {
    const hoard = everyKindHoard();
    const docs = treasureToItemDocs(hoard);
    const { live } = fakeLive(async () => [
      { _id: "item-0" },
      { _id: "item-1" },
    ]);
    const placement = await fillTreasureChest(live, "chest-123", hoard);
    expect(placement.placedItemIds).toEqual(["item-0", "item-1"]);
    expect(placement.placedNames).toEqual([docs[0].name, docs[1].name]);
    expect(placement.failed.length).toBe(docs.length - 2);
    expect(placement.failed[0].name).toBe(docs[2].name);
    expect(placement.failed[0].reason).toContain(
      `created 2 of ${docs.length}`,
    );
  });

  it("reports every item as failed when no chest actor id is given", async () => {
    const hoard = everyKindHoard();
    const { live, calls } = fakeLive(async () => [{ _id: "x" }]);
    const placement = await fillTreasureChest(live, "", hoard);
    expect(calls.length).toBe(0);
    expect(placement.placedItemIds).toEqual([]);
    expect(placement.failed.length).toBe(treasureToItemDocs(hoard).length);
    for (const f of placement.failed) {
      expect(f.reason).toContain("no chest actor id");
    }
  });

  it("reports an empty hoard instead of placing nothing silently", async () => {
    const empty: TreasureHoard = {
      targetGp: 0,
      totalGp: 0,
      coinsGp: 0,
      coins: { pp: 0, gp: 0, sp: 0, cp: 0 },
      items: [],
      signatureItems: [],
      level: 1,
      seed: 1,
      theme: "dungeon",
    };
    const { live, calls } = fakeLive(async () => [{ _id: "x" }]);
    const placement = await fillTreasureChest(live, "chest-123", empty);
    expect(calls.length).toBe(0);
    expect(placement.failed).toEqual([
      { name: "(hoard)", reason: "hoard has no items and no coins — nothing to place" },
    ]);
  });
});

describe("generateAndFillTreasureChest", () => {
  it("generates on budget and places the whole hoard", async () => {
    const { live } = fakeLive(async (_t, _a, op) => {
      const data = op.data as unknown[];
      return data.map((_, i) => ({ _id: `item-${i}` }));
    });
    const { hoard, placement } = await generateAndFillTreasureChest(live, "chest-9", {
      budgetGp: 500,
      level: 3,
      seed: 7,
    });
    expect(hoard.totalGp).toBe(500);
    expect(placement.failed).toEqual([]);
    expect(placement.placedValueGp).toBe(500);
    expect(placement.placedItemIds.length).toBe(
      treasureToItemDocs(hoard).length,
    );
  });
});

describe("treasureArtFileName", () => {
  it("slugifies the item name deterministically", () => {
    expect(
      treasureArtFileName({ name: "Emberfang" } as TreasureItem),
    ).toBe("treasure-art-emberfang.png");
    expect(
      treasureArtFileName({ name: "The Warden's Oath" } as TreasureItem),
    ).toBe("treasure-art-the-wardens-oath.png");
  });
});

describe("planTreasureArt", () => {
  it("marks ready items with their prompt and output path", () => {
    const hoard = generateTreasure({ budgetGp: 500, level: 3, seed: 4 });
    const plan = planTreasureArt(hoard, "treasure-art");
    expect(plan.entries.length).toBe(hoard.signatureItems.length);
    for (const entry of plan.entries) {
      expect(entry.status).toBe("ready");
      expect(entry.artPrompt).toContain(entry.name);
      expect(entry.outputPath).toBe(
        join("treasure-art", treasureArtFileName({ name: entry.name } as TreasureItem)),
      );
    }
  });

  it("marks an item with art already set as has-art", () => {
    const hoard = generateTreasure({ budgetGp: 500, level: 3, seed: 4 });
    const sig = { ...hoard.signatureItems[0], art: "https://example.com/art.png" };
    const withArt: TreasureHoard = {
      ...hoard,
      items: hoard.items.map((it) => (it.kind === "signature" ? sig : it)),
      signatureItems: [sig],
    };
    const plan = planTreasureArt(withArt, "treasure-art");
    expect(plan.entries[0].status).toBe("has-art");
  });

  it("skips an item without an artPrompt and invents no prompt", () => {
    const hoard = everyKindHoard();
    const noPrompt: TreasureItem = {
      ...hoard.signatureItems[0],
      artPrompt: undefined,
    };
    const hoard2: TreasureHoard = {
      ...hoard,
      items: hoard.items.map((it) => (it.kind === "signature" ? noPrompt : it)),
      signatureItems: [noPrompt],
    };
    const plan = planTreasureArt(hoard2, "treasure-art");
    expect(plan.entries[0].status).toBe("skipped-no-prompt");
    expect(plan.entries[0].artPrompt).toBeUndefined();
    expect(plan.entries[0].reason).toContain("no prompt was invented");
  });

  it("formats the plan as the media-step handoff", () => {
    const hoard = generateTreasure({ budgetGp: 500, level: 3, seed: 4 });
    const plan = planTreasureArt(hoard, "treasure-art");
    const text = formatTreasureArtPlan(plan);
    expect(text).toContain(hoard.signatureItems[0].name);
    expect(text).toContain(hoard.signatureItems[0].artPrompt!);
    expect(text).toContain("treasure-art-");
  });
});

describe("applyTreasureArt", () => {
  it("fills art from a file that exists, in both hoard lists", () => {
    const hoard = generateTreasure({ budgetGp: 500, level: 3, seed: 4 });
    const sig = hoard.signatureItems[0];
    const expected = join("treasure-art", treasureArtFileName(sig));
    const result = applyTreasureArt(hoard, "treasure-art", (p) => p === expected);
    expect(result.hoard.signatureItems[0].art).toBe(expected);
    expect(
      result.hoard.items.find((it) => it.name === sig.name)!.art,
    ).toBe(expected);
    expect(result.report[0].status).toBe("filled");
    // The input hoard is not mutated.
    expect(hoard.signatureItems[0].art).toBeNull();
  });

  it("leaves art null and reports missing-file when the file is not there yet", () => {
    const hoard = generateTreasure({ budgetGp: 500, level: 3, seed: 4 });
    const result = applyTreasureArt(hoard, "treasure-art", () => false);
    expect(result.hoard.signatureItems[0].art).toBeNull();
    expect(result.report[0].status).toBe("missing-file");
    expect(result.report[0].reason).toContain("treasure-art-");
  });

  it("skips an item without an artPrompt and says so", () => {
    const hoard = everyKindHoard();
    const noPrompt: TreasureItem = {
      ...hoard.signatureItems[0],
      artPrompt: undefined,
    };
    const hoard2: TreasureHoard = {
      ...hoard,
      items: hoard.items.map((it) => (it.kind === "signature" ? noPrompt : it)),
      signatureItems: [noPrompt],
    };
    const result = applyTreasureArt(hoard2, "treasure-art", () => true);
    expect(result.hoard.signatureItems[0].art).toBeNull();
    expect(result.report[0].status).toBe("skipped-no-prompt");
    expect(result.report[0].reason).toContain("no prompt was invented");
    const text = formatTreasureArtReport(result);
    expect(text).toContain("skipped");
  });

  it("leaves already-set art untouched", () => {
    const hoard = generateTreasure({ budgetGp: 500, level: 3, seed: 4 });
    const sig = { ...hoard.signatureItems[0], art: "https://example.com/art.png" };
    const withArt: TreasureHoard = {
      ...hoard,
      items: hoard.items.map((it) => (it.kind === "signature" ? sig : it)),
      signatureItems: [sig],
    };
    const result = applyTreasureArt(withArt, "treasure-art", () => true);
    expect(result.hoard.signatureItems[0].art).toBe("https://example.com/art.png");
    expect(result.report[0].status).toBe("already-set");
  });
});
