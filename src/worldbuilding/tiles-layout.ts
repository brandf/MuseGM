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
import {
  generateMaze,
  mulberry32,
  oppositeSide,
  toSquares,
  type LengthUnit,
  type MazeGrid,
} from "./maze.js";
export { mulberry32 } from "./maze.js";

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

/** A door in a wall: `at` is the cell index along that wall (0-based).
 *  `secret` (FR-1/FR-8): a hidden door — the wall tile looks like a
 *  plain wall and the collision segment is a secret door (door: 2),
 *  so the party only finds it by searching. */
export interface DoorSpec {
  wall: WallSide;
  /** Cell along the wall, 1..n-2 — doors may not sit in a corner. */
  at: number;
  secret?: boolean;
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

/**
 * A maze region inside a room (FR-12): a rectangle of room cells turned
 * into a seeded perfect maze by `generateMaze`. `w`/`h` are the region
 * size in room cells and must be odd and >= 3 — a region of w x h cells
 * holds a maze of (w-1)/2 x (h-1)/2 cells. The region sits strictly
 * inside the room (one cell of margin from the room's edge) so the wall
 * ring never collides with maze walls; the party walks in through the
 * entrance opening on the region's border.
 */
export interface MazeRegionSpec {
  /** Top-left cell of the region in room grid coords. */
  gx: number;
  gy: number;
  /** Region width/height in cells. Odd, >= 3. */
  w: number;
  h: number;
  /** Deterministic maze seed. Default 1. */
  seed?: number;
  /** Which border side the entrance opening is on. Default: the side
   *  of the room's first door (where the party came in), else north. */
  entrance?: WallSide;
  /** Cell index along the entrance side (0..cells-1). Default: middle. */
  entranceAt?: number;
  /** Which border side the exit opening is on. Default: opposite the
   *  entrance. */
  exit?: WallSide;
  /** Cell index along the exit side (0..cells-1). Default: middle. */
  exitAt?: number;
  /** Floor style inside the maze. Default: the room's floorStyle. */
  floorStyle?: "mixed" | "dark";
}

/**
 * A regional theme overlay (FR-13): swap floor tiles for a variant set
 * inside a rectangular region only, leaving the rest of the map
 * untouched. `variants` maps a base tile name to its overlay variant,
 * e.g. { "floor-plain": "floor-dark" } — a cell whose floor tile is not
 * a key keeps its tile. Overlays apply in order; a later overlay wins
 * where regions overlap.
 */
export interface FloorOverlay {
  /** Top-left cell of the region in room grid coords. */
  gx: number;
  gy: number;
  /** Region width/height in cells. >= 1. */
  w: number;
  h: number;
  /** Base tile name -> variant tile name. */
  variants: Record<string, string>;
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
  /**
   * Openings: perimeter cells with no wall at all — no wall tile, no
   * collision wall, floor shows through. A corridor's open ends (a
   * 1–2 wide corridor has no room for a door — every end cell is a
   * corner) and open archways between rooms. `at` is 0..n-1 along the
   * wall (corners allowed — an opening IS the corner cell). Linkable
   * ends in the dungeon graph, like doors.
   */
  openings?: DoorSpec[];
  dressing?: Placement[];
  fog?: Placement[];
  /** Torch positions (cell coords) — shorthand for warm amber lights. */
  torches?: { gx: number; gy: number }[];
  /** Full light specs (use instead of, or as well as, `torches`). */
  lights?: LightSpec[];
  /** Maze regions carved into the room (FR-12). */
  mazes?: MazeRegionSpec[];
  /** Regional theme overlays (FR-13). */
  overlays?: FloorOverlay[];
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

/** A wall-side segment: [firstCell, lastCellInclusive, kind]. */
export type WallSegmentKind = "wall" | "door" | "secret" | "open";

/** Split one wall side into plain, door, secret-door and open segments.
 *  Returns segments as [firstCell, lastCellInclusive, kind]. */
function splitWall(
  cells: number,
  doorsAt: number[],
  openAt: number[],
  secretAt: number[] = [],
): [number, number, WallSegmentKind][] {
  const kindAt = new Map<number, WallSegmentKind>();
  for (const at of doorsAt) kindAt.set(at, "door");
  for (const at of secretAt) kindAt.set(at, "secret");
  for (const at of openAt) kindAt.set(at, "open");
  const segs: [number, number, WallSegmentKind][] = [];
  let i = 0;
  while (i < cells) {
    const kind = kindAt.get(i) ?? "wall";
    let j = i;
    while (j + 1 < cells && (kindAt.get(j + 1) ?? "wall") === kind) j += 1;
    segs.push([i, j, kind]);
    i = j + 1;
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

/** Generate the maze grids for a spec's regions, resolving defaults:
 *  entrance side defaults to the side of the room's first door (where
 *  the party came in), else north; exit defaults to the opposite side. */
export function mazeGridsFor(spec: RoomSpec): { region: MazeRegionSpec; grid: MazeGrid }[] {
  const out: { region: MazeRegionSpec; grid: MazeGrid }[] = [];
  for (const region of spec.mazes ?? []) {
    const entrance = region.entrance ?? spec.doors?.[0]?.wall ?? "north";
    const exit = region.exit ?? oppositeSide(entrance);
    out.push({
      region,
      grid: generateMaze((region.w - 1) / 2, (region.h - 1) / 2, region.seed ?? 1, {
        entranceSide: entrance,
        entranceAt: region.entranceAt,
        exitSide: exit,
        exitAt: region.exitAt,
      }),
    });
  }
  return out;
}

/** Is this room cell a maze wall cell in any of the spec's regions? */
export function isMazeWallCell(
  grids: { region: MazeRegionSpec; grid: MazeGrid }[],
  gx: number,
  gy: number,
): boolean {
  for (const { region, grid } of grids) {
    const mx = gx - region.gx;
    const my = gy - region.gy;
    if (mx >= 0 && mx < region.w && my >= 0 && my < region.h && !grid.grid[my][mx]) return true;
  }
  return false;
}

function validateSpec(spec: RoomSpec, pack: Pack): void {
  const { gridW, gridH } = spec;
  // Minimum is 1x1, not 3x3: corridors are 1-wide by design (FR-12).
  // A 1-wide room's end cells are openings, so its corners coincide —
  // layoutRoom dedupes corner tiles by cell (see the wall ring below).
  if (!Number.isInteger(gridW) || !Number.isInteger(gridH) || gridW < 1 || gridH < 1) {
    throw new Error(`Room must be at least 1x1 grid squares, got ${gridW}x${gridH}.`);
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
  const openings = spec.openings ?? [];
  for (const o of openings) {
    const n = cellsAlong(o.wall, gridW, gridH);
    if (!Number.isInteger(o.at) || o.at < 0 || o.at > n - 1) {
      throw new Error(`Opening on ${o.wall} at cell ${o.at} is out of range 0..${n - 1}.`);
    }
    if (seenDoors.has(`${o.wall}:${o.at}`)) {
      throw new Error(`Opening on ${o.wall} at cell ${o.at} collides with a door in the same cell.`);
    }
  }
  const seenOpenings = new Set(openings.map((o) => `${o.wall}:${o.at}`));
  if (seenOpenings.size !== openings.length) throw new Error("Duplicate opening in room spec.");

  // Maze regions: odd dimensions, strictly interior (one cell of margin
  // from the room's edge, so the wall ring never collides with maze
  // walls), no overlap between regions.
  const grids = mazeGridsFor(spec);
  const regions = spec.mazes ?? [];
  for (const r of regions) {
    if (!Number.isInteger(r.w) || !Number.isInteger(r.h) || r.w < 3 || r.h < 3 || r.w % 2 === 0 || r.h % 2 === 0) {
      throw new Error(`Maze region must be odd-sized and at least 3x3 cells, got ${r.w}x${r.h}.`);
    }
    if (r.gx < 1 || r.gy < 1 || r.gx + r.w > gridW - 1 || r.gy + r.h > gridH - 1) {
      throw new Error(
        `Maze region at (${r.gx},${r.gy}) ${r.w}x${r.h} must sit strictly inside a ${gridW}x${gridH} room (one cell of margin from the edge).`,
      );
    }
  }
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i];
      const b = regions[j];
      const overlap = a.gx < b.gx + b.w && b.gx < a.gx + a.w && a.gy < b.gy + b.h && b.gy < a.gy + a.h;
      if (overlap) throw new Error(`Maze regions at (${a.gx},${a.gy}) and (${b.gx},${b.gy}) overlap.`);
    }
  }
  // A door's entry cell (one cell inside the door) must be walkable —
  // the party walks in through the door, not into a maze wall.
  for (const d of doors) {
    const { gx, gy } = doorEntryCell(d.wall, d.at, gridW, gridH);
    if (isMazeWallCell(grids, gx, gy)) {
      throw new Error(`Door on ${d.wall} at cell ${d.at} opens into a maze wall at (${gx},${gy}).`);
    }
  }
  // Overlays: region inside the room, variants naming real pack tiles.
  for (const o of spec.overlays ?? []) {
    if (!Number.isInteger(o.w) || !Number.isInteger(o.h) || o.w < 1 || o.h < 1) {
      throw new Error(`Overlay region must be at least 1x1 cells, got ${o.w}x${o.h}.`);
    }
    if (o.gx < 0 || o.gy < 0 || o.gx + o.w > gridW || o.gy + o.h > gridH) {
      throw new Error(`Overlay region at (${o.gx},${o.gy}) ${o.w}x${o.h} is outside a ${gridW}x${gridH} room.`);
    }
    const names = Object.entries(o.variants);
    if (names.length === 0) throw new Error("Overlay needs at least one tile variant.");
    for (const [base, variant] of names) {
      if (!pack.get(base)) throw new Error(`Overlay base tile "${base}" is not in the pack.`);
      if (!pack.get(variant)) throw new Error(`Overlay variant tile "${variant}" is not in the pack.`);
    }
  }

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
    // No placement may sit on a maze wall cell — a pillar inside a
    // solid maze wall would be invisible and unreachable.
    for (let dy = 0; dy < cells; dy++) {
      for (let dx = 0; dx < cells; dx++) {
        if (isMazeWallCell(grids, p.gx + dx, p.gy + dy)) {
          throw new Error(`${kind} tile "${p.tile}" at (${p.gx},${p.gy}) sits on a maze wall cell.`);
        }
      }
    }
  };
  for (const p of spec.dressing ?? []) checkPlacement(p, "dressing");
  for (const p of spec.fog ?? []) checkPlacement(p, "fog");
  for (const t of spec.torches ?? []) {
    if (t.gx < 0 || t.gx >= gridW || t.gy < 0 || t.gy >= gridH) {
      throw new Error(`Torch at (${t.gx},${t.gy}) is outside a ${gridW}x${gridH} room.`);
    }
    if (isMazeWallCell(grids, t.gx, t.gy)) {
      throw new Error(`Torch at (${t.gx},${t.gy}) sits on a maze wall cell.`);
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

/** Merge collinear [start, end] runs (adjacent or overlapping) into one. */
function mergeRuns(segs: [number, number][]): [number, number][] {
  const sorted = [...segs].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * Collision walls for maze regions: one merged segment along every
 * boundary between a maze wall cell and a walkable cell (maze floor, or
 * room floor outside the region). Two adjacent wall cells share no wall.
 * Entrance/exit openings are floor, so no wall is drawn across them.
 */
function mazeCollisionWalls(
  spec: RoomSpec,
  grids: { region: MazeRegionSpec; grid: MazeGrid }[],
): WallSpec[] {
  const hEdges = new Map<number, [number, number][]>();
  const vEdges = new Map<number, [number, number][]>();
  const addH = (yPx: number, xPx: number) => {
    const list = hEdges.get(yPx) ?? [];
    list.push([xPx, xPx + TILE_PX]);
    hEdges.set(yPx, list);
  };
  const addV = (xPx: number, yPx: number) => {
    const list = vEdges.get(xPx) ?? [];
    list.push([yPx, yPx + TILE_PX]);
    vEdges.set(xPx, list);
  };
  for (const { region, grid } of grids) {
    for (let my = 0; my < region.h; my++) {
      for (let mx = 0; mx < region.w; mx++) {
        if (grid.grid[my][mx]) continue; // floor cell — not a wall
        const gx = region.gx + mx;
        const gy = region.gy + my;
        const neighbours: [number, number, "h" | "v", number, number][] = [
          [gx, gy - 1, "h", gy * TILE_PX, gx * TILE_PX],
          [gx, gy + 1, "h", (gy + 1) * TILE_PX, gx * TILE_PX],
          [gx - 1, gy, "v", gx * TILE_PX, gy * TILE_PX],
          [gx + 1, gy, "v", (gx + 1) * TILE_PX, gy * TILE_PX],
        ];
        for (const [nx, ny, kind, line, start] of neighbours) {
          if (nx < 0 || ny < 0 || nx >= spec.gridW || ny >= spec.gridH) continue;
          if (isMazeWallCell(grids, nx, ny)) continue; // both blocked — no wall
          if (kind === "h") addH(line, start);
          else addV(line, start);
        }
      }
    }
  }
  const walls: WallSpec[] = [];
  for (const [y, segs] of hEdges) {
    for (const [x1, x2] of mergeRuns(segs)) walls.push({ x1, y1: y, x2, y2: y, door: 0 });
  }
  for (const [x, segs] of vEdges) {
    for (const [y1, y2] of mergeRuns(segs)) walls.push({ x1: x, y1, x2: x, y2: y2, door: 0 });
  }
  return walls;
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
  const grids = mazeGridsFor(spec);

  // Floor: one tile per cell. "mixed" rolls plain/cracked/rubble;
  // "dark" uses the cold dark floor for the whole room. Maze wall cells
  // get no floor tile (a wall tile goes there instead). Overlays remap
  // the rolled tile name inside their region, in order (later wins).
  const floorNames =
    spec.floorStyle === "dark" ? ["floor-dark"] : ["floor-plain", "floor-plain", "floor-plain", "floor-plain", "floor-plain", "floor-plain", "floor-cracked", "floor-cracked", "floor-cracked", "floor-rubble"];
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      if (isMazeWallCell(grids, gx, gy)) continue;
      let name = floorNames[Math.floor(rng() * floorNames.length)];
      for (const o of spec.overlays ?? []) {
        if (gx >= o.gx && gx < o.gx + o.w && gy >= o.gy && gy < o.gy + o.h && o.variants[name] !== undefined) {
          name = o.variants[name];
        }
      }
      const entry = pack.get(name);
      if (!entry) throw new Error(`Pack is missing floor tile "${name}".`);
      tiles.push(tileDoc(entry, serverBase, gx, gy, { elevation: 0, sort: LAYER_SORT.floor }));
    }
  }

  // Wall ring: corners + straights, with door tiles where the spec puts
  // doors — and nothing at all where it puts openings (floor shows
  // through, including a corner cell that is an opening).
  const doors = spec.doors ?? [];
  const openings = spec.openings ?? [];
  const doorAt = new Map<string, "door" | "secret">();
  for (const d of doors) doorAt.set(`${d.wall}:${d.at}`, d.secret ? "secret" : "door");
  const openAt = new Set<string>();
  for (const o of openings) openAt.add(`${o.wall}:${o.at}`);
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
  const placedCorners = new Set<string>();
  for (const [corner, gx, gy] of corners) {
    const cornerOpen =
      (corner === "nw" && (openAt.has("north:0") || openAt.has("west:0"))) ||
      (corner === "ne" && (openAt.has(`north:${gridW - 1}`) || openAt.has("east:0"))) ||
      (corner === "se" && (openAt.has(`south:${gridW - 1}`) || openAt.has(`east:${gridH - 1}`))) ||
      (corner === "sw" && (openAt.has("south:0") || openAt.has(`west:${gridH - 1}`)));
    if (cornerOpen) continue;
    // In a 1-wide room the two corners of an end wall are the same cell.
    if (placedCorners.has(`${gx},${gy}`)) continue;
    placedCorners.add(`${gx},${gy}`);
    tiles.push(tileDoc(cornerEntry, serverBase, gx, gy, {
      elevation: 0, sort: LAYER_SORT.wall, rotation: cornerRotation(corner),
    }));
  }
  for (const side of ["north", "south", "east", "west"] as WallSide[]) {
    const n = cellsAlong(side, gridW, gridH);
    for (let at = 1; at <= n - 2; at++) {
      if (openAt.has(`${side}:${at}`)) continue;
      const { gx, gy, rotation } = wallCell(side, at, gridW, gridH);
      const kind = doorAt.get(`${side}:${at}`);
      // A secret door looks like a plain wall — the straight tile, not
      // the door tile — so the party can't spot it from the map.
      tiles.push(tileDoc(kind === "door" ? doorEntry : straightEntry, serverBase, gx, gy, {
        elevation: 0, sort: LAYER_SORT.wall, rotation,
      }));
    }
  }

  // Maze walls: a wall-straight tile facing the first open neighbour
  // (the band faces the walkable floor, like the ring's wall tiles), or
  // floor-dark for a wall cell enclosed on all sides.
  const darkEntry = pack.get("floor-dark");
  if (!darkEntry) throw new Error('Pack is missing floor tile "floor-dark".');
  const OPEN_DIRS: { side: WallSide; dx: number; dy: number }[] = [
    { side: "north", dx: 0, dy: -1 },
    { side: "east", dx: 1, dy: 0 },
    { side: "south", dx: 0, dy: 1 },
    { side: "west", dx: -1, dy: 0 },
  ];
  for (const { region, grid } of grids) {
    for (let my = 0; my < region.h; my++) {
      for (let mx = 0; mx < region.w; mx++) {
        if (grid.grid[my][mx]) continue;
        const gx = region.gx + mx;
        const gy = region.gy + my;
        const openSide = OPEN_DIRS.find(({ dx, dy }) => {
          const nx = gx + dx;
          const ny = gy + dy;
          return nx >= 0 && ny >= 0 && nx < gridW && ny < gridH && !isMazeWallCell(grids, nx, ny);
        })?.side;
        if (openSide) {
          tiles.push(tileDoc(straightEntry, serverBase, gx, gy, {
            elevation: 0, sort: LAYER_SORT.wall, rotation: wallRotation(openSide),
          }));
        } else {
          tiles.push(tileDoc(darkEntry, serverBase, gx, gy, {
            elevation: 0, sort: LAYER_SORT.floor,
          }));
        }
      }
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
  // cell becomes a door segment (door: 1); a secret door cell becomes a
  // secret segment (door: 2); an opening cell gets no wall at all; the
  // rest are plain walls. Then the merged maze walls.
  const walls: WallSpec[] = [];
  for (const side of ["north", "south", "east", "west"] as WallSide[]) {
    const n = cellsAlong(side, gridW, gridH);
    const doorsHere = doors.filter((d) => d.wall === side && !d.secret).map((d) => d.at);
    const secretHere = doors.filter((d) => d.wall === side && d.secret).map((d) => d.at);
    const openHere = openings.filter((o) => o.wall === side).map((o) => o.at);
    for (const [first, last, kind] of splitWall(n, doorsHere, openHere, secretHere)) {
      if (kind === "open") continue;
      walls.push({ ...wallCoords(side, first, last, width, height), door: kind === "door" ? 1 : kind === "secret" ? 2 : 0 });
    }
  }
  walls.push(...mazeCollisionWalls(spec, grids));

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

// ---------------------------------------------------------------- dungeon graph

/**
 * A dungeon is rooms + door links: one scene per room, doors as
 * connectors. A link joins a door in room A to a door in room B; the
 * party walks through A's door and arrives in B just inside B's door
 * (and vice versa). Pure math — no Foundry. The live build (one scene
 * per room) and the door-walk (move the party between scenes) live in
 * `tiles.ts`.
 */

export interface DungeonRoomSpec extends RoomSpec {
  /** Unique id within the dungeon — door links address rooms by id. */
  id: string;
}

/** One end of a door link: a door cell in a room. */
export interface DoorEnd {
  room: string;
  wall: WallSide;
  at: number;
}

export interface DoorLink {
  from: DoorEnd;
  to: DoorEnd;
}

export interface DungeonSpec {
  rooms: DungeonRoomSpec[];
  links: DoorLink[];
}

/** A link end with the arrival cell: the cell just inside the door. */
export interface ResolvedDoorEnd extends DoorEnd {
  /** Cell just inside the door, where the party arrives. */
  enterGx: number;
  enterGy: number;
}

export interface ResolvedDoorLink {
  from: ResolvedDoorEnd;
  to: ResolvedDoorEnd;
}

export interface DungeonLayout {
  rooms: { id: string; name: string; layout: RoomLayout }[];
  links: ResolvedDoorLink[];
}

/** The cell just inside a door: one cell in from the wall. */
export function doorEntryCell(
  wall: WallSide,
  at: number,
  gridW: number,
  gridH: number,
): { gx: number; gy: number } {
  switch (wall) {
    case "north": return { gx: at, gy: 1 };
    case "south": return { gx: at, gy: gridH - 2 };
    case "west": return { gx: 1, gy: at };
    case "east": return { gx: gridW - 2, gy: at };
  }
}

function doorKey(end: DoorEnd): string {
  return `${end.room}:${end.wall}:${end.at}`;
}

/**
 * Validate + lay out a whole dungeon. Throws on any structural problem:
 * duplicate or empty room ids, a link end naming an unknown room or a
 * cell that is not a declared door in that room, a door used in two
 * links, a self-link, a duplicated link, or a room unreachable from the
 * first room (the dungeon must be one connected graph).
 */
export function layoutDungeon(
  spec: DungeonSpec,
  pack: Pack,
  serverBase: string,
): DungeonLayout {
  if (spec.rooms.length === 0) throw new Error("A dungeon needs at least one room.");
  const roomById = new Map<string, DungeonRoomSpec>();
  for (const room of spec.rooms) {
    if (!room.id) throw new Error("Every dungeon room needs a non-empty id.");
    if (roomById.has(room.id)) throw new Error(`Duplicate room id "${room.id}".`);
    roomById.set(room.id, room);
  }
  const doorEnds = new Map<string, DungeonRoomSpec>();
  for (const room of spec.rooms) {
    // Doors AND openings are linkable ends — a corridor's open end is
    // an opening, not a door, and the graph must accept it.
    for (const d of [...(room.doors ?? []), ...(room.openings ?? [])]) {
      doorEnds.set(`${room.id}:${d.wall}:${d.at}`, room);
    }
  }
  const usedEnds = new Set<string>();
  const seenLinks = new Set<string>();
  const resolved: ResolvedDoorLink[] = [];
  for (const link of spec.links) {
    const fromRoom = roomById.get(link.from.room);
    const toRoom = roomById.get(link.to.room);
    if (!fromRoom) throw new Error(`Link names unknown room "${link.from.room}".`);
    if (!toRoom) throw new Error(`Link names unknown room "${link.to.room}".`);
    if (link.from.room === link.to.room) {
      throw new Error(`Link from room "${link.from.room}" to itself — a door cannot lead into its own room.`);
    }
    const fromKey = doorKey(link.from);
    const toKey = doorKey(link.to);
    if (!doorEnds.has(fromKey)) {
      throw new Error(`Link end ${fromKey} is not a declared door or opening in room "${link.from.room}".`);
    }
    if (!doorEnds.has(toKey)) {
      throw new Error(`Link end ${toKey} is not a declared door or opening in room "${link.to.room}".`);
    }
    // Duplicate (either direction) is checked before door reuse: a
    // reversed duplicate IS a reuse, but "duplicate link" is the right
    // diagnosis for it.
    const pairKey = [fromKey, toKey].sort().join("<>");
    if (seenLinks.has(pairKey)) throw new Error(`Duplicate link between ${fromKey} and ${toKey}.`);
    if (usedEnds.has(fromKey) || usedEnds.has(toKey)) {
      throw new Error(`Door ${usedEnds.has(fromKey) ? fromKey : toKey} is used in two links — one door, one destination.`);
    }
    usedEnds.add(fromKey);
    usedEnds.add(toKey);
    seenLinks.add(pairKey);
    const resolveEnd = (end: DoorEnd, room: DungeonRoomSpec): ResolvedDoorEnd => {
      const { gx, gy } = doorEntryCell(end.wall, end.at, room.gridW, room.gridH);
      return { ...end, enterGx: gx, enterGy: gy };
    };
    resolved.push({
      from: resolveEnd(link.from, fromRoom),
      to: resolveEnd(link.to, toRoom),
    });
  }
  // Connectivity: every room reachable from the first, over the links.
  const neighbours = new Map<string, Set<string>>();
  for (const room of spec.rooms) neighbours.set(room.id, new Set());
  for (const link of resolved) {
    neighbours.get(link.from.room)!.add(link.to.room);
    neighbours.get(link.to.room)!.add(link.from.room);
  }
  const reached = new Set<string>([spec.rooms[0].id]);
  const queue = [spec.rooms[0].id];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const next of neighbours.get(cur) ?? []) {
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }
  const unreachable = spec.rooms.filter((r) => !reached.has(r.id)).map((r) => r.id);
  if (unreachable.length > 0) {
    throw new Error(`Dungeon is not connected — unreachable from "${spec.rooms[0].id}": ${unreachable.join(", ")}.`);
  }
  return {
    rooms: spec.rooms.map((room) => ({
      id: room.id,
      name: room.name,
      layout: layoutRoom(room, pack, serverBase),
    })),
    links: resolved,
  };
}

/**
 * Where does walking through this door lead? Returns the other end of
 * the link (room id + arrival cell), or null when the door is unlinked.
 */
export function resolveDoorWalk(
  dungeon: DungeonLayout,
  roomId: string,
  wall: WallSide,
  at: number,
): ResolvedDoorEnd | null {
  const key = `${roomId}:${wall}:${at}`;
  for (const link of dungeon.links) {
    if (doorKey(link.from) === key) return link.to;
    if (doorKey(link.to) === key) return link.from;
  }
  return null;
}


// ---------------------------------------------------------------- layout operations (FR-12 / FR-13)
//
// Mutable maps: every operation takes a spec and returns a NEW spec —
// the input is never mutated, so the creator's edit history is just a
// list of specs and "undo" is the previous one. The composer rebuilds
// from the edited spec (rebuildTileRoom); no new images are involved.

export interface AddCorridorOptions {
  /** Room the corridor starts from. */
  room: string;
  /** Wall of that room the corridor leaves through. */
  wall: WallSide;
  /** Cell along that wall (1..n-2, not a corner). */
  at: number;
  /** Direction the corridor runs, away from the room. */
  direction: WallSide;
  /** Corridor length in `unit` (default squares). */
  length: number;
  unit?: LengthUnit;
  /** Corridor width in squares (default 1 — a classic 5 ft corridor).
   *  Width 1–2: the ends are openings (no room for a door — every end
   *  cell is a corner). Width 3+: the ends get doors at the middle cell. */
  width?: number;
  /** Corridor room id. Default: `corridor-<room>-<direction>` (+ a
   *  suffix when taken). */
  id?: string;
  /** Corridor room name. Default: `Corridor`. */
  name?: string;
}

/**
 * Add a corridor to a dungeon: a long thin room leaving `room`'s door
 * (added if the wall cell has none yet) and running `direction` for
 * `length`. Returns the new dungeon spec — the corridor room plus the
 * link to the source room. The far end is left unlinked for the next
 * operation (a maze room, another corridor, …).
 */
export function addCorridor(dungeon: DungeonSpec, opts: AddCorridorOptions): DungeonSpec {
  const fromRoom = dungeon.rooms.find((r) => r.id === opts.room);
  if (!fromRoom) throw new Error(`Corridor starts from unknown room "${opts.room}".`);
  const n = cellsAlong(opts.wall, fromRoom.gridW, fromRoom.gridH);
  if (!Number.isInteger(opts.at) || opts.at < 1 || opts.at > n - 2) {
    throw new Error(
      `Corridor start cell ${opts.at} on ${opts.wall} is out of range 1..${n - 2} — it must be a real wall cell, not a corner.`,
    );
  }
  const length = toSquares(opts.length, opts.unit ?? "squares");
  const width = opts.width ?? 1;
  if (!Number.isInteger(width) || width < 1) {
    throw new Error(`Corridor width must be at least 1 square, got ${opts.width}.`);
  }
  const entryWall = oppositeSide(opts.direction);
  const gridW = opts.direction === "north" || opts.direction === "south" ? width : length;
  const gridH = opts.direction === "north" || opts.direction === "south" ? length : width;
  const endAt = width < 3 ? 0 : Math.floor(width / 2);
  const corridor: DungeonRoomSpec = {
    id: opts.id ?? nextCorridorId(dungeon, opts.room, opts.direction),
    name: opts.name ?? "Corridor",
    gridW,
    gridH,
    ...(width < 3
      ? { openings: [
          { wall: entryWall, at: 0 },
          ...(width === 2 ? [{ wall: entryWall, at: 1 }] : []),
          { wall: opts.direction, at: 0 },
          ...(width === 2 ? [{ wall: opts.direction, at: 1 }] : []),
        ] }
      : { doors: [
          { wall: entryWall, at: endAt },
          { wall: opts.direction, at: endAt },
        ] }),
  };
  if (dungeon.rooms.some((r) => r.id === corridor.id)) {
    throw new Error(`Corridor id "${corridor.id}" is already used in this dungeon.`);
  }
  // The source room gains a door at the start cell when it has none —
  // "make a corridor along this wall" implies the opening.
  const rooms = dungeon.rooms.map((r) => {
    if (r.id !== opts.room) return r;
    const hasDoor = (r.doors ?? []).some((d) => d.wall === opts.wall && d.at === opts.at);
    const hasOpening = (r.openings ?? []).some((o) => o.wall === opts.wall && o.at === opts.at);
    if (hasDoor || hasOpening) return r;
    return { ...r, doors: [...(r.doors ?? []), { wall: opts.wall, at: opts.at }] };
  });
  return {
    rooms: [...rooms, corridor],
    links: [
      ...dungeon.links,
      {
        from: { room: opts.room, wall: opts.wall, at: opts.at },
        to: { room: corridor.id, wall: entryWall, at: endAt },
      },
    ],
  };
}

function nextCorridorId(dungeon: DungeonSpec, room: string, direction: WallSide): string {
  const base = `corridor-${room}-${direction}`;
  if (!dungeon.rooms.some((r) => r.id === base)) return base;
  let i = 2;
  while (dungeon.rooms.some((r) => r.id === `${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

/**
 * Link two rooms' doors/openings in a dungeon spec. Local checks only
 * (both ends exist as declared doors or openings, no self-link, no
 * duplicate link) — the full graph validation runs in layoutDungeon at
 * build time.
 */
export function linkRooms(dungeon: DungeonSpec, link: DoorLink): DungeonSpec {
  const endRoom = (end: DoorEnd) => dungeon.rooms.find((r) => r.id === end.room);
  const fromRoom = endRoom(link.from);
  const toRoom = endRoom(link.to);
  if (!fromRoom) throw new Error(`Link names unknown room "${link.from.room}".`);
  if (!toRoom) throw new Error(`Link names unknown room "${link.to.room}".`);
  if (link.from.room === link.to.room) {
    throw new Error(`Link from room "${link.from.room}" to itself — a door cannot lead into its own room.`);
  }
  const isEnd = (room: DungeonRoomSpec, end: DoorEnd) =>
    [...(room.doors ?? []), ...(room.openings ?? [])].some(
      (d) => d.wall === end.wall && d.at === end.at,
    );
  if (!isEnd(fromRoom, link.from)) {
    throw new Error(`Link end ${doorKey(link.from)} is not a declared door or opening in room "${link.from.room}".`);
  }
  if (!isEnd(toRoom, link.to)) {
    throw new Error(`Link end ${doorKey(link.to)} is not a declared door or opening in room "${link.to.room}".`);
  }
  const pairKey = [doorKey(link.from), doorKey(link.to)].sort().join("<>");
  for (const existing of dungeon.links) {
    const existingKey = [doorKey(existing.from), doorKey(existing.to)].sort().join("<>");
    if (existingKey === pairKey) {
      throw new Error(`Duplicate link between ${doorKey(link.from)} and ${doorKey(link.to)}.`);
    }
  }
  return { rooms: dungeon.rooms, links: [...dungeon.links, link] };
}

/**
 * Carve a maze region into a room spec (FR-12): the rectangle becomes a
 * seeded perfect maze. The region must be odd-sized, at least 3x3, and
 * strictly interior — validation (overlap, door entries, placements on
 * maze walls) runs in layoutRoom's validateSpec; this only checks the
 * region's own shape and that it fits, so a bad region fails fast.
 */
export function carveMazeRegion(spec: RoomSpec, region: MazeRegionSpec): RoomSpec {
  if (!Number.isInteger(region.w) || !Number.isInteger(region.h) ||
      region.w < 3 || region.h < 3 || region.w % 2 === 0 || region.h % 2 === 0) {
    throw new Error(`Maze region must be odd-sized and at least 3x3 cells, got ${region.w}x${region.h}.`);
  }
  if (region.gx < 1 || region.gy < 1 ||
      region.gx + region.w > spec.gridW - 1 || region.gy + region.h > spec.gridH - 1) {
    throw new Error(
      `Maze region at (${region.gx},${region.gy}) ${region.w}x${region.h} must sit strictly inside a ${spec.gridW}x${spec.gridH} room (one cell of margin from the edge).`,
    );
  }
  for (const other of spec.mazes ?? []) {
    const overlap =
      region.gx < other.gx + other.w && other.gx < region.gx + region.w &&
      region.gy < other.gy + other.h && other.gy < region.gy + region.h;
    if (overlap) throw new Error(`Maze region at (${region.gx},${region.gy}) overlaps the region at (${other.gx},${other.gy}).`);
  }
  // Generate once here so a bad entrance/exit fails fast, not at build.
  generateMaze((region.w - 1) / 2, (region.h - 1) / 2, region.seed ?? 1, {
    entranceSide: region.entrance ?? spec.doors?.[0]?.wall ?? "north",
    entranceAt: region.entranceAt,
    exitSide: region.exit ?? oppositeSide(region.entrance ?? spec.doors?.[0]?.wall ?? "north"),
    exitAt: region.exitAt,
  });
  return { ...spec, mazes: [...(spec.mazes ?? []), region] };
}

/**
 * Widen a room (FR-8's "a bit wider"): add `by` columns/rows of floor
 * tiles on one side. Content shifts with the room when the growth is on
 * the west/north side — doors, dressing, fog, torches, lights, maze
 * regions and overlays all move so the room looks the same, just wider.
 */
export function widenRoom(spec: RoomSpec, side: WallSide, by: number): RoomSpec {
  if (!Number.isInteger(by) || by < 1) {
    throw new Error(`Widen by at least 1 square, got ${by}.`);
  }
  const dx = side === "west" ? by : 0;
  const dy = side === "north" ? by : 0;
  const shiftDoor = (d: DoorSpec): DoorSpec => {
    if (side === "west" && (d.wall === "north" || d.wall === "south")) return { ...d, at: d.at + by };
    if (side === "north" && (d.wall === "east" || d.wall === "west")) return { ...d, at: d.at + by };
    return d;
  };
  const shiftPlacement = (p: Placement): Placement => ({ ...p, gx: p.gx + dx, gy: p.gy + dy });
  return {
    ...spec,
    gridW: spec.gridW + (side === "west" || side === "east" ? by : 0),
    gridH: spec.gridH + (side === "north" || side === "south" ? by : 0),
    doors: spec.doors?.map(shiftDoor),
    openings: spec.openings?.map(shiftDoor),
    dressing: spec.dressing?.map(shiftPlacement),
    fog: spec.fog?.map(shiftPlacement),
    torches: spec.torches?.map((t) => ({ gx: t.gx + dx, gy: t.gy + dy })),
    lights: spec.lights?.map((l) => ({ ...l, x: l.x + dx * TILE_PX, y: l.y + dy * TILE_PX })),
    mazes: spec.mazes?.map((m) => ({ ...m, gx: m.gx + dx, gy: m.gy + dy })),
    overlays: spec.overlays?.map((o) => ({ ...o, gx: o.gx + dx, gy: o.gy + dy })),
  };
}

/**
 * Apply a regional theme overlay (FR-13): swap floor tiles for a
 * variant set inside a rectangular region only. Pure spec edit — the
 * composer applies it at layout time. Later overlays win where regions
 * overlap.
 */
export function applyOverlay(spec: RoomSpec, overlay: FloorOverlay): RoomSpec {
  if (!Number.isInteger(overlay.w) || !Number.isInteger(overlay.h) || overlay.w < 1 || overlay.h < 1) {
    throw new Error(`Overlay region must be at least 1x1 cells, got ${overlay.w}x${overlay.h}.`);
  }
  if (overlay.gx < 0 || overlay.gy < 0 ||
      overlay.gx + overlay.w > spec.gridW || overlay.gy + overlay.h > spec.gridH) {
    throw new Error(
      `Overlay region at (${overlay.gx},${overlay.gy}) ${overlay.w}x${overlay.h} is outside a ${spec.gridW}x${spec.gridH} room.`,
    );
  }
  if (Object.keys(overlay.variants).length === 0) {
    throw new Error("Overlay needs at least one tile variant.");
  }
  return { ...spec, overlays: [...(spec.overlays ?? []), overlay] };
}
