/**
 * Tile composer — PURE composition math (no Foundry, no network).
 *
 * Kept in its own module so the layout math is unit-testable without
 * importing the live client: importing `tiles.ts` pulls in the vendored
 * MCP client, which validates its config (FOUNDRY_URL et al) at import
 * time and breaks plain `bun test` runs. The live build functions
 * (buildTileRoom / rebuildTileRoom / uploadTilePack) live in `tiles.ts`
 * and import from here.
 *
 * The pack is generated once (tiles/procedural/generate_tiles.py) and
 * uploaded once. After that a room is just data: a room spec (grid size,
 * doors, dressing, fog) lays out Tile documents, Wall documents and
 * lights. Resizing a room is changing `gridW`/`gridH` in the spec — no
 * new images, no upload.
 *
 * Layers (BACKLOG.md, Brandon Nov 19) — elevation AND sort, because
 * Foundry only sorts tiles against siblings at the same elevation
 * (a higher-elevation tile always draws above a lower one):
 * - floor:     elevation 0, sort 0   — the plain floor grid
 * - wall:      elevation 0, sort 10  — the visual wall ring (transparent
 *   tiles whose band sits at the room's edge), above the floor
 * - dressing:  elevation 0, sort 20  — bones, rubble, pillars, ritual
 *   marks; movable/removable on their own, under the tokens
 * - atmosphere: elevation 1, sort 0  — fog wisps above everything,
 *   including tokens (overhead fog); toggleable via `hidden`
 *
 * Tile document shape (Foundry 13+/14, fvtt-types TileDocument schema):
 * { texture: { src }, x, y, width, height, elevation, sort, rotation,
 *   alpha, hidden, locked, flags }. The image lives in `texture.src`
 *   (v13+); the old `img` field is gone. `x`/`y` are the top-left corner.
 * Rotation is clockwise degrees around the tile centre — a square tile
 * rotated 90/180/270 stays exactly on its cell, which is how one wall
 * image serves all four sides.
 *
 * Tile unit: 100px = 1 grid square (grid size 100). Floor/wall tiles
 * are 100x100; dressing is 200x200 (2x2 squares); fog is 200x200 or
 * 400x400. The composer places everything in scene pixel coordinates.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { LightSpec, WallSpec } from "./index.js";

/** One grid square, in pixels. */
export const TILE_PX = 100;

/** Sort orders within the floor elevation (see the header comment). */
export const LAYER_SORT = { floor: 0, wall: 10, dressing: 20 } as const;
/** Fog floats above the tokens. */
export const FOG_ELEVATION = 1;

/** Warm torchlight defaults (STYLE.md / the Lich's Lair lighting fix). */
export const TORCH = { dim: 300, bright: 120, color: "#ff9a3c" } as const;
/** The plain dark colour a tile room's Level background is painted. */
export const ROOM_BACKGROUND_COLOR = "#050508";

export type TileLayer = "floor" | "dressing" | "atmosphere";

/** One entry in tiles/manifest.json. */
export interface PackEntry {
  name: string;
  /** Path relative to the tiles/ dir, e.g. "pack/floor-plain.png". */
  file: string;
  /** Tile size in px (square). */
  sizePx: number;
  layer: TileLayer;
  tags: string[];
}

/** tiles/manifest.json as parsed. */
export interface PackManifest {
  version: number;
  tilePx: number;
  tiles: PackEntry[];
  gaps: { name: string; reason: string; needs: string }[];
}

/** A pack, indexed by tile name. */
export type Pack = Map<string, PackEntry>;

export function packFromManifest(manifest: PackManifest): Pack {
  return new Map(manifest.tiles.map((t) => [t.name, t]));
}

/** Load tiles/manifest.json (default: the repo's own manifest). */
export function loadPack(manifestPath?: string): Pack {
  const p =
    manifestPath ??
    path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../tiles/manifest.json");
  const manifest = JSON.parse(fs.readFileSync(p, "utf8")) as PackManifest;
  if (manifest.tilePx !== TILE_PX) {
    throw new Error(
      `Manifest tilePx is ${manifest.tilePx}, composer expects ${TILE_PX}. Regenerate the pack.`,
    );
  }
  return packFromManifest(manifest);
}

export type WallSide = "north" | "south" | "east" | "west";

/** A door in a wall: `at` is the cell index along that wall (0-based). */
export interface DoorSpec {
  wall: WallSide;
  /** Cell along the wall, 1..n-2 — doors may not sit in a corner. */
  at: number;
}

/** One dressing/fog placement: top-left cell of the tile. */
export interface Placement {
  tile: string;
  gx: number;
  gy: number;
  /** Clockwise degrees. Default 0. */
  rotation?: number;
  /** Tile opacity 0..1. Default 1 (the PNG carries its own alpha). */
  alpha?: number;
  /** Hidden tiles are GM-only until shown. Default false. */
  hidden?: boolean;
}

export interface RoomSpec {
  name: string;
  /** Room width in grid squares (100px each). Minimum 3. */
  gridW: number;
  /** Room height in grid squares. Minimum 3. */
  gridH: number;
  /** Deterministic floor-variant seed. Default 1. */
  seed?: number;
  /** Floor style: "mixed" (plain/cracked/rubble at random) or "dark"
   *  (the colder, darker floor for deeper rooms). Default "mixed". */
  floorStyle?: "mixed" | "dark";
  doors?: DoorSpec[];
  dressing?: Placement[];
  fog?: Placement[];
  /** Torch positions (cell coords) — shorthand for warm amber lights. */
  torches?: { gx: number; gy: number }[];
  /** Full light specs (use instead of, or as well as, `torches`). */
  lights?: LightSpec[];
  /** Room description posted to chat when the room is built. */
  description?: string;
}

/** One Tile document, as sent to Foundry. */
export interface TileDoc {
  texture: { src: string };
  x: number;
  y: number;
  width: number;
  height: number;
  elevation: number;
  sort: number;
  rotation: number;
  alpha: number;
  hidden: boolean;
  locked: boolean;
}

export interface RoomLayout {
  /** Scene size in px. */
  width: number;
  height: number;
  /** Every tile to create, in creation order (floor, wall, dressing, fog). */
  tiles: TileDoc[];
  /** Collision walls for the room perimeter, with door segments. */
  walls: WallSpec[];
  /** Lights for the room (torches expanded + explicit lights). */
  lights: LightSpec[];
}

/** Small deterministic PRNG (mulberry32) so a spec always lays out the same room. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Clockwise rotation (degrees) of the wall band image for a wall side.
 *  The images are drawn with the band at the TOP: north 0, east 90,
 *  south 180, west 270. */
export function wallRotation(side: WallSide): number {
  return { north: 0, east: 90, south: 180, west: 270 }[side];
}

/** Clockwise rotation of the corner image (drawn with bands at TOP and
 *  LEFT, i.e. the north-west corner) for a given corner. */
export function cornerRotation(corner: "nw" | "ne" | "se" | "sw"): number {
  return { nw: 0, ne: 90, se: 180, sw: 270 }[corner];
}

function cellsAlong(side: WallSide, gridW: number, gridH: number): number {
  return side === "north" || side === "south" ? gridW : gridH;
}

/** Split one wall side into plain segments and door segments.
 *  Returns segments as [firstCell, lastCellInclusive, isDoor]. */
function splitWall(cells: number, doorsAt: number[]): [number, number, boolean][] {
  const doorSet = new Set(doorsAt);
  const segs: [number, number, boolean][] = [];
  let i = 0;
  while (i < cells) {
    if (doorSet.has(i)) {
      segs.push([i, i, true]);
      i += 1;
    } else {
      let j = i;
      while (j + 1 < cells && !doorSet.has(j + 1)) j += 1;
      segs.push([i, j, false]);
      i = j + 1;
    }
  }
  return segs;
}

/** Collision-wall coordinates for one segment of a wall side. */
function wallCoords(
  side: WallSide,
  first: number,
  last: number,
  width: number,
  height: number,
): WallSpec {
  const a = first * TILE_PX;
  const b = (last + 1) * TILE_PX;
  switch (side) {
    case "north": return { x1: a, y1: 0, x2: b, y2: 0 };
    case "south": return { x1: a, y1: height, x2: b, y2: height };
    case "west": return { x1: 0, y1: a, x2: 0, y2: b };
    case "east": return { x1: width, y1: a, x2: width, y2: b };
  }
}

/** Which cell (gx, gy) a wall-side cell sits in, and its rotation. */
function wallCell(
  side: WallSide,
  at: number,
  gridW: number,
  gridH: number,
): { gx: number; gy: number; rotation: number } {
  switch (side) {
    case "north": return { gx: at, gy: 0, rotation: 0 };
    case "south": return { gx: at, gy: gridH - 1, rotation: 180 };
    case "west": return { gx: 0, gy: at, rotation: 270 };
    case "east": return { gx: gridW - 1, gy: at, rotation: 90 };
  }
}

function validateSpec(spec: RoomSpec, pack: Pack): void {
  const { gridW, gridH } = spec;
  if (!Number.isInteger(gridW) || !Number.isInteger(gridH) || gridW < 3 || gridH < 3) {
    throw new Error(`Room must be at least 3x3 grid squares, got ${gridW}x${gridH}.`);
  }
  const doors = spec.doors ?? [];
  for (const d of doors) {
    const n = cellsAlong(d.wall, gridW, gridH);
    if (!Number.isInteger(d.at) || d.at < 1 || d.at > n - 2) {
      throw new Error(
        `Door on ${d.wall} at cell ${d.at} is out of range 1..${n - 2} (doors may not sit in a corner).`,
      );
    }
  }
  const seenDoors = new Set(doors.map((d) => `${d.wall}:${d.at}`));
  if (seenDoors.size !== doors.length) throw new Error("Duplicate door in room spec.");
  const checkPlacement = (p: Placement, kind: string) => {
    const entry = pack.get(p.tile);
    if (!entry) throw new Error(`Unknown ${kind} tile "${p.tile}" — not in the pack manifest.`);
    const cells = entry.sizePx / TILE_PX;
    if (!Number.isInteger(p.gx) || !Number.isInteger(p.gy) || p.gx < 0 || p.gy < 0 ||
        p.gx + cells > gridW || p.gy + cells > gridH) {
      throw new Error(
        `${kind} tile "${p.tile}" at (${p.gx},${p.gy}) does not fit in a ${gridW}x${gridH} room.`,
      );
    }
    if (p.alpha !== undefined && (p.alpha < 0 || p.alpha > 1)) {
      throw new Error(`Alpha for "${p.tile}" must be 0..1, got ${p.alpha}.`);
    }
  };
  for (const p of spec.dressing ?? []) checkPlacement(p, "dressing");
  for (const p of spec.fog ?? []) checkPlacement(p, "fog");
  for (const t of spec.torches ?? []) {
    if (t.gx < 0 || t.gx >= gridW || t.gy < 0 || t.gy >= gridH) {
      throw new Error(`Torch at (${t.gx},${t.gy}) is outside a ${gridW}x${gridH} room.`);
    }
  }
}

function tileDoc(
  entry: PackEntry,
  serverBase: string,
  gx: number,
  gy: number,
  opts: { elevation: number; sort: number; rotation?: number; alpha?: number; hidden?: boolean },
): TileDoc {
  return {
    texture: { src: `${serverBase}/${path.basename(entry.file)}` },
    x: gx * TILE_PX,
    y: gy * TILE_PX,
    width: entry.sizePx,
    height: entry.sizePx,
    elevation: opts.elevation,
    sort: opts.sort,
    rotation: opts.rotation ?? 0,
    alpha: opts.alpha ?? 1,
    hidden: opts.hidden ?? false,
    locked: false,
  };
}

/**
 * Pure composition: turn a room spec + pack into the exact Tile, Wall
 * and Light documents for the room. No Foundry involved — unit-testable.
 * Deterministic for a given spec (floor variants come from a seeded RNG).
 *
 * @param serverBase server folder the pack was uploaded to,
 *   e.g. "worlds/testbed" — tile srcs are `${serverBase}/<file>`.
 */
export function layoutRoom(spec: RoomSpec, pack: Pack, serverBase: string): RoomLayout {
  validateSpec(spec, pack);
  const { gridW, gridH } = spec;
  const width = gridW * TILE_PX;
  const height = gridH * TILE_PX;
  const tiles: TileDoc[] = [];
  const rng = mulberry32(spec.seed ?? 1);

  // Floor: one tile per cell. "mixed" rolls plain/cracked/rubble;
  // "dark" uses the cold dark floor for the whole room.
  const floorNames =
    spec.floorStyle === "dark" ? ["floor-dark"] : ["floor-plain", "floor-plain", "floor-plain", "floor-plain", "floor-plain", "floor-plain", "floor-cracked", "floor-cracked", "floor-cracked", "floor-rubble"];
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      const name = floorNames[Math.floor(rng() * floorNames.length)];
      const entry = pack.get(name);
      if (!entry) throw new Error(`Pack is missing floor tile "${name}".`);
      tiles.push(tileDoc(entry, serverBase, gx, gy, { elevation: 0, sort: LAYER_SORT.floor }));
    }
  }

  // Wall ring: corners + straights, with door tiles where the spec puts doors.
  const doors = spec.doors ?? [];
  const doorAt = new Map<string, boolean>();
  for (const d of doors) doorAt.set(`${d.wall}:${d.at}`, true);
  const corners: ["nw" | "ne" | "se" | "sw", number, number][] = [
    ["nw", 0, 0],
    ["ne", gridW - 1, 0],
    ["se", gridW - 1, gridH - 1],
    ["sw", 0, gridH - 1],
  ];
  const cornerEntry = pack.get("wall-corner");
  const straightEntry = pack.get("wall-straight");
  const doorEntry = pack.get("wall-door");
  if (!cornerEntry || !straightEntry || !doorEntry) {
    throw new Error('Pack is missing a wall tile ("wall-corner", "wall-straight" or "wall-door").');
  }
  for (const [corner, gx, gy] of corners) {
    tiles.push(tileDoc(cornerEntry, serverBase, gx, gy, {
      elevation: 0, sort: LAYER_SORT.wall, rotation: cornerRotation(corner),
    }));
  }
  for (const side of ["north", "south", "east", "west"] as WallSide[]) {
    const n = cellsAlong(side, gridW, gridH);
    for (let at = 1; at <= n - 2; at++) {
      const { gx, gy, rotation } = wallCell(side, at, gridW, gridH);
      const isDoor = doorAt.has(`${side}:${at}`);
      tiles.push(tileDoc(isDoor ? doorEntry : straightEntry, serverBase, gx, gy, {
        elevation: 0, sort: LAYER_SORT.wall, rotation,
      }));
    }
  }

  // Dressing: bones, rubble, pillars — under the tokens, above the floor.
  for (const p of spec.dressing ?? []) {
    const entry = pack.get(p.tile);
    if (!entry) throw new Error(`Unknown dressing tile "${p.tile}".`);
    tiles.push(tileDoc(entry, serverBase, p.gx, p.gy, {
      elevation: 0, sort: LAYER_SORT.dressing, rotation: p.rotation, alpha: p.alpha, hidden: p.hidden,
    }));
  }

  // Atmosphere: fog wisps float above everything (elevation 1), so they
  // drift over tokens too. Toggleable with `hidden`.
  for (const p of spec.fog ?? []) {
    const entry = pack.get(p.tile);
    if (!entry) throw new Error(`Unknown fog tile "${p.tile}".`);
    tiles.push(tileDoc(entry, serverBase, p.gx, p.gy, {
      elevation: FOG_ELEVATION, sort: 0, rotation: p.rotation, alpha: p.alpha, hidden: p.hidden,
    }));
  }

  // Collision walls: the perimeter, split around the door cells. A door
  // cell becomes a door segment (door: 1); the rest are plain walls.
  const walls: WallSpec[] = [];
  for (const side of ["north", "south", "east", "west"] as WallSide[]) {
    const n = cellsAlong(side, gridW, gridH);
    const doorsHere = doors.filter((d) => d.wall === side).map((d) => d.at);
    for (const [first, last, isDoor] of splitWall(n, doorsHere)) {
      walls.push({ ...wallCoords(side, first, last, width, height), door: isDoor ? 1 : 0 });
    }
  }

  // Lights: torch shorthand (warm amber pools) + explicit light specs.
  const lights: LightSpec[] = [
    ...(spec.torches ?? []).map((t) => ({
      x: t.gx * TILE_PX + TILE_PX / 2,
      y: t.gy * TILE_PX + TILE_PX / 2,
      dim: TORCH.dim,
      bright: TORCH.bright,
      color: TORCH.color,
    })),
    ...(spec.lights ?? []),
  ];

  return { width, height, tiles, walls, lights };
}
