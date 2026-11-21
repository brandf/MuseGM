/**
 * Tests for the three-kind tile pack (tile redesign, Nov 2026):
 * base tiles (clean material only), macro pieces (multi-square
 * assemblies) and prop sprites (free dressing images).
 *
 * - Every manifest entry carries a kind: base | macro | prop.
 * - Base tiles are 0 gaps; every PNG exists at its declared square size.
 * - Floor/wall base tiles are opaque (except the diagonal wall, which
 *   is a band in a square tile); atmosphere and dressing tiles carry
 *   real transparency.
 * - Every dressing tile is placeable through listPropTiles, and a
 *   macro piece places in a room via layoutRoom — and one that does
 *   not fit throws.
 *
 * Pure composition + manifest checks only — no Foundry, no network.
 * Run: bun test tests/pack-structure.test.ts
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import {
  LAYER_SORT,
  layoutRoom,
  listPropTiles,
  loadPack,
  type Pack,
  type RoomSpec,
} from "../src/worldbuilding/tiles-layout.js";

const manifestPath = path.resolve(import.meta.dir, "../tiles/manifest.json");
const pack: Pack = loadPack(manifestPath);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
  tiles: { name: string; file: string; sizePx: number; layer: string; kind: string; tags: string[] }[];
  gaps: unknown[];
};
const BASE = "worlds/testbed";

/** Decode a PNG to raw pixels (8-bit, colour types 2 and 6). */
function pngPixels(p: string): { w: number; h: number; colorType: number; data: Buffer } {
  const b = fs.readFileSync(p);
  expect(b.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  let off = 8;
  let w = 0;
  let h = 0;
  let colorType = 0;
  const idats: Buffer[] = [];
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString("ascii", off + 4, off + 8);
    const data = b.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      expect(data[8]).toBe(8); // 8-bit
      colorType = data[9];
      expect([2, 6]).toContain(colorType);
    } else if (type === "IDAT") {
      idats.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idats));
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const bb = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + bb) & 255;
      else if (filter === 3) v = (v + ((a + bb) >> 1)) & 255;
      else if (filter === 4) {
        const pa = Math.abs(bb - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + bb - 2 * c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? bb : c)) & 255;
      }
      cur[x] = v;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { w, h, colorType, data: out };
}

/** Fraction of pixels with alpha < 255 (0 for RGB images). */
function transparentFraction(p: string): number {
  const { colorType, data } = pngPixels(p);
  if (colorType !== 6) return 0;
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) transparent++;
  }
  return transparent / (data.length / 4);
}

const tilePath = (name: string) =>
  path.resolve(import.meta.dir, "../tiles", manifest.tiles.find((t) => t.name === name)!.file);

describe("the three-kind pack", () => {
  it("is 48 tiles: 28 base + 16 props + 4 macro, 0 gaps", () => {
    expect(manifest.tiles).toHaveLength(48);
    expect(manifest.gaps).toHaveLength(0);
    expect(pack.size).toBe(48);
    const kinds = manifest.tiles.reduce<Record<string, number>>((acc, t) => {
      acc[t.kind] = (acc[t.kind] ?? 0) + 1;
      return acc;
    }, {});
    expect(kinds).toEqual({ base: 28, prop: 16, macro: 4 });
  });

  it("every entry has a kind, a real PNG on disk at its declared square size", () => {
    for (const entry of manifest.tiles) {
      expect(["base", "macro", "prop"]).toContain(entry.kind);
      const png = path.resolve(import.meta.dir, "../tiles", entry.file);
      expect(fs.existsSync(png)).toBe(true);
      const { w, h } = pngPixels(png);
      expect(w).toBe(entry.sizePx);
      expect(h).toBe(entry.sizePx);
      expect(pack.get(entry.name)).toBeDefined();
    }
  });

  it("floor and wall base tiles are opaque — except the diagonal wall and the doors", () => {
    // wall-diagonal is a band in a square tile (transparent corners);
    // the door tiles are transparent in the opening above the door
    // leaves — the passage through the wall, showing the floor beneath.
    const transparentByDesign = new Set(["wall-diagonal", "wall-door", "wall-wood-door"]);
    for (const entry of manifest.tiles) {
      if (entry.layer !== "floor") continue;
      if (transparentByDesign.has(entry.name)) {
        expect(transparentFraction(tilePath(entry.name))).toBeGreaterThan(0.05);
        continue;
      }
      expect(transparentFraction(tilePath(entry.name))).toBe(0);
    }
  });

  it("atmosphere and dressing tiles carry real transparency", () => {
    for (const entry of manifest.tiles) {
      if (entry.layer !== "atmosphere" && entry.layer !== "dressing") continue;
      // At least 5% transparent pixels: the sprite sits on transparency,
      // it is not a filled square.
      expect(transparentFraction(tilePath(entry.name))).toBeGreaterThanOrEqual(0.05);
    }
  });

  it("wall tiles are 100x100, macro pieces are dressing-layer 200 or 300", () => {
    for (const entry of manifest.tiles) {
      if (entry.name.startsWith("wall-") && entry.kind === "base") expect(entry.sizePx).toBe(100);
      if (entry.kind === "macro") {
        expect(entry.layer).toBe("dressing");
        expect([200, 300]).toContain(entry.sizePx);
      }
      if (entry.kind === "prop") expect(entry.layer).toBe("dressing");
    }
  });
});

describe("macro pieces in the composer", () => {
  const spec: RoomSpec = {
    name: "Macro Room",
    gridW: 8,
    gridH: 6,
    seed: 42,
    doors: [{ wall: "south", at: 3 }],
    dressing: [
      { tile: "dais-round", gx: 1, gy: 1 },
      { tile: "pool-round", gx: 4, gy: 1 },
      { tile: "column-broken", gx: 1, gy: 3 },
      { tile: "wall-curved", gx: 4, gy: 3 },
    ],
  };

  it("every dressing tile is in listPropTiles", () => {
    const props = listPropTiles(pack);
    expect(props).toHaveLength(20);
    for (const entry of manifest.tiles) {
      if (entry.layer === "dressing") expect(props).toContain(entry.name);
    }
  });

  it("a macro piece places at its cell, at its declared size", () => {
    const layout = layoutRoom(spec, pack, BASE);
    const dressing = layout.tiles.filter((t) => t.sort === LAYER_SORT.dressing);
    expect(dressing).toHaveLength(4);
    const bySrc = new Map(dressing.map((t) => [t.texture.src.split("/").pop(), t]));
    const dais = bySrc.get("dais-round.png")!;
    expect([dais.x, dais.y, dais.width, dais.height]).toEqual([100, 100, 200, 200]);
    const curved = bySrc.get("wall-curved.png")!;
    expect([curved.x, curved.y, curved.width, curved.height]).toEqual([400, 300, 300, 300]);
  });

  it("a macro piece that does not fit throws", () => {
    // wall-curved is 3 cells wide: at (6,4) it would run past the 8-wide room.
    const bad: RoomSpec = {
      ...spec,
      dressing: [{ tile: "wall-curved", gx: 6, gy: 4 }],
    };
    expect(() => layoutRoom(bad, pack, BASE)).toThrow(/does not fit/);
  });
});
