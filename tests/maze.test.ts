/**
 * Unit tests for the mutable-map layout operations + maze generator
 * (src/worldbuilding/maze.ts, src/worldbuilding/tiles-layout.ts).
 * Pure math only — no Foundry, no network.
 * Run: bun test tests/maze.test.ts
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
  generateMaze,
  mazeCellGraph,
  mazeDeadEnds,
  mazeFloorCells,
  mazeReachableFrom,
  mazeToAscii,
  toSquares,
} from "../src/worldbuilding/maze.js";
import {
  LAYER_SORT,
  TILE_PX,
  addCorridor,
  applyOverlay,
  carveMazeRegion,
  layoutDungeon,
  layoutRoom,
  linkRooms,
  loadPack,
  widenRoom,
  type DungeonSpec,
  type Pack,
  type RoomSpec,
} from "../src/worldbuilding/tiles-layout.js";

const pack: Pack = loadPack(path.resolve(import.meta.dir, "../tiles/manifest.json"));
const BASE = "worlds/testbed";

describe("toSquares — the creator's units", () => {
  it("100 m is 66 squares (PF2e: 1 square = 5 ft = 1.524 m)", () => {
    expect(toSquares(100, "m")).toBe(66);
    expect(toSquares(100, "meters")).toBe(66);
  });
  it("5 ft is 1 square; 15 ft is 3", () => {
    expect(toSquares(5, "ft")).toBe(1);
    expect(toSquares(15, "feet")).toBe(3);
  });
  it("squares pass through; tiny lengths round up to 1", () => {
    expect(toSquares(10, "squares")).toBe(10);
    expect(toSquares(1, "m")).toBe(1);
  });
  it("rejects zero and negative lengths", () => {
    expect(() => toSquares(0, "m")).toThrow();
    expect(() => toSquares(-5, "ft")).toThrow();
  });
});

describe("generateMaze — a real maze", () => {
  it("has the right tile dimensions: (2w+1) x (2h+1)", () => {
    const m = generateMaze(10, 8, 7);
    expect(m.w).toBe(21);
    expect(m.h).toBe(17);
    expect(m.grid).toHaveLength(17);
    expect(m.grid[0]).toHaveLength(21);
  });
  it("is fully connected: every floor cell reachable from the entrance", () => {
    for (const seed of [1, 7, 42]) {
      const m = generateMaze(10, 8, seed);
      const floor = mazeFloorCells(m);
      const reached = mazeReachableFrom(m, m.entrance);
      expect(reached.size).toBe(floor.length);
      expect(reached.has(`${m.exit.gx},${m.exit.gy}`)).toBe(true);
    }
  });
  it("is perfect: the cell graph is a tree (edges == cells - 1), so exactly one solution path", () => {
    const m = generateMaze(10, 8, 7);
    const { cells, edges } = mazeCellGraph(m);
    expect(cells).toBe(80);
    expect(edges).toBe(cells - 1);
  });
  it("has dead ends (not counting the entrance/exit openings)", () => {
    const m = generateMaze(10, 8, 7);
    const ends = mazeDeadEnds(m).filter(
      (c) => !(c.gx === m.entrance.gx && c.gy === m.entrance.gy) &&
        !(c.gx === m.exit.gx && c.gy === m.exit.gy),
    );
    expect(ends.length).toBeGreaterThan(0);
  });
  it("is deterministic for the same seed and different for another seed", () => {
    const a = generateMaze(10, 8, 7);
    const b = generateMaze(10, 8, 7);
    const c = generateMaze(10, 8, 8);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });
  it("puts the entrance and exit openings on the requested sides", () => {
    const m = generateMaze(6, 4, 3, { entranceSide: "west", exitSide: "east" });
    expect(m.entrance.side).toBe("west");
    expect(m.entrance.gx).toBe(0);
    expect(m.exit.side).toBe("east");
    expect(m.exit.gx).toBe(m.w - 1);
    expect(m.grid[m.entrance.gy][m.entrance.gx]).toBe(true);
    expect(m.grid[m.exit.gy][m.exit.gx]).toBe(true);
  });
  it("defaults the exit to the opposite side of the entrance", () => {
    const m = generateMaze(6, 4, 3, { entranceSide: "south" });
    expect(m.exit.side).toBe("north");
  });
  it("rejects bad sizes and out-of-range openings", () => {
    expect(() => generateMaze(0, 5, 1)).toThrow();
    expect(() => generateMaze(5, 5, 1, { entranceAt: 9 })).toThrow();
  });
  it("renders ASCII with S and E and the right dimensions", () => {
    const m = generateMaze(4, 3, 5);
    const ascii = mazeToAscii(m);
    const rows = ascii.split("\n");
    expect(rows).toHaveLength(7);
    expect(rows[0]).toHaveLength(9);
    expect(ascii).toContain("S");
    expect(ascii).toContain("E");
  });
  it("a 1x1 maze is just a cell with an entrance and an exit", () => {
    const m = generateMaze(1, 1, 1);
    expect(m.w).toBe(3);
    expect(m.h).toBe(3);
    expect(mazeFloorCells(m).length).toBe(3); // cell + two openings
  });
});

const hallSpec: RoomSpec = {
  name: "Entry Hall",
  gridW: 8,
  gridH: 6,
  seed: 42,
  doors: [{ wall: "north", at: 3 }],
};

/** Doorless 8x8 room for the maze-region tests: a 5x5 region at (1,1)
 *  fits with the one-cell margin on every side. */
const mazeRoomSpec: RoomSpec = {
  name: "Maze Room",
  gridW: 8,
  gridH: 8,
  seed: 42,
};

describe("addCorridor", () => {
  const dungeon: DungeonSpec = { rooms: [{ id: "hall", ...hallSpec }], links: [] };

  it("adds a 1-wide corridor room north for 100 m (66 squares) + a link", () => {
    const out = addCorridor(dungeon, {
      room: "hall", wall: "north", at: 3, direction: "north", length: 100, unit: "m",
    });
    expect(out.rooms).toHaveLength(2);
    const corridor = out.rooms[1];
    expect(corridor.gridW).toBe(1);
    expect(corridor.gridH).toBe(66);
    expect(corridor.openings).toEqual([
      { wall: "south", at: 0 },
      { wall: "north", at: 0 },
    ]);
    expect(out.links).toHaveLength(1);
    expect(out.links[0]).toEqual({
      from: { room: "hall", wall: "north", at: 3 },
      to: { room: corridor.id, wall: "south", at: 0 },
    });
    // The corridor lays out: no wall tiles or collision walls on its open ends.
    const layout = layoutRoom(corridor, pack, BASE);
    expect(layout.width).toBe(100);
    expect(layout.height).toBe(6600);
    const southEdge = layout.walls.filter((w) => w.y1 === layout.height && w.y2 === layout.height);
    const northEdge = layout.walls.filter((w) => w.y1 === 0 && w.y2 === 0);
    expect(southEdge).toHaveLength(0);
    expect(northEdge).toHaveLength(0);
  });
  it("adds the door to the source room when the wall cell has none", () => {
    const noDoor: DungeonSpec = {
      rooms: [{ id: "hall", name: "Hall", gridW: 8, gridH: 6 }],
      links: [],
    };
    const out = addCorridor(noDoor, {
      room: "hall", wall: "east", at: 2, direction: "east", length: 5,
    });
    expect(out.rooms[0].doors).toEqual([{ wall: "east", at: 2 }]);
    const corridor = out.rooms[1];
    expect(corridor.gridW).toBe(5);
    expect(corridor.gridH).toBe(1);
  });
  it("a 3-wide corridor gets doors at the middle cell, not openings", () => {
    const out = addCorridor(dungeon, {
      room: "hall", wall: "north", at: 3, direction: "north", length: 4, width: 3,
    });
    const corridor = out.rooms[1];
    expect(corridor.doors).toEqual([
      { wall: "south", at: 1 },
      { wall: "north", at: 1 },
    ]);
    expect(corridor.openings).toBeUndefined();
  });
  it("does not mutate the input dungeon", () => {
    const before = JSON.stringify(dungeon);
    addCorridor(dungeon, { room: "hall", wall: "north", at: 3, direction: "north", length: 4 });
    expect(JSON.stringify(dungeon)).toBe(before);
  });
  it("rejects a corner start cell, an unknown room, and a zero length", () => {
    expect(() => addCorridor(dungeon, { room: "hall", wall: "north", at: 0, direction: "north", length: 4 })).toThrow();
    expect(() => addCorridor(dungeon, { room: "hall", wall: "north", at: 7, direction: "north", length: 4 })).toThrow();
    expect(() => addCorridor(dungeon, { room: "nope", wall: "north", at: 3, direction: "north", length: 4 })).toThrow();
    expect(() => addCorridor(dungeon, { room: "hall", wall: "north", at: 3, direction: "north", length: 0 })).toThrow();
  });
  it("links the corridor to a maze room and the whole dungeon validates", () => {
    const withCorridor = addCorridor(dungeon, {
      room: "hall", wall: "north", at: 3, direction: "north", length: 4,
    });
    const corridor = withCorridor.rooms[1];
    const mazeRoom = carveMazeRegion(
      { name: "Maze", gridW: 11, gridH: 11, seed: 9, doors: [{ wall: "south", at: 5 }] },
      { gx: 2, gy: 2, w: 7, h: 7, seed: 11 },
    );
    const full = linkRooms(
      { rooms: [...withCorridor.rooms, { id: "maze", ...mazeRoom }], links: withCorridor.links },
      { from: { room: corridor.id, wall: "north", at: 0 }, to: { room: "maze", wall: "south", at: 5 } },
    );
    const laid = layoutDungeon(full, pack, BASE);
    expect(laid.rooms).toHaveLength(3);
    expect(laid.links).toHaveLength(2);
  });
});

describe("carveMazeRegion", () => {
  it("adds the region and the room lays out with maze walls and floor", () => {
    const spec = carveMazeRegion(mazeRoomSpec, { gx: 1, gy: 1, w: 5, h: 5, seed: 7 });
    expect(spec.mazes).toHaveLength(1);
    const layout = layoutRoom(spec, pack, BASE);
    // 5x5 region = 13 maze cells; the maze wall cells get wall tiles (or
    // floor-dark when enclosed) instead of floor tiles.
    const floor = layout.tiles.filter((t) => t.elevation === 0 && t.sort === LAYER_SORT.floor);
    expect(floor.length).toBeLessThan(8 * 8);
    expect(layout.walls.length).toBeGreaterThan(4); // perimeter + maze walls
  });
  it("the party can walk from the door into the maze and out the exit", () => {
    const spec = carveMazeRegion(
      { name: "Maze Room", gridW: 11, gridH: 11, seed: 1, doors: [{ wall: "south", at: 5 }] },
      { gx: 2, gy: 2, w: 7, h: 7, seed: 11, entrance: "south" },
    );
    const layout = layoutRoom(spec, pack, BASE);
    // Walkable cells: every cell with a floor tile. BFS from the door's
    // entry cell must reach the maze exit opening.
    const walkable = new Set<string>();
    for (const t of layout.tiles) {
      if (t.elevation === 0 && t.sort === LAYER_SORT.floor) {
        walkable.add(`${t.x / TILE_PX},${t.y / TILE_PX}`);
      }
    }
    // Maze floor cells are floor tiles too (the maze walls are wall tiles).
    const reached = new Set<string>(["5,9"]);
    const queue = ["5,9"];
    while (queue.length > 0) {
      const [x, y] = queue.pop()!.split(",").map(Number);
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
        const k = `${x + dx},${y + dy}`;
        if (walkable.has(k) && !reached.has(k)) {
          reached.add(k);
          queue.push(k);
        }
      }
    }
    // The maze exit opening is on the north border of the region (2,2..8,8):
    // entrance south (row 8), exit north (row 2). At least one exit cell
    // on row 2 inside the region must be reachable.
    const exitReached = [2, 3, 4, 5, 6, 7, 8].some((gx) => reached.has(`${gx},2`));
    expect(exitReached).toBe(true);
  });
  it("rejects even dimensions, an out-of-bounds region, and overlapping regions", () => {
    expect(() => carveMazeRegion(mazeRoomSpec, { gx: 1, gy: 1, w: 4, h: 5, seed: 1 })).toThrow();
    expect(() => carveMazeRegion(mazeRoomSpec, { gx: 0, gy: 1, w: 5, h: 5, seed: 1 })).toThrow();
    const one = carveMazeRegion(mazeRoomSpec, { gx: 1, gy: 1, w: 5, h: 5, seed: 1 });
    expect(() => carveMazeRegion(one, { gx: 2, gy: 2, w: 5, h: 5, seed: 2 })).toThrow();
  });
  it("rejects a region whose maze would block a door entry", () => {
    // 8x8 room, north door at 3 -> entry cell (3,1). The 5x5 region at
    // (1,1) covers it as maze grid (2,0) — the top border, wall everywhere
    // except the entrance opening at grid (3,0) — so the door opens into
    // a maze wall, deterministically, for any seed.
    const spec = carveMazeRegion(
      { name: "Maze Room", gridW: 8, gridH: 8, seed: 1, doors: [{ wall: "north", at: 3 }] },
      { gx: 1, gy: 1, w: 5, h: 5, seed: 7 },
    );
    expect(() => layoutRoom(spec, pack, BASE)).toThrow(/opens into a maze wall/);
  });
  it("is deterministic: same region, same layout", () => {
    const a = layoutRoom(carveMazeRegion(mazeRoomSpec, { gx: 1, gy: 1, w: 5, h: 5, seed: 7 }), pack, BASE);
    const b = layoutRoom(carveMazeRegion(mazeRoomSpec, { gx: 1, gy: 1, w: 5, h: 5, seed: 7 }), pack, BASE);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("widenRoom", () => {
  it("adds columns on the east with nothing shifting", () => {
    const spec = widenRoom(hallSpec, "east", 10);
    expect(spec.gridW).toBe(18);
    expect(spec.gridH).toBe(6);
    expect(spec.doors).toEqual(hallSpec.doors);
    const layout = layoutRoom(spec, pack, BASE);
    const floor = layout.tiles.filter((t) => t.elevation === 0 && t.sort === LAYER_SORT.floor);
    expect(floor).toHaveLength(18 * 6);
  });
  it("shifts doors, dressing and torches when widening west", () => {
    const rich: RoomSpec = {
      ...hallSpec,
      dressing: [{ tile: "bones", gx: 2, gy: 2 }],
      torches: [{ gx: 1, gy: 1 }],
      lights: [{ x: 150, y: 150, dim: 100, bright: 50, color: "#ffffff" }],
    };
    const spec = widenRoom(rich, "west", 3);
    expect(spec.gridW).toBe(11);
    expect(spec.doors).toEqual([{ wall: "north", at: 6 }]);
    expect(spec.dressing).toEqual([{ tile: "bones", gx: 5, gy: 2 }]);
    expect(spec.torches).toEqual([{ gx: 4, gy: 1 }]);
    expect(spec.lights?.[0].x).toBe(450);
    expect(() => layoutRoom(spec, pack, BASE)).not.toThrow();
  });
  it("shifts maze regions and overlays too", () => {
    const spec = widenRoom(
      carveMazeRegion(
        applyOverlay(mazeRoomSpec, { gx: 1, gy: 1, w: 2, h: 2, variants: { "floor-plain": "floor-dark" } }),
        { gx: 1, gy: 1, w: 5, h: 5, seed: 7 },
      ),
      "north",
      2,
    );
    expect(spec.mazes?.[0].gy).toBe(3);
    expect(spec.overlays?.[0].gy).toBe(3);
    expect(() => layoutRoom(spec, pack, BASE)).not.toThrow();
  });
  it("rejects widening by zero", () => {
    expect(() => widenRoom(hallSpec, "east", 0)).toThrow();
  });
});

describe("applyOverlay (FR-13)", () => {
  it("swaps floor tiles inside the region only, 1:1, leaving the rest untouched", () => {
    const base = layoutRoom(hallSpec, pack, BASE);
    const over = layoutRoom(
      applyOverlay(hallSpec, { gx: 2, gy: 2, w: 3, h: 2, variants: { "floor-plain": "floor-dark" } }),
      pack,
      BASE,
    );
    const tileAt = (layout: ReturnType<typeof layoutRoom>, gx: number, gy: number) =>
      layout.tiles.find((t) => t.x === gx * TILE_PX && t.y === gy * TILE_PX &&
        t.elevation === 0 && t.sort === LAYER_SORT.floor);
    for (let gy = 0; gy < 6; gy++) {
      for (let gx = 0; gx < 8; gx++) {
        const b = tileAt(base, gx, gy);
        const o = tileAt(over, gx, gy);
        const inside = gx >= 2 && gx < 5 && gy >= 2 && gy < 4;
        if (inside && b?.texture.src.endsWith("floor-plain.png")) {
          expect(o?.texture.src.endsWith("floor-dark.png")).toBe(true);
        } else {
          expect(o?.texture.src).toBe(b?.texture.src);
        }
      }
    }
  });
  it("a base tile not in the variants keeps its tile", () => {
    const spec = applyOverlay(hallSpec, { gx: 0, gy: 0, w: 8, h: 6, variants: { "floor-rubble": "floor-dark" } });
    const layout = layoutRoom(spec, pack, BASE);
    const plain = layout.tiles.filter((t) => t.texture.src.endsWith("floor-plain.png"));
    expect(plain.length).toBeGreaterThan(0);
  });
  it("a later overlay wins where regions overlap", () => {
    const spec = applyOverlay(
      applyOverlay(hallSpec, { gx: 1, gy: 1, w: 4, h: 4, variants: { "floor-plain": "floor-dark" } }),
      { gx: 2, gy: 2, w: 2, h: 2, variants: { "floor-plain": "floor-cracked", "floor-dark": "floor-cracked" } },
    );
    const layout = layoutRoom(spec, pack, BASE);
    const tileAt = (gx: number, gy: number) =>
      layout.tiles.find((t) => t.x === gx * TILE_PX && t.y === gy * TILE_PX &&
        t.elevation === 0 && t.sort === LAYER_SORT.floor);
    // (3,3) is in both overlays and rolled floor-plain in the base room:
    // first overlay -> dark, second -> cracked.
    const base = layoutRoom(hallSpec, pack, BASE);
    const baseTile = base.tiles.find((t) => t.x === 3 * TILE_PX && t.y === 3 * TILE_PX &&
      t.elevation === 0 && t.sort === LAYER_SORT.floor);
    if (baseTile?.texture.src.endsWith("floor-plain.png")) {
      expect(tileAt(3, 3)?.texture.src.endsWith("floor-cracked.png")).toBe(true);
    }
  });
  it("rejects regions outside the room and empty variants at edit time", () => {
    expect(() => applyOverlay(hallSpec, { gx: 7, gy: 5, w: 2, h: 2, variants: { "floor-plain": "floor-dark" } })).toThrow();
    expect(() => applyOverlay(hallSpec, { gx: 1, gy: 1, w: 2, h: 2, variants: {} })).toThrow();
  });
  it("rejects unknown variant tiles at layout time (applyOverlay is pack-agnostic)", () => {
    const spec = applyOverlay(hallSpec, { gx: 1, gy: 1, w: 2, h: 2, variants: { "floor-plain": "floor-wet" } });
    expect(() => layoutRoom(spec, pack, BASE)).toThrow(/not in the pack/);
  });
  it("does not mutate the input spec", () => {
    const before = JSON.stringify(hallSpec);
    applyOverlay(hallSpec, { gx: 1, gy: 1, w: 2, h: 2, variants: { "floor-plain": "floor-dark" } });
    expect(JSON.stringify(hallSpec)).toBe(before);
  });
});
