/**
 * Unit tests for the four tile-composer gaps left by the Nov 20
 * tile-pack redesign (three-kind pack: base | macro | prop).
 *
 * 1. Off-grid prop placement — fractional cells.
 * 2. Non-square macro pieces — width/height split.
 * 3. Diagonal-wall placement — the wall-diagonal art, placed.
 * 4. Inner corners / L-shaped rooms — a corner cut out.
 *
 * Pure composition math only — no Foundry, no network.
 * Run: bun test tests/tile-composer-gaps.test.ts
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
  LAYER_SORT,
  TILE_PX,
  isCutoutCell,
  isMazeWallCell,
  layoutDungeon,
  layoutRoom,
  listProps,
  loadPack,
  mazeGridsFor,
  placeProp,
  widenRoom,
  type Pack,
  type RoomSpec,
} from "../src/worldbuilding/tiles-layout.js";

const pack: Pack = loadPack(path.resolve(import.meta.dir, "../tiles/manifest.json"));
const BASE = "worlds/testbed";

const srcOf = (t: { texture: { src: string } }) => t.texture.src.split("/").pop()!;

/** First maze wall cell in a 9x9 room with a 3x3 maze region at (3,3). */
function aMazeWallCell(): { gx: number; gy: number } {
  const spec: RoomSpec = { name: "Maze", gridW: 9, gridH: 9, seed: 1, mazes: [{ gx: 3, gy: 3, w: 3, h: 3 }] };
  const grids = mazeGridsFor(spec);
  for (let gy = 0; gy < 9; gy++) {
    for (let gx = 0; gx < 9; gx++) {
      if (isMazeWallCell(grids, gx, gy)) return { gx, gy };
    }
  }
  throw new Error("test setup: no maze wall cell found");
}

describe("gap 1 — off-grid prop placement", () => {
  it("a prop at fractional cells places at x = gx*100", () => {
    const layout = layoutRoom(
      { name: "Off-grid", gridW: 8, gridH: 6, seed: 42, dressing: [{ tile: "bones", gx: 2.5, gy: 3.5 }] },
      pack,
      BASE,
    );
    const bones = layout.tiles.find((t) => srcOf(t) === "bones.png")!;
    expect([bones.x, bones.y, bones.width, bones.height]).toEqual([250, 350, 200, 200]);
    expect(bones.sort).toBe(LAYER_SORT.dressing);
  });

  it("a prop at fractional cells that runs past the room edge throws", () => {
    const bad: RoomSpec = {
      name: "Off-grid",
      gridW: 8,
      gridH: 6,
      seed: 42,
      dressing: [{ tile: "bones", gx: 7.5, gy: 5 }],
    };
    expect(() => layoutRoom(bad, pack, BASE)).toThrow(/does not fit/);
  });

  it("a fractional prop overlapping a maze wall cell throws", () => {
    const wall = aMazeWallCell();
    // Half a cell up-left of the wall cell: the 2x2 sprite still covers it.
    const bad: RoomSpec = {
      name: "Maze",
      gridW: 9,
      gridH: 9,
      seed: 1,
      mazes: [{ gx: 3, gy: 3, w: 3, h: 3 }],
      dressing: [{ tile: "bones", gx: wall.gx - 0.5, gy: wall.gy - 0.5 }],
    };
    expect(() => layoutRoom(bad, pack, BASE)).toThrow(/maze wall cell/);
  });

  it("placeProp accepts fractional cells, and the prop keeps its address", () => {
    const spec: RoomSpec = { name: "Off-grid", gridW: 8, gridH: 6, seed: 42 };
    const next = placeProp(spec, { tile: "chest", gx: 1.5, gy: 1.5 }, pack);
    expect(listProps(next)).toEqual([
      { id: "prop-1", tile: "chest", gx: 1.5, gy: 1.5 },
    ]);
    const layout = layoutRoom(next, pack, BASE);
    const chest = layout.tiles.find((t) => srcOf(t) === "chest.png")!;
    expect([chest.x, chest.y]).toEqual([150, 150]);
  });

  it("fog is a free sprite too — fractional fog places off-grid", () => {
    const layout = layoutRoom(
      { name: "Off-grid", gridW: 8, gridH: 6, seed: 42, fog: [{ tile: "fog-wisp-small", gx: 0.5, gy: 0.5 }] },
      pack,
      BASE,
    );
    const fog = layout.tiles.find((t) => srcOf(t) === "fog-wisp-small.png")!;
    expect([fog.x, fog.y]).toEqual([50, 50]);
    expect(fog.elevation).toBe(1);
  });
});

describe("gap 2 — non-square macro pieces", () => {
  const macroSpec: RoomSpec = {
    name: "Macro Room",
    gridW: 8,
    gridH: 6,
    seed: 42,
    dressing: [{ tile: "wall-curved", gx: 4, gy: 3 }],
  };

  it("wall-curved places at its real shape by default: 300x300", () => {
    const layout = layoutRoom(macroSpec, pack, BASE);
    const curved = layout.tiles.find((t) => srcOf(t) === "wall-curved.png")!;
    expect([curved.x, curved.y, curved.width, curved.height]).toEqual([400, 300, 300, 300]);
  });

  it("wall-curved with an explicit 3x1 footprint places as a 300x100 wall run", () => {
    const run: RoomSpec = {
      ...macroSpec,
      dressing: [{ tile: "wall-curved", gx: 4, gy: 3, w: 3, h: 1 }],
    };
    const layout = layoutRoom(run, pack, BASE);
    const curved = layout.tiles.find((t) => srcOf(t) === "wall-curved.png")!;
    expect([curved.x, curved.y, curved.width, curved.height]).toEqual([400, 300, 300, 100]);
  });

  it("a 3x1 wall run that does not fit throws", () => {
    const bad: RoomSpec = {
      ...macroSpec,
      dressing: [{ tile: "wall-curved", gx: 6, gy: 4, w: 3, h: 1 }],
    };
    expect(() => layoutRoom(bad, pack, BASE)).toThrow(/does not fit/);
  });

  it("a non-whole footprint throws, naming the problem", () => {
    for (const bad of [
      { ...macroSpec, dressing: [{ tile: "wall-curved", gx: 4, gy: 3, w: 0, h: 1 }] },
      { ...macroSpec, dressing: [{ tile: "wall-curved", gx: 4, gy: 3, w: 1.5, h: 1 }] },
    ]) {
      expect(() => layoutRoom(bad, pack, BASE)).toThrow(/footprint/);
    }
  });

  it("a pack entry with real width/height places at that shape", () => {
    // Forward-compat: the manifest is square-only today, so the entry
    // override is what a future non-square piece would carry.
    const wide = new Map(pack);
    wide.set("wall-curved", { ...pack.get("wall-curved")!, widthPx: 300, heightPx: 100 });
    const layout = layoutRoom(macroSpec, wide, BASE);
    const curved = layout.tiles.find((t) => srcOf(t) === "wall-curved.png")!;
    expect([curved.x, curved.y, curved.width, curved.height]).toEqual([400, 300, 300, 100]);
  });

  it("placeProp carries an explicit footprint through", () => {
    const spec: RoomSpec = { name: "Macro Room", gridW: 8, gridH: 6, seed: 42 };
    const next = placeProp(spec, { tile: "wall-curved", gx: 1, gy: 1, w: 3, h: 1 }, pack);
    expect(listProps(next)[0]).toMatchObject({ tile: "wall-curved", gx: 1, gy: 1, w: 3, h: 1 });
    const layout = layoutRoom(next, pack, BASE);
    const curved = layout.tiles.find((t) => srcOf(t) === "wall-curved.png")!;
    expect([curved.width, curved.height]).toEqual([300, 100]);
  });
});

describe("gap 3 — diagonal-wall placement", () => {
  const diagSpec = (rotation?: number): RoomSpec => ({
    name: "Diagonal",
    gridW: 8,
    gridH: 6,
    seed: 42,
    diagonals: [{ gx: 2, gy: 2, ...(rotation !== undefined ? { rotation } : {}) }],
  });

  it("rotation 0 places the NW→SE band with a matching collision wall", () => {
    const layout = layoutRoom(diagSpec(), pack, BASE);
    const diag = layout.tiles.find((t) => srcOf(t) === "wall-diagonal.png")!;
    expect([diag.x, diag.y, diag.width, diag.height, diag.rotation]).toEqual([200, 200, 100, 100, 0]);
    expect(diag.sort).toBe(LAYER_SORT.wall);
    expect(layout.walls).toContainEqual({ x1: 200, y1: 200, x2: 300, y2: 300, door: 0 });
    // The diagonal cell keeps its floor tile.
    const floor = layout.tiles.filter((t) => t.elevation === 0 && t.sort === LAYER_SORT.floor);
    expect(floor).toHaveLength(8 * 6);
  });

  it("rotation 90 is the NE→SW diagonal, 180 matches 0, 270 matches 90", () => {
    const r90 = layoutRoom(diagSpec(90), pack, BASE);
    expect(r90.tiles.find((t) => srcOf(t) === "wall-diagonal.png")!.rotation).toBe(90);
    expect(r90.walls).toContainEqual({ x1: 300, y1: 200, x2: 200, y2: 300, door: 0 });
    const r180 = layoutRoom(diagSpec(180), pack, BASE);
    expect(r180.walls).toContainEqual({ x1: 200, y1: 200, x2: 300, y2: 300, door: 0 });
    const r270 = layoutRoom(diagSpec(270), pack, BASE);
    expect(r270.walls).toContainEqual({ x1: 300, y1: 200, x2: 200, y2: 300, door: 0 });
  });

  it("a diagonal on the wall ring throws", () => {
    const bad = diagSpec();
    bad.diagonals = [{ gx: 0, gy: 2 }];
    expect(() => layoutRoom(bad, pack, BASE)).toThrow(/wall ring/);
  });

  it("a non-right-angle rotation throws, listing the allowed angles", () => {
    const bad = diagSpec(45);
    expect(() => layoutRoom(bad, pack, BASE)).toThrow(/0, 90, 180 or 270/);
  });

  it("two diagonals in one cell throw", () => {
    const bad = diagSpec();
    bad.diagonals = [
      { gx: 2, gy: 2 },
      { gx: 2, gy: 2, rotation: 90 },
    ];
    expect(() => layoutRoom(bad, pack, BASE)).toThrow(/one diagonal per cell/);
  });

  it("a diagonal on a maze wall cell throws", () => {
    const wall = aMazeWallCell();
    const bad: RoomSpec = {
      name: "Maze",
      gridW: 9,
      gridH: 9,
      seed: 1,
      mazes: [{ gx: 3, gy: 3, w: 3, h: 3 }],
      diagonals: [{ gx: wall.gx, gy: wall.gy }],
    };
    expect(() => layoutRoom(bad, pack, BASE)).toThrow(/maze wall cell/);
  });

  it("a western room has no diagonal wall tile — it fails loudly, not stone", () => {
    expect(() => layoutRoom(diagSpec(), pack, BASE, "western")).toThrow(
      /has no diagonal wall tile \("wall-wood-diagonal"\)/,
    );
  });
});

describe("gap 4 — L-shaped rooms", () => {
  const lSpec = (corner: "nw" | "ne" | "se" | "sw" = "ne"): RoomSpec => ({
    name: "L Room",
    gridW: 8,
    gridH: 6,
    seed: 42,
    cutout: { corner, w: 2, h: 2 },
  });

  it("the cutout has no floor and the room composes with no gaps", () => {
    const layout = layoutRoom(lSpec(), pack, BASE);
    const floor = layout.tiles.filter((t) => t.elevation === 0 && t.sort === LAYER_SORT.floor);
    expect(floor).toHaveLength(8 * 6 - 2 * 2);
    const cells = new Set(floor.map((t) => `${t.x / TILE_PX},${t.y / TILE_PX}`));
    expect(cells.size).toBe(44);
    for (let gy = 0; gy < 6; gy++) {
      for (let gx = 0; gx < 8; gx++) {
        expect(cells.has(`${gx},${gy}`)).toBe(!isCutoutCell(lSpec(), gx, gy));
      }
    }
    expect(layout.width).toBe(800);
    expect(layout.height).toBe(600);
  });

  it("the wall ring follows the L: 23 wall tiles, 5 of them corners", () => {
    const layout = layoutRoom(lSpec(), pack, BASE);
    const wallTiles = layout.tiles.filter((t) => t.sort === LAYER_SORT.wall);
    expect(wallTiles).toHaveLength(23);
    const corners = wallTiles.filter((t) => srcOf(t) === "wall-corner.png");
    expect(corners).toHaveLength(5);
    // The two inner corners of the L: the top of the cutout's west edge
    // and the cutout's south edge where it meets the east wall.
    const cornerCells = new Set(corners.map((t) => `${t.x / TILE_PX},${t.y / TILE_PX}`));
    expect(cornerCells).toEqual(new Set(["0,0", "5,0", "7,2", "7,5", "0,5"]));
  });

  it("the collision walls trace the L outline in 6 merged runs", () => {
    const layout = layoutRoom(lSpec(), pack, BASE);
    expect(layout.walls).toHaveLength(6);
    expect(layout.walls).toEqual(
      expect.arrayContaining([
        { x1: 0, y1: 0, x2: 600, y2: 0, door: 0 },
        { x1: 600, y1: 0, x2: 600, y2: 200, door: 0 },
        { x1: 600, y1: 200, x2: 800, y2: 200, door: 0 },
        { x1: 800, y1: 200, x2: 800, y2: 600, door: 0 },
        { x1: 0, y1: 600, x2: 800, y2: 600, door: 0 },
        { x1: 0, y1: 0, x2: 0, y2: 600, door: 0 },
      ]),
    );
  });

  it("a door on a straight stretch works — tile, door segment, split runs", () => {
    const spec: RoomSpec = { ...lSpec(), doors: [{ wall: "north", at: 3 }] };
    const layout = layoutRoom(spec, pack, BASE);
    const doorTile = layout.tiles.find((t) => srcOf(t) === "wall-door.png")!;
    expect([doorTile.x, doorTile.y]).toEqual([300, 0]);
    expect(layout.walls).toContainEqual({ x1: 300, y1: 0, x2: 400, y2: 0, door: 1 });
    expect(layout.walls).toContainEqual({ x1: 0, y1: 0, x2: 300, y2: 0, door: 0 });
    expect(layout.walls).toContainEqual({ x1: 400, y1: 0, x2: 600, y2: 0, door: 0 });
  });

  it("a door in the cutout throws", () => {
    // North at 6 is in range (1..6) but cell (6,0) is in the NE cutout.
    const bad: RoomSpec = { ...lSpec(), doors: [{ wall: "north", at: 6 }] };
    expect(() => layoutRoom(bad, pack, BASE)).toThrow(/cutout/);
  });

  it("a door on an inner-corner cell throws", () => {
    // North at 5 is the cell whose north edge is the room edge and
    // whose east edge faces the cutout — one tile cannot show both.
    const bad: RoomSpec = { ...lSpec(), doors: [{ wall: "north", at: 5 }] };
    expect(() => layoutRoom(bad, pack, BASE)).toThrow(/inner-corner/);
  });

  it("a cutout that leaves a leg under 2 cells throws", () => {
    const bad: RoomSpec = { name: "L Room", gridW: 8, gridH: 6, seed: 42, cutout: { corner: "ne", w: 7, h: 2 } };
    expect(() => layoutRoom(bad, pack, BASE)).toThrow(/at least 2 cells on each leg/);
  });

  it("a maze region overlapping the cutout throws", () => {
    const bad: RoomSpec = {
      name: "L Room",
      gridW: 9,
      gridH: 9,
      seed: 1,
      cutout: { corner: "ne", w: 2, h: 2 },
      mazes: [{ gx: 5, gy: 1, w: 3, h: 3 }],
    };
    expect(() => layoutRoom(bad, pack, BASE)).toThrow(/overlaps.*cutout/);
  });

  it("a prop or a torch in the cutout throws", () => {
    const badProp: RoomSpec = { ...lSpec(), dressing: [{ tile: "bones", gx: 6, gy: 0 }] };
    expect(() => layoutRoom(badProp, pack, BASE)).toThrow(/cutout/);
    const badTorch: RoomSpec = { ...lSpec(), torches: [{ gx: 7, gy: 1 }] };
    expect(() => layoutRoom(badTorch, pack, BASE)).toThrow(/cutout/);
  });

  it("all four corners compose with the same floor and wall counts", () => {
    for (const corner of ["nw", "ne", "se", "sw"] as const) {
      const layout = layoutRoom(lSpec(corner), pack, BASE);
      const floor = layout.tiles.filter((t) => t.elevation === 0 && t.sort === LAYER_SORT.floor);
      const wallTiles = layout.tiles.filter((t) => t.sort === LAYER_SORT.wall);
      expect(floor).toHaveLength(44);
      expect(wallTiles).toHaveLength(23);
      expect(layout.walls).toHaveLength(6);
    }
  });

  it("an L-shaped room links into a dungeon like any room", () => {
    const dungeon = layoutDungeon(
      {
        rooms: [
          { id: "l", ...lSpec(), doors: [{ wall: "south", at: 3 }] },
          { id: "hall", name: "Hall", gridW: 6, gridH: 6, seed: 7, doors: [{ wall: "north", at: 2 }] },
        ],
        links: [{ from: { room: "l", wall: "south", at: 3 }, to: { room: "hall", wall: "north", at: 2 } }],
      },
      pack,
      BASE,
    );
    expect(dungeon.rooms).toHaveLength(2);
    expect(dungeon.links).toHaveLength(1);
    expect(dungeon.links[0].from.enterGx).toBe(3);
    expect(dungeon.links[0].from.enterGy).toBe(4);
  });

  it("widenRoom shifts diagonals and keeps the cutout anchored", () => {
    const spec: RoomSpec = { ...lSpec(), diagonals: [{ gx: 2, gy: 2 }] };
    const wide = widenRoom(spec, "west", 1);
    expect(wide.gridW).toBe(9);
    expect(wide.diagonals).toEqual([{ gx: 3, gy: 2 }]);
    expect(wide.cutout).toEqual({ corner: "ne", w: 2, h: 2 });
    const layout = layoutRoom(wide, pack, BASE);
    const floor = layout.tiles.filter((t) => t.elevation === 0 && t.sort === LAYER_SORT.floor);
    expect(floor).toHaveLength(9 * 6 - 4);
    expect(layout.tiles.find((t) => srcOf(t) === "wall-diagonal.png")!.x).toBe(300);
  });
});
