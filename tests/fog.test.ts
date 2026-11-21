/**
 * Tests for the dungeon's green eerie fog (BRA-223, STYLE.md):
 *
 * - The fog tiles are green smoke, not the grey-white smoke of the
 *   first Nov 19 version — the green must survive regeneration.
 * - The fog is present at table scale (100px per square): the old
 *   build drew at 100px then 4x-upscaled, which blurred the large
 *   wisp to almost nothing.
 * - The fog is atmosphere, not a whiteout: the floor stays readable
 *   through it, and no pixel is fully opaque.
 * - Fog never touches a tile edge, so neighbours butt seamlessly.
 * - Western dust shares the generator but stays tan, not green.
 *
 * Pixel checks only — no Foundry, no network.
 * Run: bun test tests/fog.test.ts
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

const manifestPath = path.resolve(import.meta.dir, "../tiles/manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
  tiles: { name: string; file: string; sizePx: number; layer: string; kind: string; tags: string[] }[];
  gaps: unknown[];
};

/** Decode a PNG to raw pixels (8-bit, colour types 2 and 6). Same
 *  approach as tests/pack-structure.test.ts. */
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

interface FogStats {
  meanAlpha: number;
  maxAlpha: number;
  fracOver80: number;
  fracAt200: number;
  meanR: number;
  meanG: number;
  meanB: number;
  cornerAlphas: number[];
  borderMeanAlpha: number;
}

function fogStats(name: string): FogStats {
  const entry = manifest.tiles.find((t) => t.name === name);
  expect(entry).toBeDefined();
  const { w, h, colorType, data } = pngPixels(
    path.resolve(import.meta.dir, "../tiles", entry!.file),
  );
  expect(colorType).toBe(6); // fog carries real transparency
  expect(w).toBe(entry!.sizePx);
  expect(h).toBe(entry!.sizePx);
  const n = w * h;
  let alphaSum = 0;
  let maxAlpha = 0;
  let over80 = 0;
  let at200 = 0;
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let vis = 0;
  let borderSum = 0;
  let borderN = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = data[i + 3];
      alphaSum += a;
      if (a > maxAlpha) maxAlpha = a;
      if (a > 80) over80++;
      if (a >= 200) at200++;
      if (a > 40) {
        rSum += data[i];
        gSum += data[i + 1];
        bSum += data[i + 2];
        vis++;
      }
      if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) {
        borderSum += a;
        borderN++;
      }
    }
  }
  const at = (x: number, y: number) => data[(y * w + x) * 4 + 3];
  return {
    meanAlpha: alphaSum / n,
    maxAlpha,
    fracOver80: over80 / n,
    fracAt200: at200 / n,
    meanR: vis ? rSum / vis : 0,
    meanG: vis ? gSum / vis : 0,
    meanB: vis ? bSum / vis : 0,
    cornerAlphas: [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)],
    borderMeanAlpha: borderSum / borderN,
  };
}

const FOG_TILES = ["fog-wisp-small", "fog-wisp-large", "fog-pool"] as const;

describe("green eerie fog", () => {
  it("the three fog tiles are atmosphere base tiles at their declared sizes", () => {
    const expected: Record<string, number> = {
      "fog-wisp-small": 200,
      "fog-wisp-large": 400,
      "fog-pool": 400,
    };
    for (const name of FOG_TILES) {
      const entry = manifest.tiles.find((t) => t.name === name);
      expect(entry).toBeDefined();
      expect(entry!.sizePx).toBe(expected[name]);
      expect(entry!.layer).toBe("atmosphere");
      expect(entry!.kind).toBe("base");
      expect(entry!.tags).toContain("fog");
      expect(entry!.tags).toContain("green");
    }
  });

  it("is green, not grey-white — green clearly dominates red and blue", () => {
    for (const name of FOG_TILES) {
      const s = fogStats(name);
      expect(s.meanG - s.meanR).toBeGreaterThanOrEqual(20);
      expect(s.meanG).toBeGreaterThan(s.meanB);
    }
  });

  it("is present at table scale — dense enough to see at 100px per square", () => {
    for (const name of FOG_TILES) {
      const s = fogStats(name);
      expect(s.maxAlpha).toBeGreaterThanOrEqual(140);
      expect(s.fracOver80).toBeGreaterThanOrEqual(0.15);
    }
  });

  it("is atmosphere, not a whiteout — the floor stays readable through it", () => {
    for (const name of FOG_TILES) {
      const s = fogStats(name);
      expect(s.meanAlpha).toBeLessThanOrEqual(90);
      expect(s.fracAt200).toBeLessThan(0.02);
    }
  });

  it("never touches a tile edge, so neighbours butt seamlessly", () => {
    for (const name of FOG_TILES) {
      const s = fogStats(name);
      expect(s.cornerAlphas).toEqual([0, 0, 0, 0]);
      expect(s.borderMeanAlpha).toBeLessThan(10);
    }
  });

  it("western dust shares the generator but stays tan, not green", () => {
    for (const name of ["dust-wisp-large", "dust-pool"]) {
      const s = fogStats(name);
      expect(s.meanR).toBeGreaterThan(s.meanG);
    }
  });
});
