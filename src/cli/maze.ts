export {};
/**
 * maze CLI — mutable maps, FR-12 (docs/realtime-adventure-construction.md).
 *
 * Generates a seeded perfect maze and prints it — no connection needed,
 * this is pure layout math. The composer turns the same maze into tiles
 * (carveMazeRegion); this CLI is for eyeballing a maze before it lands.
 *
 * Usage (prints one JSON object to stdout, with an `ascii` field):
 *   bun run src/cli/maze.ts --cells 10x8 [--seed 7] [--entrance north] [--exit south]
 *   bun run src/cli/maze.ts --cells 10x8 --ascii
 *       Print just the ASCII rendering (no JSON).
 *   bun run src/cli/maze.ts --corridor 100m
 *       Show the unit converter: 100 m -> 66 squares (PF2e: 1 square = 5 ft = 1.524 m).
 */
import {
  generateMaze,
  mazeCellGraph,
  mazeDeadEnds,
  mazeFloorCells,
  mazeReachableFrom,
  mazeToAscii,
  toSquares,
  type LengthUnit,
  type MazeSide,
} from "../worldbuilding/maze.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function usage(): never {
  process.stderr.write(
    "usage: bun run src/cli/maze.ts --cells <w>x<h> [--seed 7] [--entrance north|south|east|west] [--exit north|south|east|west] [--ascii] | --corridor <length>[m|ft]\n",
  );
  process.exit(2);
}

function parseSide(value: string | undefined, name: string): MazeSide | undefined {
  if (value === undefined) return undefined;
  if (value !== "north" && value !== "south" && value !== "east" && value !== "west") {
    throw new Error(`--${name} must be north, south, east or west, got "${value}".`);
  }
  return value;
}

function main(): void {
  const corridor = arg("--corridor");
  if (corridor !== undefined) {
    const m = corridor.match(/^(\d+(?:\.\d+)?)\s*(m|meters|ft|feet|squares)?$/);
    if (!m) usage();
    const unit = (m[2] ?? "squares") as LengthUnit;
    const squares = toSquares(parseFloat(m[1]), unit);
    process.stdout.write(JSON.stringify({ length: corridor, unit, squares }) + "\n");
    return;
  }

  const cells = arg("--cells");
  if (!cells) usage();
  const cm = cells.match(/^(\d+)x(\d+)$/);
  if (!cm) usage();
  const cellsW = parseInt(cm[1], 10);
  const cellsH = parseInt(cm[2], 10);
  const seed = parseInt(arg("--seed") ?? "1", 10);
  const maze = generateMaze(cellsW, cellsH, seed, {
    entranceSide: parseSide(arg("--entrance"), "entrance"),
    exitSide: parseSide(arg("--exit"), "exit"),
  });
  const ascii = mazeToAscii(maze);
  if (has("--ascii")) {
    process.stdout.write(ascii + "\n");
    return;
  }
  const { cells: cellCount, edges } = mazeCellGraph(maze);
  const reachable = mazeReachableFrom(maze, maze.entrance).size;
  process.stdout.write(JSON.stringify({
    seed,
    cellsW,
    cellsH,
    w: maze.w,
    h: maze.h,
    entrance: maze.entrance,
    exit: maze.exit,
    floorCells: mazeFloorCells(maze).length,
    reachableFromEntrance: reachable,
    fullyConnected: reachable === mazeFloorCells(maze).length,
    cellGraph: { cells: cellCount, edges, perfect: edges === cellCount - 1 },
    deadEnds: mazeDeadEnds(maze).length,
    ascii,
  }) + "\n");
}

try {
  main();
} catch (err) {
  process.stderr.write(`maze: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
