/**
 * Tests for the FR-16 composer hook (BRA-192): applyDressingToSpec
 * merges a plan into a room spec, layoutRoomWithDressing plans +
 * merges + lays out in one call, and resolveDressingPairing pairs
 * the created Tile / AmbientLight _ids back to their items.
 *
 * Pure composition + pairing only — no Foundry, no network. The
 * created ids are faked (`tile-<i>` / `light-<i>`, in layout order),
 * the way buildTileRoom returns them.
 * Run: bun test tests/dressing-hook.test.ts
 */
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
  applyDressingToSpec,
  layoutRoomWithDressing,
  planDressing,
  resolveDressingPairing,
  validateDressingPlan,
  type DressingPlan,
} from "../src/session/dressing.js";
import {
  loadPack,
  type Pack,
  type RoomLayout,
  type RoomSpec,
} from "../src/worldbuilding/tiles-layout.js";

const pack: Pack = loadPack(path.resolve(import.meta.dir, "../tiles/manifest.json"));
const BASE = "worlds/testbed";

function room(over: Partial<RoomSpec> = {}): RoomSpec {
  return { name: "Test Room", gridW: 8, gridH: 8, seed: 1, ...over };
}

/** The dressing id a layout tile carries, or null. */
function tileDressingId(t: RoomLayout["tiles"][number]): string | null {
  const scope = t.flags?.["meroki"];
  if (typeof scope !== "object" || scope === null) return null;
  const id = (scope as Record<string, unknown>).dressingId;
  return typeof id === "string" ? id : null;
}

describe("applyDressingToSpec", () => {
  test("merges lights + dressing into a new spec, input untouched, torches NOT doubled", () => {
    const spec = room({
      dressing: [{ tile: "bones", gx: 2, gy: 2 }],
      lights: [{ x: 150, y: 150, dim: 100, bright: 50, color: "#ffffff" }],
    });
    const plan = planDressing(spec, {});
    expect(plan.items).toHaveLength(14); // 8 torches + 4 braziers + 2 candles
    const { spec: dressed, items } = applyDressingToSpec(spec, plan);
    expect(items).toHaveLength(14);
    // The hand-placed prop and light survive, first in their lists.
    expect(dressed.dressing?.[0]).toEqual({ tile: "bones", gx: 2, gy: 2 });
    expect(dressed.lights?.[0]).toEqual({ x: 150, y: 150, dim: 100, bright: 50, color: "#ffffff" });
    // One light per item — and no torch shorthand: the plan's torch
    // lights ARE the torch lights, so merging spec.torches too would
    // give every torch two lights.
    expect(dressed.torches ?? []).toHaveLength(0);
    expect(dressed.lights).toHaveLength(1 + 14);
    expect(dressed.dressing).toHaveLength(1 + 14);
    // The input spec is never mutated.
    expect(spec.dressing).toHaveLength(1);
    expect(spec.lights).toHaveLength(1);
    expect(spec.torches).toBeUndefined();
  });

  test("throws, listing the problem, for a plan naming another room", () => {
    const plan = planDressing(room(), {});
    expect(() => applyDressingToSpec(room({ name: "Other Room" }), plan)).toThrow(/not "Other Room"/);
  });

  test("throws for a plan with tile gaps instead of building around them", () => {
    const spec = room();
    const plan = planDressing(spec, {});
    const candle = plan.items.find((i) => i.kind === "candle")!;
    const stale: DressingPlan = {
      ...plan,
      items: plan.items.map((i) => (i.id === candle.id ? { ...i, tile: null, tileNeeded: "candle" } : i)),
      tileGaps: ["candle"],
    };
    expect(validateDressingPlan(stale, spec).length).toBeGreaterThan(0);
    expect(() => applyDressingToSpec(spec, stale)).toThrow(/tile gaps: candle/);
  });

  test("throws when a dressing item id collides with a prop the room already has", () => {
    const spec = room({ dressing: [{ tile: "bones", gx: 2, gy: 2, id: "torch-n-1" }] });
    const plan = planDressing(spec, {});
    expect(() => applyDressingToSpec(spec, plan)).toThrow(/collides with a prop id/);
  });
});

describe("layoutRoomWithDressing", () => {
  test("one light per item, each named with its own alpha and dressing id", () => {
    const { plan, layout } = layoutRoomWithDressing(room(), pack, BASE);
    expect(plan.items).toHaveLength(14);
    // Exactly one light per item — no doubling through the shorthand.
    expect(layout.lights).toHaveLength(14);
    for (const item of plan.items) {
      const light = layout.lights.find((l) => l.dressingId === item.id);
      expect(light).toBeDefined();
      expect(light!.dim).toBe(item.light.dim);
      expect(light!.bright).toBe(item.light.bright);
      expect(light!.color).toBe(item.light.color);
      expect(light!.alpha).toBe(item.light.alpha);
      expect(light!.name).toBe(
        item.kind === "torch" ? "the torches" : item.kind === "candle" ? "the candles" : "the braziers",
      );
    }
    const torch = layout.lights.find((l) => l.dressingId === "torch-n-1")!;
    expect(torch.alpha).toBe(0.4);
    const brazier = layout.lights.find((l) => l.dressingId === "brazier-nw")!;
    expect(brazier.alpha).toBe(0.5);
  });

  test("every dressing tile carries flags.meroki.dressingId and the right art", () => {
    const { plan, layout } = layoutRoomWithDressing(room(), pack, BASE);
    const flagged = layout.tiles.filter((t) => tileDressingId(t) !== null);
    expect(flagged).toHaveLength(14);
    expect(flagged.map((t) => tileDressingId(t)).sort()).toEqual(
      plan.items.map((i) => i.id).sort(),
    );
    const srcs = new Set(flagged.map((t) => t.texture.src.split("/").pop()));
    expect(srcs).toEqual(new Set(["sconce.png", "candle.png", "brazier.png"]));
    // A dressing tile is a dressing-layer tile under the tokens.
    for (const t of flagged) expect(t.sort).toBe(20);
  });

  test("the input spec is untouched", () => {
    const spec = room();
    layoutRoomWithDressing(spec, pack, BASE);
    expect(spec.dressing).toBeUndefined();
    expect(spec.lights).toBeUndefined();
    expect(spec.torches).toBeUndefined();
  });
});

describe("resolveDressingPairing", () => {
  function built() {
    const { plan, layout } = layoutRoomWithDressing(room(), pack, BASE);
    const tileIds = layout.tiles.map((_, i) => `tile-${i}`);
    const lightIds = layout.lights.map((_, i) => `light-${i}`);
    return { plan, layout, tileIds, lightIds };
  }

  test("pairs every item with its tile _id and light _id, no errors", () => {
    const { plan, layout, tileIds, lightIds } = built();
    const { pairs, errors } = resolveDressingPairing(plan, layout, tileIds, lightIds);
    expect(errors).toEqual([]);
    expect(pairs).toHaveLength(14);
    for (const item of plan.items) {
      const pair = pairs.find((p) => p.itemId === item.id)!;
      expect(pair).toBeDefined();
      // The tile _id is the _id of the layout tile carrying this id,
      // the light _id the _id of the layout light carrying it — the
      // join is by dressing id, never by position alone.
      const tileIndex = layout.tiles.findIndex((t) => tileDressingId(t) === item.id);
      const lightIndex = layout.lights.findIndex((l) => l.dressingId === item.id);
      expect(pair.tileId).toBe(`tile-${tileIndex}`);
      expect(pair.lightId).toBe(`light-${lightIndex}`);
      expect(pair.tileFlags).toEqual({
        dressingId: item.id,
        lightId: `light-${lightIndex}`,
        kind: item.kind,
        alpha: item.light.alpha,
      });
    }
  });

  test("an id array that does not line up with its layout array is an error", () => {
    const { plan, layout, tileIds, lightIds } = built();
    const short = resolveDressingPairing(plan, layout, tileIds.slice(0, -1), lightIds);
    expect(short.errors.join(" ")).toMatch(/tileIds has .* entries for .* layout tiles/);
    expect(short.pairs.length).toBeLessThan(14);
    const shortLights = resolveDressingPairing(plan, layout, tileIds, lightIds.slice(0, -1));
    expect(shortLights.errors.join(" ")).toMatch(/lightIds has .* entries for .* layout lights/);
  });

  test("a tile whose flag was lost leaves its item unpaired, named in the errors", () => {
    const { plan, layout, tileIds, lightIds } = built();
    const broken: RoomLayout = {
      ...layout,
      tiles: layout.tiles.map((t) =>
        tileDressingId(t) === "torch-n-1" ? { ...t, flags: undefined } : t,
      ),
    };
    const { pairs, errors } = resolveDressingPairing(plan, broken, tileIds, lightIds);
    expect(pairs).toHaveLength(13);
    expect(errors.join(" ")).toMatch(/torch-n-1.*has no tile/);
  });

  test("two tiles carrying one dressing id is an error, not a guess", () => {
    const { plan, layout, tileIds, lightIds } = built();
    const first = layout.tiles.findIndex((t) => tileDressingId(t) === "torch-n-1");
    const dupe: RoomLayout = {
      ...layout,
      tiles: layout.tiles.map((t, i) =>
        i === first + 1 ? { ...t, flags: { meroki: { dressingId: "torch-n-1" } } } : t,
      ),
    };
    const { errors } = resolveDressingPairing(plan, dupe, tileIds, lightIds);
    expect(errors.join(" ")).toMatch(/Two layout tiles carry dressingId "torch-n-1"/);
  });

  test("a light carrying an unknown dressing id is an error", () => {
    const { plan, layout, tileIds, lightIds } = built();
    const ghost: RoomLayout = {
      ...layout,
      lights: layout.lights.map((l, i) => (i === 0 ? { ...l, dressingId: "ghost" } : l)),
    };
    const { errors } = resolveDressingPairing(plan, ghost, tileIds, lightIds);
    expect(errors.join(" ")).toMatch(/dressingId "ghost", which is not an item in this plan/);
  });
});
