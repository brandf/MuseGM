/**
 * Unit tests for the wet-variant floor tiles (BRA-226, FR-13 overlays).
 * Pure composition + manifest checks only — no Foundry, no network.
 * Run: bun test tests/floor-wet.test.ts
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  LAYER_SORT,
  TILE_PX,
  WET_VARIANTS,
  applyOverlay,
  applyWetOverlay,
  carveMazeRegion,
  layoutRoom,
  loadPack,
  wetOverlay,
  type Pack,
  type RoomSpec,
} from "../src/worldbuilding/tiles-layout.js";

const manifestPath = path.resolve(import.meta.dir, "../tiles/manifest.json");
const pack: Pack = loadPack(manifestPath);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
  tiles: { name: string; file: string; sizePx: number; layer: string; tags: string[] }[];
  gaps: unknown[];
};
const BASE = "worlds/testbed";

const hallSpec: RoomSpec = {
  name: "Entry Hall",
  gridW: 8,
  gridH: 6,
  seed: 42,
  doors: [{ wall: "north", at: 3 }],
};

const WET_NAMES = ["floor-wet", "floor-wet-cracked", "floor-wet-rubble", "floor-wet-dark"];
const DRY_NAMES = ["floor-plain", "floor-cracked", "floor-rubble", "floor-dark"];

/** PNG IHDR width/height — the file is a real 100x100 tile, not a stub. */
function pngSize(p: string): { w: number; h: number } {
  const b = fs.readFileSync(p);
  expect(b.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

const floorAt = (layout: ReturnType<typeof layoutRoom>, gx: number, gy: number) =>
  layout.tiles.find(
    (t) => t.x === gx * TILE_PX && t.y === gy * TILE_PX && t.elevation === 0 && t.sort === LAYER_SORT.floor,
  );

describe("floor-wet tiles in the pack", () => {
  it("the pack is 48 tiles with 0 gaps (28 base + 16 props + 4 macro)", () => {
    expect(manifest.tiles).toHaveLength(48);
    expect(manifest.gaps).toHaveLength(0);
    expect(pack.size).toBe(48);
  });

  it("each wet tile is a 100px floor tile tagged wet, with a real PNG on disk", () => {
    for (const name of WET_NAMES) {
      const entry = manifest.tiles.find((t) => t.name === name);
      expect(entry).toBeDefined();
      expect(entry!.sizePx).toBe(100);
      expect(entry!.layer).toBe("floor");
      expect(entry!.tags).toContain("floor");
      expect(entry!.tags).toContain("wet");
      const png = path.resolve(import.meta.dir, "../tiles", entry!.file);
      expect(fs.existsSync(png)).toBe(true);
      expect(pngSize(png)).toEqual({ w: 100, h: 100 });
      expect(pack.get(name)).toBeDefined();
    }
  });

  it("wet tiles keep their dry twin's variant tags", () => {
    expect(manifest.tiles.find((t) => t.name === "floor-wet-cracked")!.tags).toContain("cracked");
    expect(manifest.tiles.find((t) => t.name === "floor-wet-rubble")!.tags).toContain("rubble");
    expect(manifest.tiles.find((t) => t.name === "floor-wet-dark")!.tags).toContain("dark");
  });
});

describe("WET_VARIANTS — the canonical wet map", () => {
  it("covers every dungeon floor and nothing else", () => {
    expect(Object.keys(WET_VARIANTS).sort()).toEqual([...DRY_NAMES].sort());
  });

  it("every wet variant is a real pack tile, and no variant maps to itself", () => {
    for (const [dry, wet] of Object.entries(WET_VARIANTS)) {
      expect(pack.get(wet)).toBeDefined();
      expect(wet).not.toBe(dry);
    }
  });

  it("every wet tile in the manifest is a value in the map (no orphan wet tiles)", () => {
    const values = new Set(Object.values(WET_VARIANTS));
    for (const name of WET_NAMES) {
      expect(values.has(name)).toBe(true);
    }
  });
});

describe("wetOverlay / applyWetOverlay — building a wet region", () => {
  it("defaults to all four dungeon floors", () => {
    const o = wetOverlay(1, 1, 2, 2);
    expect(o).toEqual({ gx: 1, gy: 1, w: 2, h: 2, variants: { ...WET_VARIANTS } });
  });

  it("a subset of bases maps only those floors", () => {
    const o = wetOverlay(0, 0, 1, 1, ["floor-plain"]);
    expect(o.variants).toEqual({ "floor-plain": "floor-wet" });
  });

  it("an unknown base throws, listing the bases that have wet variants", () => {
    expect(() => wetOverlay(0, 0, 1, 1, ["floor-sand"])).toThrow(/No wet variant for "floor-sand"/);
    expect(() => wetOverlay(0, 0, 1, 1, ["floor-sand"])).toThrow(/floor-plain, floor-cracked, floor-rubble, floor-dark/);
    // A western room must fail loudly, never map sand to dungeon wet stone.
    expect(() => wetOverlay(0, 0, 1, 1, ["floor-sand", "floor-plain"])).toThrow(/No wet variant for "floor-sand"/);
  });

  it("empty bases throws", () => {
    expect(() => wetOverlay(0, 0, 1, 1, [])).toThrow(/at least one base/);
  });

  it("applyWetOverlay records the overlay in the spec without mutating it", () => {
    const before = JSON.stringify(hallSpec);
    const spec = applyWetOverlay(hallSpec, 2, 2, 3, 2);
    expect(JSON.stringify(hallSpec)).toBe(before);
    expect(spec.overlays).toHaveLength(1);
    expect(spec.overlays![0].variants).toEqual({ ...WET_VARIANTS });
    expect(spec.overlays![0]).toMatchObject({ gx: 2, gy: 2, w: 3, h: 2 });
  });

  it("rejects regions outside the room", () => {
    expect(() => applyWetOverlay(hallSpec, 7, 5, 2, 2)).toThrow(/outside/);
  });
});

describe("layoutRoom — the wet region renders wet, the rest is untouched", () => {
  it("every floor tile inside the region is wet, every tile outside is identical", () => {
    const base = layoutRoom(hallSpec, pack, BASE);
    const over = layoutRoom(applyWetOverlay(hallSpec, 2, 2, 3, 2), pack, BASE);
    for (let gy = 0; gy < 6; gy++) {
      for (let gx = 0; gx < 8; gx++) {
        const b = floorAt(base, gx, gy);
        const o = floorAt(over, gx, gy);
        const inside = gx >= 2 && gx < 5 && gy >= 2 && gy < 4;
        if (inside) {
          expect(o?.texture.src).toMatch(/floor-wet(-cracked|-rubble|-dark)?\.png$/);
        } else {
          expect(o?.texture.src).toBe(b?.texture.src);
        }
      }
    }
  });

  it("a dark room wets to floor-wet-dark only", () => {
    const spec = applyWetOverlay({ ...hallSpec, floorStyle: "dark" }, 0, 0, 8, 6);
    const layout = layoutRoom(spec, pack, BASE);
    const floor = layout.tiles.filter((t) => t.elevation === 0 && t.sort === LAYER_SORT.floor);
    expect(floor).toHaveLength(8 * 6);
    expect(floor.every((t) => t.texture.src.endsWith("floor-wet-dark.png"))).toBe(true);
  });

  it("a later overlay wins: wet, then wet->plain restores dry in the overlap", () => {
    const wet = applyWetOverlay(hallSpec, 1, 1, 4, 4);
    const restore = applyOverlay(wet, {
      gx: 2,
      gy: 2,
      w: 2,
      h: 2,
      variants: {
        "floor-wet": "floor-plain",
        "floor-wet-cracked": "floor-plain",
        "floor-wet-rubble": "floor-plain",
        "floor-wet-dark": "floor-plain",
      },
    });
    const layout = layoutRoom(restore, pack, BASE);
    const base = layoutRoom(hallSpec, pack, BASE);
    // A cell in the overlap that rolled plain ends dry again; a cell in
    // the wet-only ring that rolled plain stays wet.
    const overlapPlain = [2, 3].flatMap((gx) => [2, 3].map((gy) => [gx, gy] as const)).find(([gx, gy]) =>
      floorAt(base, gx, gy)?.texture.src.endsWith("floor-plain.png"),
    );
    expect(overlapPlain).toBeDefined();
    const [ox, oy] = overlapPlain!;
    expect(floorAt(layout, ox, oy)?.texture.src.endsWith("floor-plain.png")).toBe(true);
    const wetOnlyPlain = [[1, 1], [4, 1], [1, 4], [4, 4]].find(([gx, gy]) =>
      floorAt(base, gx, gy)?.texture.src.endsWith("floor-plain.png"),
    );
    expect(wetOnlyPlain).toBeDefined();
    const [wx, wy] = wetOnlyPlain!;
    expect(floorAt(layout, wx, wy)?.texture.src.endsWith("floor-wet.png")).toBe(true);
  });

  it("maze wall cells still get no floor tile under a wet overlay", () => {
    // Maze region on rows 2-4: the north door's entry cell (3,1) stays
    // walkable, as layoutRoom requires.
    const maze = carveMazeRegion(hallSpec, { gx: 1, gy: 2, w: 5, h: 3, seed: 5 });
    const spec = applyWetOverlay(maze, 0, 0, 8, 6);
    const layout = layoutRoom(spec, pack, BASE);
    const base = layoutRoom(maze, pack, BASE);
    for (let gy = 0; gy < 6; gy++) {
      for (let gx = 0; gx < 8; gx++) {
        const b = floorAt(base, gx, gy);
        const o = floorAt(layout, gx, gy);
        if (!b) {
          expect(o).toBeUndefined();
        } else {
          expect(o?.texture.src).toMatch(/floor-wet(-cracked|-rubble|-dark)?\.png$/);
        }
      }
    }
  });
});
