/**
 * Maze generation + mutable-map layout math (PURE — no Foundry, no network).
 *
 * FR-12 (docs/realtime-adventure-construction.md): maps are data, so they
 * must be mutable. "Along this wall, make a corridor north for 100
 * meters, then turn it into a small maze" is a layout operation on the
 * room/dungeon spec plus a small script (this generator) run locally —
 * the composer turns the result into tiles, no new images.
 *
 * The generator is an iterative recursive backtracker (documented choice
 * below). It is seeded (mulberry32, same PRNG as the composer) so the
 * same seed gives the same maze and "different maze" is just a re-roll.
 * The layout operations (addCorridor / carveMazeRegion / widenRoom /
 * applyOverlay) live in `tiles-layout.ts` next to the RoomSpec they edit;
 * this module holds the maze itself plus the unit converter.
 */

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

export type MazeSide = "north" | "south" | "east" | "west";

/** Length units the creator speaks in. PF2e: 1 square = 5 ft = 1.524 m. */
export type LengthUnit = "m" | "meters" | "ft" | "feet" | "squares";

/** Metres in one PF2e grid square (5 ft exactly). */
export const METERS_PER_SQUARE = 1.524;
/** Feet in one PF2e grid square. */
export const FEET_PER_SQUARE = 5;

/**
 * Convert a creator length to grid squares (rounded to the nearest
 * square, minimum 1). 100 m -> 66 squares, 5 ft -> 1, 10 squares -> 10.
 */
export function toSquares(value: number, unit: LengthUnit = "squares"): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Length must be a positive number, got ${value}.`);
  }
  switch (unit) {
    case "squares": return Math.max(1, Math.round(value));
    case "m":
    case "meters": return Math.max(1, Math.round(value / METERS_PER_SQUARE));
    case "ft":
    case "feet": return Math.max(1, Math.round(value / FEET_PER_SQUARE));
  }
}

/**
 * A perfect maze on a cell grid, rendered as a tile grid.
 *
 * The tile grid is (2*cellsW+1) x (2*cellsH+1): odd/odd positions are
 * maze cells (always floor), the cells between two carved cells are
 * passages (floor when the generator carved through, wall otherwise),
 * and the outer border is wall except for the entrance/exit openings.
 * `true` = floor (walkable), `false` = wall.
 */
export interface MazeGrid {
  /** Maze size in cells (not tiles). */
  cellsW: number;
  cellsH: number;
  /** Tile grid size: w = 2*cellsW+1, h = 2*cellsH+1. */
  w: number;
  h: number;
  /** grid[gy][gx]: true = floor, false = wall. */
  grid: boolean[][];
  entrance: { gx: number; gy: number; side: MazeSide };
  exit: { gx: number; gy: number; side: MazeSide };
  seed: number;
}

export interface MazeOptions {
  entranceSide?: MazeSide;
  /** Cell index along the entrance side (0..cells-1). Default: middle. */
  entranceAt?: number;
  exitSide?: MazeSide;
  /** Cell index along the exit side (0..cells-1). Default: middle. */
  exitAt?: number;
}

export function oppositeSide(side: MazeSide): MazeSide {
  return { north: "south", south: "north", east: "west", west: "east" }[side] as MazeSide;
}

function cellsAlongSide(side: MazeSide, cellsW: number, cellsH: number): number {
  return side === "north" || side === "south" ? cellsW : cellsH;
}

/** Border tile coords of the opening for a cell index on a side. */
function openingCell(
  side: MazeSide,
  at: number,
  w: number,
  h: number,
): { gx: number; gy: number } {
  switch (side) {
    case "north": return { gx: 2 * at + 1, gy: 0 };
    case "south": return { gx: 2 * at + 1, gy: h - 1 };
    case "west": return { gx: 0, gy: 2 * at + 1 };
    case "east": return { gx: w - 1, gy: 2 * at + 1 };
  }
}

/**
 * Generate a perfect maze (seeded, deterministic).
 *
 * Why recursive backtracker: it carves one long winding spanning tree,
 * so the maze reads as connected corridors with long runs and a few
 * deep dead ends — the dungeon feel — rather than Prim's many short
 * branches. The spanning-tree construction is also what makes the
 * "perfect" property provable: exactly (cells - 1) passages, exactly
 * one simple path between any two cells. Implemented iteratively (an
 * explicit stack), so a big maze cannot blow the call stack.
 */
export function generateMaze(
  cellsW: number,
  cellsH: number,
  seed: number,
  opts: MazeOptions = {},
): MazeGrid {
  if (!Number.isInteger(cellsW) || !Number.isInteger(cellsH) || cellsW < 1 || cellsH < 1) {
    throw new Error(`Maze needs at least 1x1 cells, got ${cellsW}x${cellsH}.`);
  }
  const entranceSide = opts.entranceSide ?? "north";
  const exitSide = opts.exitSide ?? oppositeSide(entranceSide);
  const entranceAt = opts.entranceAt ?? Math.floor(cellsAlongSide(entranceSide, cellsW, cellsH) / 2);
  const exitAt = opts.exitAt ?? Math.floor(cellsAlongSide(exitSide, cellsW, cellsH) / 2);
  for (const [name, side, at] of [
    ["entrance", entranceSide, entranceAt],
    ["exit", exitSide, exitAt],
  ] as const) {
    const n = cellsAlongSide(side, cellsW, cellsH);
    if (!Number.isInteger(at) || at < 0 || at > n - 1) {
      throw new Error(`Maze ${name} cell ${at} is out of range 0..${n - 1} on the ${side} side.`);
    }
  }

  const w = 2 * cellsW + 1;
  const h = 2 * cellsH + 1;
  const grid: boolean[][] = Array.from({ length: h }, () => Array<boolean>(w).fill(false));
  const rng = mulberry32(seed);

  // Cell (cx, cy) lives at tile (2*cx+1, 2*cy+1). Carve a spanning tree
  // over the cells: every cell visited once, passages = cells - 1.
  const visited: boolean[][] = Array.from({ length: cellsH }, () => Array<boolean>(cellsW).fill(false));
  const stack: [number, number][] = [[0, 0]];
  visited[0][0] = true;
  grid[1][1] = true;
  const DIRS: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  while (stack.length > 0) {
    const [cx, cy] = stack[stack.length - 1];
    const unvisited: [number, number][] = [];
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx >= 0 && nx < cellsW && ny >= 0 && ny < cellsH && !visited[ny][nx]) {
        unvisited.push([nx, ny]);
      }
    }
    if (unvisited.length === 0) {
      stack.pop();
      continue;
    }
    const [nx, ny] = unvisited[Math.floor(rng() * unvisited.length)];
    visited[ny][nx] = true;
    // Carve the wall between (cx,cy) and (nx,ny), then the new cell.
    grid[cy + ny + 1][cx + nx + 1] = true;
    grid[2 * ny + 1][2 * nx + 1] = true;
    stack.push([nx, ny]);
  }

  const entrance = { ...openingCell(entranceSide, entranceAt, w, h), side: entranceSide };
  const exit = { ...openingCell(exitSide, exitAt, w, h), side: exitSide };
  grid[entrance.gy][entrance.gx] = true;
  grid[exit.gy][exit.gx] = true;
  return { cellsW, cellsH, w, h, grid, entrance, exit, seed };
}

// ---------------------------------------------------------------- analysis

/** Every floor cell reachable from `from` (4-directional BFS). */
export function mazeReachableFrom(
  maze: MazeGrid,
  from: { gx: number; gy: number },
): Set<string> {
  const key = (gx: number, gy: number) => `${gx},${gy}`;
  const seen = new Set<string>([key(from.gx, from.gy)]);
  const queue = [{ gx: from.gx, gy: from.gy }];
  while (queue.length > 0) {
    const { gx, gy } = queue.pop()!;
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
      const nx = gx + dx;
      const ny = gy + dy;
      if (nx < 0 || nx >= maze.w || ny < 0 || ny >= maze.h) continue;
      if (!maze.grid[ny][nx] || seen.has(key(nx, ny))) continue;
      seen.add(key(nx, ny));
      queue.push({ gx: nx, gy: ny });
    }
  }
  return seen;
}

/** All floor cells in the grid. */
export function mazeFloorCells(maze: MazeGrid): { gx: number; gy: number }[] {
  const out: { gx: number; gy: number }[] = [];
  for (let gy = 0; gy < maze.h; gy++) {
    for (let gx = 0; gx < maze.w; gx++) {
      if (maze.grid[gy][gx]) out.push({ gx, gy });
    }
  }
  return out;
}

/**
 * The cell graph: maze cells (odd/odd tiles) as nodes, carved passages
 * as edges. A perfect maze is a tree: edges == cells - 1.
 */
export function mazeCellGraph(maze: MazeGrid): { cells: number; edges: number } {
  let cells = 0;
  let edges = 0;
  for (let cy = 0; cy < maze.cellsH; cy++) {
    for (let cx = 0; cx < maze.cellsW; cx++) {
      cells += 1;
      // Count each passage once: east and south neighbours only.
      if (cx + 1 < maze.cellsW && maze.grid[2 * cy + 1][2 * cx + 2]) edges += 1;
      if (cy + 1 < maze.cellsH && maze.grid[2 * cy + 2][2 * cx + 1]) edges += 1;
    }
  }
  return { cells, edges };
}

/** Floor cells with exactly one open neighbour — the dead ends. */
export function mazeDeadEnds(maze: MazeGrid): { gx: number; gy: number }[] {
  const out: { gx: number; gy: number }[] = [];
  for (const { gx, gy } of mazeFloorCells(maze)) {
    let open = 0;
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
      const nx = gx + dx;
      const ny = gy + dy;
      if (nx >= 0 && nx < maze.w && ny >= 0 && ny < maze.h && maze.grid[ny][nx]) open += 1;
    }
    if (open === 1) out.push({ gx, gy });
  }
  return out;
}

/**
 * ASCII rendering for eyeballing: `#` wall, `.` floor, `S` entrance,
 * `E` exit.
 */
export function mazeToAscii(maze: MazeGrid): string {
  const rows: string[] = [];
  for (let gy = 0; gy < maze.h; gy++) {
    let row = "";
    for (let gx = 0; gx < maze.w; gx++) {
      if (gx === maze.entrance.gx && gy === maze.entrance.gy) row += "S";
      else if (gx === maze.exit.gx && gy === maze.exit.gy) row += "E";
      else row += maze.grid[gy][gx] ? "." : "#";
    }
    rows.push(row);
  }
  return rows.join("\n");
}
