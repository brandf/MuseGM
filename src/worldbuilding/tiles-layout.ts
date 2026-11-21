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
 *
 * Props and fog are free sprites: a placement may sit at fractional
 * cells (x = gx*100), so a chest can sit half a square off the grid.
 * A placement may also declare an explicit footprint (w/h in cells) —
 * a macro piece laid as a run, e.g. wall-curved at 3x1 is a 300x100
 * curved wall run. Rooms may be L-shaped (a corner cut out) and may
 * carry interior diagonal walls — see RoomSpec.cutout and
 * RoomSpec.diagonals.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { LightSpec, WallSpec } from "./index.js";
import { resolveTheme, themeTileGaps, type ThemeSpec } from "./themes.js";
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

/** Warm torchlight defaults (STYLE.md / the Lich's Lair lighting fix).
 *  Kept for callers that need the dungeon default directly; the theme
 *  system carries the same values in DUNGEON_THEME.torch. */
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
  /** Pack kind (Nov 20 redesign): base | macro | prop. */
  kind?: "base" | "macro" | "prop";
  /** Real pixel width/height of the art. Square tiles omit these and
   *  default to sizePx — the manifest stays square-only until a
   *  non-square piece is generated, and the composer reads the real
   *  shape here instead of assuming width == height == sizePx. */
  widthPx?: number;
  heightPx?: number;
}

/** Pixel width of a pack entry — its real shape, not the square sizePx. */
export function tileWidthPx(entry: PackEntry): number {
  return entry.widthPx ?? entry.sizePx;
}

/** Pixel height of a pack entry — its real shape, not the square sizePx. */
export function tileHeightPx(entry: PackEntry): number {
  return entry.heightPx ?? entry.sizePx;
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

/** One dressing/fog placement: top-left cell of the tile.
 *  Dressing placements are the room's props (FR-6): a prop's stable
 *  identity is its `id` when present (assigned by placeProp), else
 *  its tile + cell. Fog placements don't use `id`.
 *
 *  Props are free sprites: gx/gy may be fractional (a chest at
 *  (2.5, 3.5) sits half a square off the grid — x = gx*100), and w/h
 *  may declare an explicit footprint in cells. */
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
  /** Stable prop identity (FR-6): what move/remove address. Assigned
   *  by placeProp (`prop-1`, `prop-2`, …). Placements written before
   *  ids existed (e.g. by the build loop's add-dressing op) have none
   *  and are addressed by tile + cell instead. */
  id?: string;
  /**
   * Interactive dressing marker (FR-16, BRA-192): the dressing item
   * id this placement belongs to (e.g. "torch-n-4"). When set,
   * layoutRoom stamps `flags.meroki = { dressingId }` on the Tile
   * document, and the composer hook's pairing step adds the light
   * _id, kind and alpha after the light is created — the click
   * module reads that flag to find the light to flip. Only the
   * dressing hook sets this; a hand-placed prop never carries it.
   */
  dressingId?: string;
  /** Explicit footprint in cells (default: the tile's own size). A
   *  macro piece can be laid as a run — e.g. wall-curved at w:3, h:1
   *  is a 300x100 curved wall run. The art is stretched to the
   *  footprint, so only use a footprint the art was drawn for. */
  w?: number;
  h?: number;
}

/** Footprint of a placement in cells: its explicit w/h, else the
 *  tile's own size. */
export function placementFootprint(p: Placement, entry: PackEntry): { w: number; h: number } {
  return {
    w: p.w ?? tileWidthPx(entry) / TILE_PX,
    h: p.h ?? tileHeightPx(entry) / TILE_PX,
  };
}

/** Integer cells a footprint rect overlaps: a sprite at (2.5, 3.5) of
 *  2x2 cells overlaps cells 2..4 x 3..5 — the cells it visibly covers,
 *  so maze-wall and cutout checks stay exact off-grid. */
function placementCells(gx: number, gy: number, w: number, h: number): { gx: number; gy: number }[] {
  const cells: { gx: number; gy: number }[] = [];
  for (let cy = Math.floor(gy); cy < Math.ceil(gy + h); cy++) {
    for (let cx = Math.floor(gx); cx < Math.ceil(gx + w); cx++) {
      cells.push({ gx: cx, gy: cy });
    }
  }
  return cells;
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

/** Which corner of the room a cutout is anchored at. */
export type CutoutCorner = "nw" | "ne" | "se" | "sw";

/** An L-shaped room: a rectangle cut out of one corner. The cutout is
 *  a void — no floor, no props, no doors — and the wall ring follows
 *  the L outline, so the room has one inner corner. The cutout is
 *  corner-relative (not absolute cells), so widenRoom keeps it correct
 *  without touching it. */
export interface RoomCutout {
  corner: CutoutCorner;
  /** Cutout width/height in cells. Each must leave at least 2 cells of
   *  leg on its side, so no floor cell ever borders the boundary on
   *  two opposite sides (one tile per cell stays expressible). */
  w: number;
  h: number;
}

/** Cell rect of a room's cutout, or null for a rectangular room. */
export function cutoutRect(spec: RoomSpec): { gx: number; gy: number; w: number; h: number } | null {
  const c = spec.cutout;
  if (!c) return null;
  switch (c.corner) {
    case "nw": return { gx: 0, gy: 0, w: c.w, h: c.h };
    case "ne": return { gx: spec.gridW - c.w, gy: 0, w: c.w, h: c.h };
    case "se": return { gx: spec.gridW - c.w, gy: spec.gridH - c.h, w: c.w, h: c.h };
    case "sw": return { gx: 0, gy: spec.gridH - c.h, w: c.w, h: c.h };
  }
}

/** Is this cell inside the room's cutout (the void of an L-shaped room)? */
export function isCutoutCell(spec: RoomSpec, gx: number, gy: number): boolean {
  const r = cutoutRect(spec);
  return r !== null && gx >= r.gx && gx < r.gx + r.w && gy >= r.gy && gy < r.gy + r.h;
}

/** Which sides of a floor cell border the void — the room's outer edge
 *  or the cutout of an L-shaped room. A cell with one side gets a
 *  straight wall tile; two adjacent sides, a corner tile. */
function boundaryDirs(spec: RoomSpec, gx: number, gy: number): WallSide[] {
  const dirs: WallSide[] = [];
  if (gy === 0 || isCutoutCell(spec, gx, gy - 1)) dirs.push("north");
  if (gy === spec.gridH - 1 || isCutoutCell(spec, gx, gy + 1)) dirs.push("south");
  if (gx === 0 || isCutoutCell(spec, gx - 1, gy)) dirs.push("west");
  if (gx === spec.gridW - 1 || isCutoutCell(spec, gx + 1, gy)) dirs.push("east");
  return dirs;
}

/** The cell a door/opening on a wall side sits in. */
function doorCell(wall: WallSide, at: number, gridW: number, gridH: number): { gx: number; gy: number } {
  switch (wall) {
    case "north": return { gx: at, gy: 0 };
    case "south": return { gx: at, gy: gridH - 1 };
    case "west": return { gx: 0, gy: at };
    case "east": return { gx: gridW - 1, gy: at };
  }
}

/** A diagonal wall inside a room: the wall-diagonal tile (a band
 *  corner to corner, face on one side) plus a diagonal collision wall.
 *  Rotation 0 is the art as drawn — band NW→SE, face to the
 *  south-west; 90 turns it to NE→SW (face north-west), 180 to SE→NW
 *  (face north-east), 270 to SW→NE (face south-east). */
export interface DiagonalWallSpec {
  /** Top-left cell of the 1x1 diagonal wall. */
  gx: number;
  gy: number;
  /** Clockwise degrees: 0, 90, 180 or 270. Default 0. */
  rotation?: number;
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
  /** One-word theme id, e.g. "dungeon" (the default look) or
   *  "western" (FR-2) — the room's look: floor/wall tiles, fog and
   *  dressing remaps, torch palette. An explicit theme argument to
   *  layoutRoom / buildTileRoom overrides this. */
  theme?: string;
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
  /** L-shaped room: a corner cut out of the rectangle (a void — no
   *  floor, no props, no doors). The wall ring follows the L outline.
   *  Absent = the room is a rectangle. */
  cutout?: RoomCutout;
  /** Interior diagonal walls: the wall-diagonal tile plus a diagonal
   *  collision wall. Interior only — a diagonal cannot sit on the
   *  room's wall ring, a maze wall cell, or in the cutout. */
  diagonals?: DiagonalWallSpec[];
  /** Room description posted to chat when the room is built. */
  description?: string;
  /**
   * Idempotency key for this room (BRA-202). When set, the key is
   * stored in the scene's flags (`buildKey`, same field `scene create
   * --build-key` uses) and every tile/wall/light carries a per-embed
   * key (`<buildKey>:tile|wall|light:<index>`). A re-run with the same
   * key returns the existing scene instead of building a duplicate,
   * and converges a half-built scene to the full layout. Without it,
   * behavior is unchanged.
   */
  buildKey?: string;
  /**
   * Build the scene with navigation off (FR-3): the room exists but
   * the players cannot see or navigate to it until a gated reveal
   * flips it live. Default false — a room is visible when built.
   */
  hidden?: boolean;
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
  /** Optional document flags — a keyed build (BRA-202) stamps the
   *  per-embed key here so a re-run can find this tile again. */
  flags?: Record<string, unknown>;
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

/** Validate a room spec against the pack. Exported for the prop ops
 *  (place/move/remove) — one source of truth, so a prop edit can only
 *  produce a spec the composer would accept. */
export function validateRoomSpec(spec: RoomSpec, pack: Pack): void {
  validateSpec(spec, pack);
}

function validateSpec(spec: RoomSpec, pack: Pack): void {
  const { gridW, gridH } = spec;
  // Minimum is 1x1, not 3x3: corridors are 1-wide by design (FR-12).
  // A 1-wide room's end cells are openings, so its corners coincide —
  // layoutRoom dedupes corner tiles by cell (see the wall ring below).
  if (!Number.isInteger(gridW) || !Number.isInteger(gridH) || gridW < 1 || gridH < 1) {
    throw new Error(`Room must be at least 1x1 grid squares, got ${gridW}x${gridH}.`);
  }
  // L-shaped room: the cutout must leave at least 2 cells of leg on
  // each side, so no floor cell ever borders the boundary on two
  // opposite sides (one tile per cell stays expressible).
  const cutout = spec.cutout;
  if (cutout) {
    if (cutout.corner !== "nw" && cutout.corner !== "ne" && cutout.corner !== "se" && cutout.corner !== "sw") {
      throw new Error(`Cutout corner must be nw, ne, se or sw, got ${JSON.stringify(cutout.corner)}.`);
    }
    if (!Number.isInteger(cutout.w) || !Number.isInteger(cutout.h) || cutout.w < 1 || cutout.h < 1) {
      throw new Error(`Cutout must be at least 1x1 cells, got ${cutout.w}x${cutout.h}.`);
    }
    if (cutout.w > gridW - 2 || cutout.h > gridH - 2) {
      throw new Error(
        `Cutout ${cutout.w}x${cutout.h} in a ${gridW}x${gridH} room leaves a leg under 2 cells — an L-shaped room needs at least 2 cells on each leg (cutout at most ${gridW - 2}x${gridH - 2}).`,
      );
    }
  }
  const doors = spec.doors ?? [];
  for (const d of doors) {
    const n = cellsAlong(d.wall, gridW, gridH);
    if (!Number.isInteger(d.at) || d.at < 1 || d.at > n - 2) {
      throw new Error(
        `Door on ${d.wall} at cell ${d.at} is out of range 1..${n - 2} (doors may not sit in a corner).`,
      );
    }
    if (cutout) {
      const cell = doorCell(d.wall, d.at, gridW, gridH);
      if (isCutoutCell(spec, cell.gx, cell.gy)) {
        throw new Error(
          `Door on ${d.wall} at cell ${d.at} sits in the room's ${cutout.corner} cutout — doors live on the L outline, not in the void.`,
        );
      }
      // A door cell on an L inner corner would need two wall faces
      // (the door tile plus the cutout-facing band) — one tile cannot
      // show both, so the door must move to a straight stretch.
      if (boundaryDirs(spec, cell.gx, cell.gy).length > 1) {
        throw new Error(
          `Door on ${d.wall} at cell ${d.at} sits on an inner-corner cell of the L-shaped room — move it to a straight stretch of wall.`,
        );
      }
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
    if (cutout) {
      const cell = doorCell(o.wall, o.at, gridW, gridH);
      if (isCutoutCell(spec, cell.gx, cell.gy)) {
        throw new Error(
          `Opening on ${o.wall} at cell ${o.at} sits in the room's ${cutout.corner} cutout — openings live on the L outline, not in the void.`,
        );
      }
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
    // A maze region may not overlap the cutout — its cells would be
    // void, and the maze walls would face nothing.
    const cr = cutoutRect(spec);
    if (
      cr &&
      cr.gx < r.gx + r.w && r.gx < cr.gx + cr.w &&
      cr.gy < r.gy + r.h && r.gy < cr.gy + cr.h
    ) {
      throw new Error(
        `Maze region at (${r.gx},${r.gy}) ${r.w}x${r.h} overlaps the room's ${cutout!.corner} cutout at (${cr.gx},${cr.gy}) ${cr.w}x${cr.h} — move the maze or shrink the cutout.`,
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
    if (!entry) {
      if (kind === "dressing") {
        throw new Error(
          `Unknown dressing tile "${p.tile}" — not in the pack. Known props: ${listPropTiles(pack).join(", ")}.`,
        );
      }
      throw new Error(`Unknown ${kind} tile "${p.tile}" — not in the pack manifest.`);
    }
    // A dressing placement must name a dressing-layer tile, and a fog
    // placement a fog tile — a floor tile on the dressing layer would
    // render at the wrong sort and never be listed as a prop.
    const wantLayer = kind === "dressing" ? "dressing" : "atmosphere";
    if (entry.layer !== wantLayer) {
      if (kind === "dressing") {
        throw new Error(
          `"${p.tile}" is a ${entry.layer} tile, not a prop. Known props: ${listPropTiles(pack).join(", ")}.`,
        );
      }
      throw new Error(`Fog tile "${p.tile}" is a ${entry.layer} tile, not an atmosphere tile.`);
    }
    const { w: fw, h: fh } = placementFootprint(p, entry);
    if (p.w !== undefined && (!Number.isInteger(p.w) || p.w < 1)) {
      throw new Error(`${kind} tile "${p.tile}": footprint width must be a whole number of cells >= 1, got ${p.w}.`);
    }
    if (p.h !== undefined && (!Number.isInteger(p.h) || p.h < 1)) {
      throw new Error(`${kind} tile "${p.tile}": footprint height must be a whole number of cells >= 1, got ${p.h}.`);
    }
    // Props and fog are free sprites: gx/gy may be fractional (x =
    // gx*100), so only the footprint must fit the room — no integer
    // cell requirement.
    if (
      !Number.isFinite(p.gx) || !Number.isFinite(p.gy) || p.gx < 0 || p.gy < 0 ||
      p.gx + fw > gridW || p.gy + fh > gridH
    ) {
      throw new Error(
        `${kind} tile "${p.tile}" at (${p.gx},${p.gy}) does not fit in a ${gridW}x${gridH} room.`,
      );
    }
    if (p.alpha !== undefined && (p.alpha < 0 || p.alpha > 1)) {
      throw new Error(`Alpha for "${p.tile}" must be 0..1, got ${p.alpha}.`);
    }
    // No placement may sit on a maze wall cell — a pillar inside a
    // solid maze wall would be invisible and unreachable — or in the
    // cutout of an L-shaped room, where there is no floor under it.
    // The check runs over the integer cells the footprint overlaps, so
    // it stays exact for off-grid sprites.
    for (const c of placementCells(p.gx, p.gy, fw, fh)) {
      if (isMazeWallCell(grids, c.gx, c.gy)) {
        throw new Error(`${kind} tile "${p.tile}" at (${p.gx},${p.gy}) sits on a maze wall cell.`);
      }
      if (isCutoutCell(spec, c.gx, c.gy)) {
        throw new Error(`${kind} tile "${p.tile}" at (${p.gx},${p.gy}) sits in the room's cutout — props cannot float in the void.`);
      }
    }
  };
  for (const p of spec.dressing ?? []) checkPlacement(p, "dressing");
  for (const p of spec.fog ?? []) checkPlacement(p, "fog");
  // Prop ids are the move/remove address — a duplicate makes the
  // address ambiguous, so the spec is rejected rather than guessed at.
  {
    const seen = new Set<string>();
    for (const p of spec.dressing ?? []) {
      if (!p.id) continue;
      if (seen.has(p.id)) {
        throw new Error(`Duplicate prop id "${p.id}" in room spec — each prop needs its own id.`);
      }
      seen.add(p.id);
    }
  }
  // Dressing ids are the click module's address — a duplicate would
  // pair two tiles to one light, so the spec is rejected the same way.
  {
    const seen = new Set<string>();
    for (const p of spec.dressing ?? []) {
      if (!p.dressingId) continue;
      if (seen.has(p.dressingId)) {
        throw new Error(`Duplicate dressing id "${p.dressingId}" in room spec — each dressing item needs its own id.`);
      }
      seen.add(p.dressingId);
    }
  }
  for (const t of spec.torches ?? []) {
    if (t.gx < 0 || t.gx >= gridW || t.gy < 0 || t.gy >= gridH) {
      throw new Error(`Torch at (${t.gx},${t.gy}) is outside a ${gridW}x${gridH} room.`);
    }
    if (isCutoutCell(spec, t.gx, t.gy)) {
      throw new Error(`Torch at (${t.gx},${t.gy}) sits in the room's cutout — torches hang on floor cells.`);
    }
    if (isMazeWallCell(grids, t.gx, t.gy)) {
      throw new Error(`Torch at (${t.gx},${t.gy}) sits on a maze wall cell.`);
    }
  }
  // Diagonal walls: interior 1x1 cells, one per cell, rotation 0/90/
  // 180/270. A diagonal replaces a straight wall tile in its cell, so
  // the cell must be a plain interior floor cell — not on the wall
  // ring, not a maze wall, not in the cutout.
  const seenDiagonals = new Set<string>();
  for (const dg of spec.diagonals ?? []) {
    if (!Number.isInteger(dg.gx) || !Number.isInteger(dg.gy) || dg.gx < 0 || dg.gy < 0 || dg.gx >= gridW || dg.gy >= gridH) {
      throw new Error(`Diagonal wall at (${dg.gx},${dg.gy}) is outside a ${gridW}x${gridH} room.`);
    }
    const rot = dg.rotation ?? 0;
    if (rot !== 0 && rot !== 90 && rot !== 180 && rot !== 270) {
      throw new Error(`Diagonal wall rotation must be 0, 90, 180 or 270, got ${dg.rotation}.`);
    }
    const key = `${dg.gx},${dg.gy}`;
    if (seenDiagonals.has(key)) {
      throw new Error(`Two diagonal walls in cell (${dg.gx},${dg.gy}) — one diagonal per cell.`);
    }
    seenDiagonals.add(key);
    if (isCutoutCell(spec, dg.gx, dg.gy)) {
      throw new Error(`Diagonal wall at (${dg.gx},${dg.gy}) sits in the room's cutout — diagonals live on floor cells.`);
    }
    if (isMazeWallCell(grids, dg.gx, dg.gy)) {
      throw new Error(`Diagonal wall at (${dg.gx},${dg.gy}) sits on a maze wall cell.`);
    }
    if (boundaryDirs(spec, dg.gx, dg.gy).length > 0) {
      throw new Error(
        `Diagonal wall at (${dg.gx},${dg.gy}) sits on the room's wall ring — diagonals are interior walls, not perimeter walls.`,
      );
    }
  }
}

function tileDoc(
  entry: PackEntry,
  serverBase: string,
  gx: number,
  gy: number,
  opts: { elevation: number; sort: number; rotation?: number; alpha?: number; hidden?: boolean; width?: number; height?: number },
): TileDoc {
  return {
    texture: { src: `${serverBase}/${path.basename(entry.file)}` },
    x: gx * TILE_PX,
    y: gy * TILE_PX,
    // Width and height are independent: a non-square piece (or an
    // explicit run footprint) places at its real shape, never forced
    // square by sizePx.
    width: opts.width ?? tileWidthPx(entry),
    height: opts.height ?? tileHeightPx(entry),
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

/** Pixel coords of one cell edge (a collision-wall segment). */
function cellEdgeCoords(dir: WallSide, gx: number, gy: number): { x1: number; y1: number; x2: number; y2: number } {
  switch (dir) {
    case "north": return { x1: gx * TILE_PX, y1: gy * TILE_PX, x2: (gx + 1) * TILE_PX, y2: gy * TILE_PX };
    case "south": return { x1: gx * TILE_PX, y1: (gy + 1) * TILE_PX, x2: (gx + 1) * TILE_PX, y2: (gy + 1) * TILE_PX };
    case "west": return { x1: gx * TILE_PX, y1: gy * TILE_PX, x2: gx * TILE_PX, y2: (gy + 1) * TILE_PX };
    case "east": return { x1: (gx + 1) * TILE_PX, y1: gy * TILE_PX, x2: (gx + 1) * TILE_PX, y2: (gy + 1) * TILE_PX };
  }
}

/** Corner-tile rotation for a cell whose wall faces are these two
 *  adjacent sides (the corner image is drawn with bands at TOP and
 *  LEFT, i.e. the north-west corner). */
function cornerRotationForDirs(dirs: WallSide[]): number {
  const key = [...dirs].sort().join("+");
  switch (key) {
    case "north+west": return 0;
    case "east+north": return 90;
    case "east+south": return 180;
    case "south+west": return 270;
    default: throw new Error(`Corner tile needs two adjacent wall sides, got: ${dirs.join(", ")}.`);
  }
}

/**
 * Wall ring + perimeter collision walls for an L-shaped room: every
 * floor cell whose neighbour is outside the room or in the cutout gets
 * a wall tile — one straight tile per single-sided cell, one corner
 * tile per inner/outer corner cell — and the matching collision
 * segments, merged into runs. Doors replace the straight tile on their
 * cell; openings remove the edge (and its tile when the cell has no
 * other wall side). Validation has already rejected doors on
 * two-sided cells and anything in the cutout, so every cell here has
 * at most two adjacent boundary sides.
 */
function lShapeRing(
  spec: RoomSpec,
  grids: { region: MazeRegionSpec; grid: MazeGrid }[],
  serverBase: string,
  doorAt: Map<string, "door" | "secret">,
  openAt: Set<string>,
  cornerEntry: PackEntry,
  straightEntry: PackEntry,
  doorEntry: PackEntry,
): { tiles: TileDoc[]; walls: WallSpec[] } {
  const { gridW, gridH } = spec;
  const tiles: TileDoc[] = [];
  const walls: WallSpec[] = [];
  const hEdges = new Map<number, [number, number][]>();
  const vEdges = new Map<number, [number, number][]>();
  const addH = (yPx: number, x1: number, x2: number) => {
    const list = hEdges.get(yPx) ?? [];
    list.push([x1, x2]);
    hEdges.set(yPx, list);
  };
  const addV = (xPx: number, y1: number, y2: number) => {
    const list = vEdges.get(xPx) ?? [];
    list.push([y1, y2]);
    vEdges.set(xPx, list);
  };
  // What a cell edge answers to — only outer edges answer: a cutout
  // edge is not a door or an opening, it is just wall.
  const edgeKind = (dir: WallSide, gx: number, gy: number): "door" | "secret" | "open" | null => {
    if (dir === "north" && gy === 0) {
      if (openAt.has(`north:${gx}`)) return "open";
      return doorAt.get(`north:${gx}`) ?? null;
    }
    if (dir === "south" && gy === gridH - 1) {
      if (openAt.has(`south:${gx}`)) return "open";
      return doorAt.get(`south:${gx}`) ?? null;
    }
    if (dir === "west" && gx === 0) {
      if (openAt.has(`west:${gy}`)) return "open";
      return doorAt.get(`west:${gy}`) ?? null;
    }
    if (dir === "east" && gx === gridW - 1) {
      if (openAt.has(`east:${gy}`)) return "open";
      return doorAt.get(`east:${gy}`) ?? null;
    }
    return null;
  };
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      if (isCutoutCell(spec, gx, gy)) continue;
      // Maze wall cells get their own tiles (below) — the ring only
      // walls the room's outline.
      if (isMazeWallCell(grids, gx, gy)) continue;
      // Effective boundary sides: the outline minus opened edges.
      const dirs = boundaryDirs(spec, gx, gy).filter((dir) => edgeKind(dir, gx, gy) !== "open");
      if (dirs.length === 0) continue;
      if (dirs.length > 2) {
        throw new Error(
          `L-shaped room: cell (${gx},${gy}) needs wall faces on ${dirs.join(", ")} — one tile cannot show them all. Widen the room's legs.`,
        );
      }
      if (dirs.length === 2) {
        const key = [...dirs].sort().join("+");
        if (key !== "north+west" && key !== "east+north" && key !== "east+south" && key !== "south+west") {
          throw new Error(
            `L-shaped room: cell (${gx},${gy}) needs wall faces on opposite sides (${dirs.join(" and ")}) — one tile cannot show both. Widen the room's legs.`,
          );
        }
      }
      // Tile: a door cell shows the door tile (a secret door shows the
      // straight tile, like the rectangular ring); a corner cell shows
      // the corner tile; anything else, the straight tile.
      const doorKind = dirs.length === 1 ? edgeKind(dirs[0], gx, gy) : null;
      if (doorKind === "door") {
        tiles.push(tileDoc(doorEntry, serverBase, gx, gy, {
          elevation: 0, sort: LAYER_SORT.wall, rotation: wallRotation(dirs[0]),
        }));
      } else if (dirs.length === 2) {
        tiles.push(tileDoc(cornerEntry, serverBase, gx, gy, {
          elevation: 0, sort: LAYER_SORT.wall, rotation: cornerRotationForDirs(dirs),
        }));
      } else {
        tiles.push(tileDoc(straightEntry, serverBase, gx, gy, {
          elevation: 0, sort: LAYER_SORT.wall, rotation: wallRotation(dirs[0]),
        }));
      }
      // Collision: a door edge is its own segment (door 1, secret 2);
      // plain edges merge into runs (the door cell's segment is absent
      // from the maps, so runs break at doors).
      for (const dir of dirs) {
        const kind = edgeKind(dir, gx, gy);
        const { x1, y1, x2, y2 } = cellEdgeCoords(dir, gx, gy);
        if (kind === "door" || kind === "secret") {
          walls.push({ x1, y1, x2, y2, door: kind === "door" ? 1 : 2 });
        } else if (dir === "north" || dir === "south") {
          addH(y1, x1, x2);
        } else {
          addV(x1, y1, y2);
        }
      }
    }
  }
  for (const [y, segs] of hEdges) {
    for (const [x1, x2] of mergeRuns(segs)) walls.push({ x1, y1: y, x2, y2: y, door: 0 });
  }
  for (const [x, segs] of vEdges) {
    for (const [y1, y2] of mergeRuns(segs)) walls.push({ x1: x, y1, x2: x, y2: y2, door: 0 });
  }
  return { tiles, walls };
}

/**
 * Pure composition: turn a room spec + pack into the exact Tile, Wall
 * and Light documents for the room. No Foundry involved — unit-testable.
 * Deterministic for a given spec (floor variants come from a seeded RNG).
 *
 * @param serverBase server folder the pack was uploaded to,
 *   e.g. "worlds/testbed" — tile srcs are `${serverBase}/<file>`.
 * @param theme an explicit theme (one-word name or ThemeSpec) — it
 *   overrides `spec.theme`; with neither, the room builds in the
 *   dungeon baseline, exactly as before themes existed (FR-2).
 */
export function layoutRoom(
  spec: RoomSpec,
  pack: Pack,
  serverBase: string,
  theme?: string | ThemeSpec,
): RoomLayout {
  validateSpec(spec, pack);
  const resolved = resolveTheme(theme ?? spec.theme);
  // A theme is a pack variant, not a rebuild: every tile it names must
  // exist. Fail loudly here, naming the theme + the missing tile, so a
  // re-skin never silently builds the wrong look (or a half look).
  const gaps = themeTileGaps(resolved, pack);
  if (gaps.length > 0) {
    throw new Error(
      `Theme "${resolved.id}" needs tile${gaps.length > 1 ? "s" : ""} not in the pack: ${gaps.join(", ")} — generate the pack first, or pick another theme.`,
    );
  }
  const { gridW, gridH } = spec;
  const width = gridW * TILE_PX;
  const height = gridH * TILE_PX;
  const tiles: TileDoc[] = [];
  const rng = mulberry32(spec.seed ?? 1);
  const grids = mazeGridsFor(spec);

  // Floor: one tile per cell. "mixed" rolls plain/cracked/rubble;
  // "dark" uses the theme's dark floor for the whole room. Maze wall
  // cells get no floor tile (a wall tile goes there instead). Overlays
  // remap the rolled tile name inside their region, in order (later
  // wins). Overlay variants name pack tiles directly — a themed room
  // needs the theme's tile names there (e.g. "floor-sand" under
  // western), because the roll already picked the themed tile.
  const f = resolved.floor;
  const floorNames =
    spec.floorStyle === "dark"
      ? [f.dark]
      : [f.plain, f.plain, f.plain, f.plain, f.plain, f.plain, f.cracked, f.cracked, f.cracked, f.rubble];
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      if (isMazeWallCell(grids, gx, gy)) continue;
      // An L-shaped room's cutout is void — no floor tile there.
      if (isCutoutCell(spec, gx, gy)) continue;
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
  const cornerEntry = pack.get(resolved.wall.corner);
  const straightEntry = pack.get(resolved.wall.straight);
  const doorEntry = pack.get(resolved.wall.door);
  if (!cornerEntry || !straightEntry || !doorEntry) {
    throw new Error(
      `Theme "${resolved.id}" is missing a wall tile ("${resolved.wall.corner}", "${resolved.wall.straight}" or "${resolved.wall.door}").`,
    );
  }
  // The perimeter collision walls: the L-shaped ring builds them (the
  // outline is not four sides), otherwise they are built per side
  // below, in the collision-walls section.
  let perimeterWalls: WallSpec[] | null = null;
  if (spec.cutout) {
    const ring = lShapeRing(spec, grids, serverBase, doorAt, openAt, cornerEntry, straightEntry, doorEntry);
    tiles.push(...ring.tiles);
    perimeterWalls = ring.walls;
  } else {
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
  }

  // Maze walls: a wall-straight tile facing the first open neighbour
  // (the band faces the walkable floor, like the ring's wall tiles), or
  // the theme's dark floor for a wall cell enclosed on all sides.
  const darkEntry = pack.get(resolved.floor.dark);
  if (!darkEntry) throw new Error(`Theme "${resolved.id}" is missing floor tile "${resolved.floor.dark}".`);
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

  // Diagonal walls: the wall-diagonal tile (band corner to corner,
  //  face on one side) plus a diagonal collision wall, collected here
  //  and added to the collision walls below. The tile name is derived
  //  from the theme's straight wall — wall-straight becomes
  //  wall-diagonal — and a theme with no diagonal tile fails loudly
  //  instead of borrowing another theme's stone.
  const diagonalWalls: WallSpec[] = [];
  for (const dg of spec.diagonals ?? []) {
    const diagonalName = resolved.wall.straight.replace("straight", "diagonal");
    const diagonalEntry =
      diagonalName === resolved.wall.straight ? undefined : pack.get(diagonalName);
    if (!diagonalEntry) {
      throw new Error(
        `Theme "${resolved.id}" has no diagonal wall tile ("${diagonalName}") — the pack's diagonal wall is "wall-diagonal". Generate the pack first, or build the room in the dungeon theme.`,
      );
    }
    const rot = dg.rotation ?? 0;
    tiles.push(tileDoc(diagonalEntry, serverBase, dg.gx, dg.gy, {
      elevation: 0, sort: LAYER_SORT.wall, rotation: rot,
    }));
    const x0 = dg.gx * TILE_PX;
    const y0 = dg.gy * TILE_PX;
    const x1 = (dg.gx + 1) * TILE_PX;
    const y1 = (dg.gy + 1) * TILE_PX;
    // Rotation 0/180 is the NW→SE diagonal; 90/270 is NE→SW.
    if (rot === 0 || rot === 180) diagonalWalls.push({ x1: x0, y1: y0, x2: x1, y2: y1, door: 0 });
    else diagonalWalls.push({ x1, y1: y0, x2: x0, y2: y1, door: 0 });
  }

  // Dressing: bones, rubble, pillars — under the tokens, above the floor.
  // The theme remaps dressing names (a spec that says "bones" gets the
  // theme's equivalent when one exists); with no remap the tile is used
  // as named. The remapped tile was already checked against the pack
  // by the theme-gap check above.
  for (const p of spec.dressing ?? []) {
    const tileName = resolved.dressing[p.tile] ?? p.tile;
    const entry = pack.get(tileName);
    if (!entry) throw new Error(`Unknown dressing tile "${tileName}" (theme "${resolved.id}").`);
    const { w: fw, h: fh } = placementFootprint(p, entry);
    const doc = tileDoc(entry, serverBase, p.gx, p.gy, {
      elevation: 0, sort: LAYER_SORT.dressing, rotation: p.rotation, alpha: p.alpha, hidden: p.hidden,
      width: fw * TILE_PX, height: fh * TILE_PX,
    });
    // Interactive dressing (FR-16): the tile carries its item id so
    // the click module can find it — the light _id, kind and alpha
    // join the flag in the hook's pairing step, after the light is
    // created (the _id does not exist at layout time).
    if (p.dressingId) doc.flags = { meroki: { dressingId: p.dressingId } };
    tiles.push(doc);
  }

  // Atmosphere: fog wisps float above everything (elevation 1), so they
  // drift over tokens too. Toggleable with `hidden`. The theme remaps
  // fog names — a spec written with green fog re-skins to dust under
  // the western theme, with no change to the spec itself.
  for (const p of spec.fog ?? []) {
    const tileName = resolved.atmosphere[p.tile] ?? p.tile;
    const entry = pack.get(tileName);
    if (!entry) throw new Error(`Unknown fog tile "${tileName}" (theme "${resolved.id}").`);
    const { w: fw, h: fh } = placementFootprint(p, entry);
    tiles.push(tileDoc(entry, serverBase, p.gx, p.gy, {
      elevation: FOG_ELEVATION, sort: 0, rotation: p.rotation, alpha: p.alpha, hidden: p.hidden,
      width: fw * TILE_PX, height: fh * TILE_PX,
    }));
  }

  // Collision walls: the perimeter, split around the door cells. A door
  // cell becomes a door segment (door: 1); a secret door cell becomes a
  // secret segment (door: 2); an opening cell gets no wall at all; the
  // rest are plain walls. Then the diagonal walls and the merged maze walls.
  const walls: WallSpec[] = [];
  if (perimeterWalls) {
    walls.push(...perimeterWalls);
  } else {
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
  }
  walls.push(...diagonalWalls);
  walls.push(...mazeCollisionWalls(spec, grids));

  // Lights: torch shorthand (the theme's light palette) + explicit
  // light specs. A western torch is lantern gold; the dungeon torch is
  // the warm amber from the Lich's Lair lighting fix.
  const lights: LightSpec[] = [
    ...(spec.torches ?? []).map((t) => ({
      x: t.gx * TILE_PX + TILE_PX / 2,
      y: t.gy * TILE_PX + TILE_PX / 2,
      dim: resolved.torch.dim,
      bright: resolved.torch.bright,
      color: resolved.torch.color,
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
  /** Floor number (FR-3): 0 is the ground floor (the default), 1 the
   *  floor above, and so on. Stair links connect rooms on different
   *  floors; the direction ("up"/"down") is derived from the floor
   *  numbers, never stored. */
  floor?: number;
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

/**
 * A gate condition (FR-3): what must be true before a staircase can
 * be climbed / its floor revealed. The state it reads is a plain
 * record of facts (see GateState in src/worldbuilding/floors.ts):
 * which pressure plates are solved, which doors are unlocked, which
 * levers are pulled. `all` / `any` compose; `always` is the
 * ungated stair.
 */
export type GateCondition =
  | { kind: "always" }
  | { kind: "plate-solved"; plate: string }
  | { kind: "door-unlocked"; door: string }
  | { kind: "lever-pulled"; lever: string }
  | { kind: "all"; gates: GateCondition[] }
  | { kind: "any"; gates: GateCondition[] };

/** A staircase between two rooms on different floors (FR-3). The
 *  ends are declared doors or openings, like a door link; the
 *  direction is derived from the rooms' floor numbers. */
export interface StairLink {
  from: DoorEnd;
  to: DoorEnd;
  /** Gate that must be satisfied before the stair can be climbed and
   *  its floor revealed. Absent = always open. */
  gate?: GateCondition;
}

export interface DungeonSpec {
  rooms: DungeonRoomSpec[];
  links: DoorLink[];
  /** Staircases between floors (FR-3) — validated like door links,
   *  plus the two ends must be on different floors. */
  stairs?: StairLink[];
}

/** A link end with the arrival cell: the cell just inside the door. */
export interface ResolvedDoorEnd extends DoorEnd {
  /** Cell just inside the door, where the party arrives. */
  enterGx: number;
  enterGy: number;
  /** The floor the room is on (FR-3) — 0 when the room sets none. */
  floor: number;
}

export interface ResolvedDoorLink {
  from: ResolvedDoorEnd;
  to: ResolvedDoorEnd;
}

/** A staircase with the arrival cells resolved (FR-3). */
export interface ResolvedStairLink {
  from: ResolvedDoorEnd;
  to: ResolvedDoorEnd;
  /** Derived from the rooms' floor numbers — never stored. */
  direction: "up" | "down";
  gate?: GateCondition;
}

export interface DungeonLayout {
  rooms: { id: string; name: string; layout: RoomLayout }[];
  links: ResolvedDoorLink[];
  /** Resolved staircases (FR-3) — empty when the dungeon is single-floor. */
  stairs: ResolvedStairLink[];
}

/** "up" when the destination floor is above the source floor. */
export function stairDirection(fromFloor: number, toFloor: number): "up" | "down" {
  return toFloor > fromFloor ? "up" : "down";
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
 * duplicate or empty room ids, a non-integer or negative floor, a link
 * end naming an unknown room or a cell that is not a declared door in
 * that room, a door used in two links, a self-link, a duplicated link,
 * a stair whose ends are on the same floor (or break any link rule),
 * or a room unreachable from the first room (the dungeon must be one
 * connected graph — stairs count as edges).
 *
 * @param theme a dungeon-level theme (one-word name or ThemeSpec) —
 *   it overrides each room's own `theme`, so one call re-skins the
 *   whole dungeon (FR-2). With neither, every room builds in its own
 *   theme (or the dungeon baseline).
 */
export function layoutDungeon(
  spec: DungeonSpec,
  pack: Pack,
  serverBase: string,
  theme?: string | ThemeSpec,
): DungeonLayout {
  if (spec.rooms.length === 0) throw new Error("A dungeon needs at least one room.");
  const roomById = new Map<string, DungeonRoomSpec>();
  for (const room of spec.rooms) {
    if (!room.id) throw new Error("Every dungeon room needs a non-empty id.");
    if (roomById.has(room.id)) throw new Error(`Duplicate room id "${room.id}".`);
    const floor = room.floor ?? 0;
    if (!Number.isInteger(floor) || floor < 0) {
      throw new Error(`Room "${room.id}": "floor" must be a non-negative integer, got ${JSON.stringify(room.floor)}.`);
    }
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
  const resolveEnd = (end: DoorEnd, room: DungeonRoomSpec): ResolvedDoorEnd => {
    const { gx, gy } = doorEntryCell(end.wall, end.at, room.gridW, room.gridH);
    return { ...end, enterGx: gx, enterGy: gy, floor: room.floor ?? 0 };
  };
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
    resolved.push({
      from: resolveEnd(link.from, fromRoom),
      to: resolveEnd(link.to, toRoom),
    });
  }
  // Staircases (FR-3): same end rules as door links — ends must be
  // declared doors/openings, one door one destination — plus the two
  // ends must be on different floors. A stair's gate is validated by
  // validateGate (floors.ts), not here: layout only needs the ends.
  const seenStairs = new Set<string>();
  const resolvedStairs: ResolvedStairLink[] = [];
  for (const stair of spec.stairs ?? []) {
    const fromRoom = roomById.get(stair.from.room);
    const toRoom = roomById.get(stair.to.room);
    if (!fromRoom) throw new Error(`Stair names unknown room "${stair.from.room}".`);
    if (!toRoom) throw new Error(`Stair names unknown room "${stair.to.room}".`);
    if (stair.from.room === stair.to.room) {
      throw new Error(`Stair from room "${stair.from.room}" to itself — a staircase must lead to another room.`);
    }
    const fromKey = doorKey(stair.from);
    const toKey = doorKey(stair.to);
    if (!doorEnds.has(fromKey)) {
      throw new Error(`Stair end ${fromKey} is not a declared door or opening in room "${stair.from.room}".`);
    }
    if (!doorEnds.has(toKey)) {
      throw new Error(`Stair end ${toKey} is not a declared door or opening in room "${stair.to.room}".`);
    }
    const pairKey = [fromKey, toKey].sort().join("<>");
    if (seenStairs.has(pairKey)) throw new Error(`Duplicate stair between ${fromKey} and ${toKey}.`);
    if (usedEnds.has(fromKey) || usedEnds.has(toKey)) {
      throw new Error(`Door ${usedEnds.has(fromKey) ? fromKey : toKey} is used in two links — one door, one destination.`);
    }
    const fromFloor = fromRoom.floor ?? 0;
    const toFloor = toRoom.floor ?? 0;
    if (fromFloor === toFloor) {
      throw new Error(
        `Stair between ${fromKey} and ${toKey} stays on floor ${fromFloor} — a staircase must connect different floors (rooms "${stair.from.room}" and "${stair.to.room}").`,
      );
    }
    usedEnds.add(fromKey);
    usedEnds.add(toKey);
    seenStairs.add(pairKey);
    resolvedStairs.push({
      from: resolveEnd(stair.from, fromRoom),
      to: resolveEnd(stair.to, toRoom),
      direction: stairDirection(fromFloor, toFloor),
      ...(stair.gate !== undefined ? { gate: stair.gate } : {}),
    });
  }
  // Connectivity: every room reachable from the first, over the links
  // and the stairs — a stair is a graph edge like any door.
  const neighbours = new Map<string, Set<string>>();
  for (const room of spec.rooms) neighbours.set(room.id, new Set());
  for (const link of resolved) {
    neighbours.get(link.from.room)!.add(link.to.room);
    neighbours.get(link.to.room)!.add(link.from.room);
  }
  for (const stair of resolvedStairs) {
    neighbours.get(stair.from.room)!.add(stair.to.room);
    neighbours.get(stair.to.room)!.add(stair.from.room);
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
      layout: layoutRoom(room, pack, serverBase, theme),
    })),
    links: resolved,
    stairs: resolvedStairs,
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
    // Diagonals shift with the room like any other placement. The
    // cutout is corner-relative, so it needs no shift — it stays
    // anchored to the same corner at the same size.
    diagonals: spec.diagonals?.map((d) => ({ ...d, gx: d.gx + dx, gy: d.gy + dy })),
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

/**
 * The canonical wet-variant map (FR-13, BRA-226): every dungeon floor
 * tile and the wet tile that replaces it when a region goes
 * underwater. Wet tiles are real pack tiles
 * (tiles/procedural/generate_tiles.py, WET_PACK) — the wet variant of
 * a floor is the same stone under shallow water, so a wet region reads
 * as the same room, flooded, not a different floor.
 */
export const WET_VARIANTS: Record<string, string> = {
  "floor-plain": "floor-wet",
  "floor-cracked": "floor-wet-cracked",
  "floor-rubble": "floor-wet-rubble",
  "floor-dark": "floor-wet-dark",
};

/**
 * Build a wet-region overlay (FR-13): the given rectangular region
 * goes underwater. `bases` defaults to every dungeon floor — a cell
 * whose floor is not a listed base keeps its tile. An unknown base
 * throws, listing the bases that have wet variants: a western room
 * (floor-sand) has no wet tiles yet, and wetting it must fail loudly
 * instead of mapping sand to dungeon wet stone or silently leaving
 * it dry.
 */
export function wetOverlay(gx: number, gy: number, w: number, h: number, bases?: string[]): FloorOverlay {
  const wanted = bases ?? Object.keys(WET_VARIANTS);
  if (wanted.length === 0) {
    throw new Error("wetOverlay needs at least one base floor tile.");
  }
  const variants: Record<string, string> = {};
  for (const base of wanted) {
    const wet = WET_VARIANTS[base];
    if (!wet) {
      throw new Error(
        `No wet variant for "${base}" — wet variants exist for: ${Object.keys(WET_VARIANTS).join(", ")}.`,
      );
    }
    variants[base] = wet;
  }
  return { gx, gy, w, h, variants };
}

/**
 * Apply a wet-region overlay to a room spec (FR-13): the region goes
 * underwater, the rest of the room is untouched. Pure spec edit — the
 * composer applies it at layout time; later overlays win.
 */
export function applyWetOverlay(
  spec: RoomSpec,
  gx: number,
  gy: number,
  w: number,
  h: number,
  bases?: string[],
): RoomSpec {
  return applyOverlay(spec, wetOverlay(gx, gy, w, h, bases));
}

// ---------------------------------------------------------------------------
// Props (FR-6): the room's dressing placements, as addressable data.
// ---------------------------------------------------------------------------

/** Dressing-layer tiles are the props — every tile the pack marks for
 *  the dressing layer, sorted. No brazier or candle tile exists yet
 *  (a pack gap), so neither appears here. */
export function listPropTiles(pack: Pack): string[] {
  return [...pack.values()].filter((e) => e.layer === "dressing").map((e) => e.name).sort();
}

/** The address of a placement: its id when it has one, else tile@cell
 *  (e.g. `bones@2,2`). The synthesized form is what move/remove accept
 *  for placements written before ids existed. */
export function propIdOf(p: Placement): string {
  return p.id ?? `${p.tile}@${p.gx},${p.gy}`;
}

/** One prop, as the room lists it: every dressing placement with its
 *  address, in spec order. */
export interface PropEntry {
  id: string;
  tile: string;
  gx: number;
  gy: number;
  rotation?: number;
  alpha?: number;
  hidden?: boolean;
  w?: number;
  h?: number;
}

export function listProps(spec: RoomSpec): PropEntry[] {
  return (spec.dressing ?? []).map((p) => ({
    id: propIdOf(p),
    tile: p.tile,
    gx: p.gx,
    gy: p.gy,
    ...(p.rotation !== undefined ? { rotation: p.rotation } : {}),
    ...(p.alpha !== undefined ? { alpha: p.alpha } : {}),
    ...(p.hidden !== undefined ? { hidden: p.hidden } : {}),
    ...(p.w !== undefined ? { w: p.w } : {}),
    ...(p.h !== undefined ? { h: p.h } : {}),
  }));
}

function describeProps(spec: RoomSpec): string {
  const props = listProps(spec);
  if (props.length === 0) return "no props";
  return props.map((p) => `"${p.tile}" at (${p.gx},${p.gy})`).join(", ");
}

/** Next free `prop-<n>` id: one past the highest prop number in the
 *  room. Monotonic — a freed number is never reused, so a GM's notes
 *  ("move prop-2") never silently rebind to a different prop. */
function nextPropId(spec: RoomSpec): string {
  let max = 0;
  for (const p of spec.dressing ?? []) {
    if (!p.id) continue;
    const m = /^prop-(\d+)$/.exec(p.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `prop-${max + 1}`;
}

/**
 * Place a prop in a room (FR-6): append it to the room's dressing
 * list with a fresh id. Pure — returns a new spec, never mutates the
 * input. The tile must be a dressing-layer tile; anything else is
 * rejected with the known props listed. The result is validated
 * through validateRoomSpec (bounds, maze walls, alpha), so a placed
 * prop is one the composer will accept.
 */
export function placeProp(
  spec: RoomSpec,
  input: { tile: string; gx: number; gy: number; rotation?: number; alpha?: number; hidden?: boolean; w?: number; h?: number },
  pack: Pack,
): RoomSpec {
  const known = listPropTiles(pack);
  if (!known.includes(input.tile)) {
    const entry = pack.get(input.tile);
    if (!entry) {
      throw new Error(`Unknown prop "${input.tile}" — not in the pack. Known props: ${known.join(", ")}.`);
    }
    throw new Error(`"${input.tile}" is a ${entry.layer} tile, not a prop. Known props: ${known.join(", ")}.`);
  }
  const next: RoomSpec = {
    ...spec,
    dressing: [
      ...(spec.dressing ?? []),
      {
        tile: input.tile,
        gx: input.gx,
        gy: input.gy,
        ...(input.rotation !== undefined ? { rotation: input.rotation } : {}),
        ...(input.alpha !== undefined ? { alpha: input.alpha } : {}),
        ...(input.hidden !== undefined ? { hidden: input.hidden } : {}),
        ...(input.w !== undefined ? { w: input.w } : {}),
        ...(input.h !== undefined ? { h: input.h } : {}),
        id: nextPropId(spec),
      },
    ],
  };
  validateSpec(next, pack);
  return next;
}

/**
 * How a prop is addressed by move/remove: its id (`prop-1`), its
 * synthesized address (`bones@2,2`), a bare tile name when the room
 * holds exactly one of that tile (`bones`), or a tile + cell
 * (`{tile: "bones", gx: 2, gy: 2}`). Anything ambiguous or missing
 * throws, naming what the room actually has — never guess.
 */
export type PropTarget = string | { tile: string; gx: number; gy: number };

function resolvePropIndex(spec: RoomSpec, target: PropTarget): number {
  const props = spec.dressing ?? [];
  if (typeof target === "string") {
    const byId = props.findIndex((p) => p.id === target);
    if (byId !== -1) return byId;
    const byAddr = props.map((p, i) => ({ p, i })).filter(({ p }) => propIdOf(p) === target);
    if (byAddr.length === 1) return byAddr[0].i;
    if (byAddr.length > 1) {
      throw new Error(
        `More than one prop answers to "${target}" — the room has ${describeProps(spec)}. Remove the duplicates by rebuilding the spec.`,
      );
    }
    const byTile = props.map((p, i) => ({ p, i })).filter(({ p }) => p.tile === target);
    if (byTile.length === 1) return byTile[0].i;
    if (byTile.length > 1) {
      throw new Error(
        `More than one "${target}" in this room — say which one: ${byTile.map(({ p }) => `"${target}" at (${p.gx},${p.gy})`).join(", ")}.`,
      );
    }
    throw new Error(`No prop "${target}" in this room — the room has: ${describeProps(spec)}.`);
  }
  const hits = props
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.tile === target.tile && p.gx === target.gx && p.gy === target.gy);
  if (hits.length === 1) return hits[0].i;
  if (hits.length > 1) {
    throw new Error(
      `More than one "${target.tile}" at (${target.gx},${target.gy}) — the room has ${describeProps(spec)}. Remove the duplicates by rebuilding the spec.`,
    );
  }
  throw new Error(
    `No "${target.tile}" at (${target.gx},${target.gy}) in this room — the room has: ${describeProps(spec)}.`,
  );
}

/**
 * Move a prop to another cell (FR-6). Pure — returns a new spec with
 * the prop's id kept, so a later rebuild still places the same prop.
 * The destination is validated (bounds, maze walls) through
 * validateRoomSpec.
 */
export function moveProp(spec: RoomSpec, target: PropTarget, to: { gx: number; gy: number }, pack: Pack): RoomSpec {
  const idx = resolvePropIndex(spec, target);
  const dressing = [...(spec.dressing ?? [])];
  dressing[idx] = { ...dressing[idx], gx: to.gx, gy: to.gy };
  const next: RoomSpec = { ...spec, dressing };
  validateSpec(next, pack);
  return next;
}

/** Remove a prop from a room (FR-6). Pure — returns a new spec without
 *  it; the remaining props keep their ids and cells. */
export function removeProp(spec: RoomSpec, target: PropTarget): RoomSpec {
  const idx = resolvePropIndex(spec, target);
  const dressing = [...(spec.dressing ?? [])];
  dressing.splice(idx, 1);
  return { ...spec, dressing };
}

// ---------------------------------------------------------------------------
// Cutscene prop recording (BRA-242): a prop played by a cutscene step
// lands in the room spec, so a rebuild of the room puts it back.
// ---------------------------------------------------------------------------

/** A played cutscene `prop` step, in the player's pixel coordinates. */
export interface CutscenePropInput {
  /** Texture src as played, e.g. "worlds/testbed/bones.png". */
  src: string;
  /** Top-left corner, in scene px. */
  x: number;
  y: number;
  width?: number;
  height?: number;
  rotation?: number;
  alpha?: number;
  hidden?: boolean;
}

export interface RecordCutscenePropResult {
  /** The spec with the prop recorded (unchanged when not recorded). */
  spec: RoomSpec;
  recorded: boolean;
  /** The pack tile the src resolved to. */
  tile: string;
  /** Spec cell the prop was recorded at (fractional cells allowed). */
  gx: number;
  gy: number;
  /** The fresh `prop-<n>` id, when recorded. */
  propId?: string;
  /** What happened, in plain words — the step log carries this. */
  note: string;
}

/**
 * Resolve a played texture src to a prop tile name, by the file's
 * basename: the composer uploads tiles as
 * `${serverBase}/<basename of the pack file>`, so
 * "worlds/testbed/bones.png" is the pack's "bones" tile. A src that
 * matches no dressing tile throws, listing the known props — a
 * one-off image (or a floor tile) cannot live in the room spec, and
 * that must fail loudly at record time, not silently drop the prop.
 * A basename shared by two dressing tiles is ambiguous and throws,
 * naming both.
 */
export function propTileNameForSrc(pack: Pack, src: string): string {
  const known = listPropTiles(pack);
  const base = path.basename(src);
  const hits = known.filter((name) => path.basename(pack.get(name)?.file ?? "") === base);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new Error(
      `Prop src "${src}" matches more than one prop tile: ${hits.map((h) => `"${h}"`).join(", ")} — record it by tile name instead.`,
    );
  }
  throw new Error(
    `Prop src "${src}" is not a prop tile in the pack. Known props: ${known.join(", ")}.`,
  );
}

/**
 * Record a played cutscene prop in the room spec (BRA-242): the
 * played tile becomes a dressing placement via placeProp, so the
 * next rebuild of the room puts it back at the same cell. Pure —
 * returns a new spec, never mutates the input.
 *
 * - Position is exact: props are free sprites, so gx/gy keep the
 *   fractional cell (x/100) instead of snapping to a grid cell.
 * - Footprint must be whole cells (validateSpec's rule), so the
 *   played px size rounds to the nearest whole-cell w/h (min 1);
 *   a 150px-wide prop records as 2 cells wide, not 1.5.
 * - A re-play is a no-op for the spec: a prop with the same tile,
 *   cell, and rotation is already recorded, so it is reported as
 *   such instead of appending a duplicate. (The Tile create itself
 *   still duplicates on a re-run — the known player limit; the spec
 *   at least does not.)
 * - Throws when the src is not a pack prop, or when the placement
 *   fails validation (outside the room, on a maze wall, bad alpha).
 *   The player catches that and reports it on the step instead of
 *   failing the play — the prop is on the table, it just will not
 *   survive a rebuild.
 */
export function recordCutsceneProp(
  spec: RoomSpec,
  step: CutscenePropInput,
  pack: Pack,
): RecordCutscenePropResult {
  const tile = propTileNameForSrc(pack, step.src);
  const gx = step.x / TILE_PX;
  const gy = step.y / TILE_PX;
  const w = Math.max(1, Math.round((step.width ?? 100) / TILE_PX));
  const h = Math.max(1, Math.round((step.height ?? 100) / TILE_PX));
  const rotation = step.rotation ?? 0;
  const existing = (spec.dressing ?? []).find(
    (p) => p.tile === tile && p.gx === gx && p.gy === gy && (p.rotation ?? 0) === rotation,
  );
  if (existing) {
    return {
      spec,
      recorded: false,
      tile,
      gx,
      gy,
      note: `"${tile}" at (${gx},${gy}) is already in the room spec${existing.id ? ` as ${existing.id}` : ""} — not recorded twice.`,
    };
  }
  const next = placeProp(
    spec,
    {
      tile,
      gx,
      gy,
      ...(step.rotation !== undefined ? { rotation: step.rotation } : {}),
      ...(step.alpha !== undefined ? { alpha: step.alpha } : {}),
      ...(step.hidden !== undefined ? { hidden: step.hidden } : {}),
      w,
      h,
    },
    pack,
  );
  const placed = next.dressing?.[next.dressing.length - 1];
  return {
    spec: next,
    recorded: true,
    tile,
    gx,
    gy,
    propId: placed?.id,
    note: `Recorded "${tile}" at (${gx},${gy})${placed?.id ? ` as ${placed.id}` : ""} — a rebuild puts it back.`,
  };
}
