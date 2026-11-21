/**
 * Unit tests for the tile composer (src/worldbuilding/tiles.ts).
 * Pure composition math only — no Foundry, no network.
 * Run: bun test tests/tiles.test.ts
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
  FOG_ELEVATION,
  LAYER_SORT,
  TILE_PX,
  cornerRotation,
  doorEntryCell,
  layoutDungeon,
  layoutRoom,
  loadPack,
  mulberry32,
  resolveDoorWalk,
  wallRotation,
  type DungeonSpec,
  type Pack,
  type RoomSpec,
} from "../src/worldbuilding/tiles-layout.js";

const pack: Pack = loadPack(path.resolve(import.meta.dir, "../tiles/manifest.json"));
const BASE = "worlds/testbed";

const baseSpec: RoomSpec = {
  name: "Test Room",
  gridW: 8,
  gridH: 6,
  seed: 42,
  doors: [{ wall: "south", at: 3 }],
  dressing: [{ tile: "bones", gx: 2, gy: 2 }],
  fog: [{ tile: "fog-wisp-large", gx: 1, gy: 1 }],
  torches: [{ gx: 1, gy: 1 }],
};

describe("layoutRoom — floor", () => {
  it("covers every cell with exactly one floor tile", () => {
    const layout = layoutRoom(baseSpec, pack, BASE);
    // Floor = elevation 0 AND sort 0 (fog shares sort 0 but floats at elevation 1).
    const floor = layout.tiles.filter((t) => t.elevation === 0 && t.sort === LAYER_SORT.floor);
    expect(floor).toHaveLength(8 * 6);
    const cells = new Set(floor.map((t) => `${t.x / TILE_PX},${t.y / TILE_PX}`));
    expect(cells.size).toBe(8 * 6);
    for (let gy = 0; gy < 6; gy++) {
      for (let gx = 0; gx < 8; gx++) {
        expect(cells.has(`${gx},${gy}`)).toBe(true);
      }
    }
    for (const t of floor) {
      expect(t.width).toBe(TILE_PX);
      expect(t.height).toBe(TILE_PX);
      expect(t.elevation).toBe(0);
      expect(t.texture.src.startsWith(BASE + "/")).toBe(true);
    }
  });

  it("is deterministic for the same spec and seed", () => {
    const a = layoutRoom(baseSpec, pack, BASE);
    const b = layoutRoom(baseSpec, pack, BASE);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("changes the floor with the seed, and the dark style uses only floor-dark", () => {
    const other = layoutRoom({ ...baseSpec, seed: 7 }, pack, BASE);
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(layoutRoom(baseSpec, pack, BASE)));
    const dark = layoutRoom({ ...baseSpec, floorStyle: "dark" }, pack, BASE);
    const floor = dark.tiles.filter((t) => t.elevation === 0 && t.sort === LAYER_SORT.floor);
    expect(floor.every((t) => t.texture.src.endsWith("floor-dark.png"))).toBe(true);
  });

  it("resizing by 10 columns adds exactly 10*gridH floor tiles and no new images", () => {
    const before = layoutRoom(baseSpec, pack, BASE);
    const after = layoutRoom({ ...baseSpec, gridW: 18 }, pack, BASE);
    expect(after.width).toBe(18 * TILE_PX);
    expect(after.height).toBe(6 * TILE_PX);
    const floorBefore = before.tiles.filter((t) => t.elevation === 0 && t.sort === LAYER_SORT.floor).length;
    const floorAfter = after.tiles.filter((t) => t.elevation === 0 && t.sort === LAYER_SORT.floor).length;
    expect(floorAfter - floorBefore).toBe(10 * 6);
    // Every tile src in the resized room is a pack file — no new images.
    const packFiles = new Set([...pack.values()].map((e) => path.basename(e.file)));
    for (const t of after.tiles) {
      expect(packFiles.has(path.basename(t.texture.src))).toBe(true);
    }
  });
});

describe("layoutRoom — wall ring", () => {
  it("places corner tiles with the right rotations", () => {
    const layout = layoutRoom(baseSpec, pack, BASE);
    const corners = layout.tiles.filter((t) => t.texture.src.endsWith("wall-corner.png"));
    expect(corners).toHaveLength(4);
    const byPos = new Map(corners.map((t) => [`${t.x},${t.y}`, t.rotation]));
    expect(byPos.get("0,0")).toBe(cornerRotation("nw"));
    expect(byPos.get("700,0")).toBe(cornerRotation("ne"));
    expect(byPos.get("700,500")).toBe(cornerRotation("se"));
    expect(byPos.get("0,500")).toBe(cornerRotation("sw"));
  });

  it("places straight tiles on the edges and a door tile at the door cell", () => {
    const layout = layoutRoom(baseSpec, pack, BASE);
    const straights = layout.tiles.filter((t) => t.texture.src.endsWith("wall-straight.png"));
    // Perimeter non-corner cells: 2*(8-2) + 2*(6-2) = 20; one is the door.
    expect(straights).toHaveLength(19);
    const doors = layout.tiles.filter((t) => t.texture.src.endsWith("wall-door.png"));
    expect(doors).toHaveLength(1);
    expect(doors[0].x).toBe(3 * TILE_PX);
    expect(doors[0].y).toBe(5 * TILE_PX);
    expect(doors[0].rotation).toBe(wallRotation("south"));
    // Every wall tile sits above the floor, same elevation.
    for (const t of [...straights, ...doors]) {
      expect(t.elevation).toBe(0);
      expect(t.sort).toBe(LAYER_SORT.wall);
    }
  });

  it("wall rotations map each side's band to the outer edge", () => {
    expect(wallRotation("north")).toBe(0);
    expect(wallRotation("east")).toBe(90);
    expect(wallRotation("south")).toBe(180);
    expect(wallRotation("west")).toBe(270);
  });
});

describe("layoutRoom — collision walls", () => {
  it("closes the perimeter except for the door span", () => {
    const layout = layoutRoom(baseSpec, pack, BASE);
    // North 1, south split 2 + door 1, east 1, west 1 = 6 wall docs.
    expect(layout.walls).toHaveLength(6);
    const doorSegs = layout.walls.filter((w) => w.door === 1);
    expect(doorSegs).toHaveLength(1);
    expect(doorSegs[0]).toEqual({ x1: 300, y1: 600, x2: 400, y2: 600, door: 1 });
    // Plain segments cover the rest of the perimeter exactly once.
    const plain = layout.walls.filter((w) => w.door === 0);
    const length = (w: { x1: number; y1: number; x2: number; y2: number }) =>
      Math.abs(w.x2 - w.x1) + Math.abs(w.y2 - w.y1);
    const total = plain.reduce((s, w) => s + length(w), 0);
    expect(total).toBe(2 * 800 + 2 * 600 - TILE_PX);
  });

  it("handles two doors on different walls", () => {
    const layout = layoutRoom(
      { ...baseSpec, doors: [{ wall: "north", at: 2 }, { wall: "east", at: 3 }] },
      pack,
      BASE,
    );
    expect(layout.walls.filter((w) => w.door === 1)).toHaveLength(2);
    expect(layout.walls).toHaveLength(8);
  });
});

describe("layoutRoom — layers, dressing, fog, lights", () => {
  it("dressing sits above the floor and below the tokens; fog floats above", () => {
    const layout = layoutRoom(baseSpec, pack, BASE);
    const bones = layout.tiles.filter((t) => t.texture.src.endsWith("bones.png"));
    expect(bones).toHaveLength(1);
    expect(bones[0].x).toBe(200);
    expect(bones[0].y).toBe(200);
    expect(bones[0].width).toBe(200);
    expect(bones[0].elevation).toBe(0);
    expect(bones[0].sort).toBe(LAYER_SORT.dressing);
    const fog = layout.tiles.filter((t) => t.texture.src.endsWith("fog-wisp-large.png"));
    expect(fog).toHaveLength(1);
    expect(fog[0].elevation).toBe(FOG_ELEVATION);
    expect(fog[0].sort).toBe(0);
  });

  it("hidden fog stays hidden, and alpha passes through", () => {
    const layout = layoutRoom(
      { ...baseSpec, fog: [{ tile: "fog-pool", gx: 0, gy: 0, alpha: 0.5, hidden: true }] },
      pack,
      BASE,
    );
    const fog = layout.tiles.filter((t) => t.texture.src.endsWith("fog-pool.png"));
    expect(fog).toHaveLength(1);
    expect(fog[0].hidden).toBe(true);
    expect(fog[0].alpha).toBe(0.5);
  });

  it("torches expand to warm amber lights at cell centres", () => {
    const layout = layoutRoom(baseSpec, pack, BASE);
    expect(layout.lights).toHaveLength(1);
    expect(layout.lights[0]).toEqual({
      x: 150,
      y: 150,
      dim: 300,
      bright: 120,
      color: "#ff9a3c",
    });
  });

  it("tile creation order is floor, then wall, then dressing, then fog", () => {
    const layout = layoutRoom(baseSpec, pack, BASE);
    const kinds = layout.tiles.map((t) =>
      t.elevation === FOG_ELEVATION
        ? "fog"
        : t.sort === LAYER_SORT.floor
          ? "floor"
          : t.sort === LAYER_SORT.wall
            ? "wall"
            : "dressing",
    );
    const first = (k: (typeof kinds)[number]) => kinds.indexOf(k);
    expect(first("floor")).toBe(0);
    expect(first("wall")).toBeGreaterThan(first("floor"));
    expect(first("dressing")).toBeGreaterThan(first("wall"));
    expect(first("fog")).toBeGreaterThan(first("dressing"));
  });
});

describe("layoutRoom — validation", () => {
  it("rejects rooms smaller than 1x1 — but a 1-wide corridor is a valid room (FR-12)", () => {
    expect(() => layoutRoom({ ...baseSpec, gridW: 0 }, pack, BASE)).toThrow(/1x1/);
    expect(() => layoutRoom({ ...baseSpec, gridH: 0 }, pack, BASE)).toThrow(/1x1/);
    expect(() => layoutRoom({ name: "Corridor", gridW: 1, gridH: 6 }, pack, BASE)).not.toThrow();
  });

  it("rejects doors in corners and out of range", () => {
    expect(() => layoutRoom({ ...baseSpec, doors: [{ wall: "south", at: 0 }] }, pack, BASE)).toThrow(/corner/);
    expect(() => layoutRoom({ ...baseSpec, doors: [{ wall: "south", at: 7 }] }, pack, BASE)).toThrow(/corner/);
    expect(() => layoutRoom({ ...baseSpec, doors: [{ wall: "east", at: 5 }] }, pack, BASE)).toThrow(/corner/);
  });

  it("rejects duplicate doors", () => {
    expect(() =>
      layoutRoom({ ...baseSpec, doors: [{ wall: "south", at: 3 }, { wall: "south", at: 3 }] }, pack, BASE),
    ).toThrow(/Duplicate door/);
  });

  it("rejects unknown tiles and placements outside the room", () => {
    expect(() =>
      layoutRoom({ ...baseSpec, dressing: [{ tile: "dragon", gx: 0, gy: 0 }] }, pack, BASE),
    ).toThrow(/not in the pack/);
    expect(() =>
      layoutRoom({ ...baseSpec, dressing: [{ tile: "bones", gx: 7, gy: 5 }] }, pack, BASE),
    ).toThrow(/does not fit/);
    expect(() =>
      layoutRoom({ ...baseSpec, torches: [{ gx: 8, gy: 0 }] }, pack, BASE),
    ).toThrow(/outside/);
  });
});

describe("mulberry32", () => {
  it("is deterministic and spreads across [0, 1)", () => {
    const a = mulberry32(1);
    const b = mulberry32(1);
    expect(a()).toBe(b());
    const vals = Array.from({ length: 100 }, () => mulberry32(99)());
    expect(vals.every((v) => v >= 0 && v < 1)).toBe(true);
  });
});

describe("layoutDungeon — graph", () => {
  const hall: RoomSpec & { id: string } = {
    id: "hall",
    name: "Entry Hall",
    gridW: 8,
    gridH: 6,
    seed: 1,
    doors: [{ wall: "south", at: 3 }],
  };
  const crypt: RoomSpec & { id: string } = {
    id: "crypt",
    name: "Crypt",
    gridW: 6,
    gridH: 6,
    seed: 2,
    doors: [{ wall: "north", at: 2 }],
  };
  const twoRoom: DungeonSpec = {
    rooms: [hall, crypt],
    links: [{ from: { room: "hall", wall: "south", at: 3 }, to: { room: "crypt", wall: "north", at: 2 } }],
  };

  it("lays out each room and resolves the link with arrival cells", () => {
    const d = layoutDungeon(twoRoom, pack, BASE);
    expect(d.rooms).toHaveLength(2);
    expect(d.rooms[0].id).toBe("hall");
    expect(d.rooms[0].layout.width).toBe(800);
    expect(d.rooms[1].id).toBe("crypt");
    expect(d.rooms[1].layout.height).toBe(600);
    expect(d.links).toHaveLength(1);
    const link = d.links[0];
    // Hall south door at 3: arrive one cell in from the south wall.
    expect(link.from).toEqual({ room: "hall", wall: "south", at: 3, enterGx: 3, enterGy: 4, floor: 0 });
    // Crypt north door at 2: arrive one cell in from the north wall.
    expect(link.to).toEqual({ room: "crypt", wall: "north", at: 2, enterGx: 2, enterGy: 1, floor: 0 });
  });

  it("doorEntryCell is one cell in from each wall", () => {
    expect(doorEntryCell("north", 2, 8, 6)).toEqual({ gx: 2, gy: 1 });
    expect(doorEntryCell("south", 2, 8, 6)).toEqual({ gx: 2, gy: 4 });
    expect(doorEntryCell("west", 3, 8, 6)).toEqual({ gx: 1, gy: 3 });
    expect(doorEntryCell("east", 3, 8, 6)).toEqual({ gx: 6, gy: 3 });
  });

  it("resolveDoorWalk returns the other end, or null for an unlinked door", () => {
    const d = layoutDungeon(twoRoom, pack, BASE);
    const intoCrypt = resolveDoorWalk(d, "hall", "south", 3);
    expect(intoCrypt).toEqual({ room: "crypt", wall: "north", at: 2, enterGx: 2, enterGy: 1, floor: 0 });
    const intoHall = resolveDoorWalk(d, "crypt", "north", 2);
    expect(intoHall).toEqual({ room: "hall", wall: "south", at: 3, enterGx: 3, enterGy: 4, floor: 0 });
    expect(resolveDoorWalk(d, "hall", "north", 2)).toBeNull();
  });

  it("links a chain of three rooms", () => {
    const lair: RoomSpec & { id: string } = {
      id: "lair",
      name: "Lich's Lair",
      gridW: 6,
      gridH: 6,
      seed: 3,
      floorStyle: "dark",
      doors: [{ wall: "west", at: 2 }],
    };
    const cryptEast: RoomSpec & { id: string } = {
      ...crypt,
      doors: [{ wall: "north", at: 2 }, { wall: "east", at: 3 }],
    };
    const d = layoutDungeon(
      {
        rooms: [hall, cryptEast, lair],
        links: [
          { from: { room: "hall", wall: "south", at: 3 }, to: { room: "crypt", wall: "north", at: 2 } },
          { from: { room: "crypt", wall: "east", at: 3 }, to: { room: "lair", wall: "west", at: 2 } },
        ],
      },
      pack,
      BASE,
    );
    expect(d.rooms).toHaveLength(3);
    expect(d.links).toHaveLength(2);
  });

  it("rejects links to unknown rooms and to cells that are not doors", () => {
    expect(() =>
      layoutDungeon(
        { ...twoRoom, links: [{ from: { room: "hall", wall: "south", at: 3 }, to: { room: "vault", wall: "north", at: 2 } }] },
        pack,
        BASE,
      ),
    ).toThrow(/unknown room "vault"/);
    expect(() =>
      layoutDungeon(
        { ...twoRoom, links: [{ from: { room: "hall", wall: "south", at: 3 }, to: { room: "crypt", wall: "north", at: 4 } }] },
        pack,
        BASE,
      ),
    ).toThrow(/not a declared door/);
  });

  it("rejects a door used in two links, a self-link, and a duplicated link", () => {
    const extra: RoomSpec & { id: string } = {
      id: "extra",
      name: "Extra",
      gridW: 5,
      gridH: 5,
      doors: [{ wall: "north", at: 2 }],
    };
    expect(() =>
      layoutDungeon(
        {
          rooms: [hall, crypt, extra],
          links: [
            { from: { room: "hall", wall: "south", at: 3 }, to: { room: "crypt", wall: "north", at: 2 } },
            { from: { room: "hall", wall: "south", at: 3 }, to: { room: "extra", wall: "north", at: 2 } },
          ],
        },
        pack,
        BASE,
      ),
    ).toThrow(/two links/);
    expect(() =>
      layoutDungeon(
        { ...twoRoom, links: [{ from: { room: "hall", wall: "south", at: 3 }, to: { room: "hall", wall: "south", at: 3 } }] },
        pack,
        BASE,
      ),
    ).toThrow(/itself/);
    expect(() =>
      layoutDungeon(
        {
          ...twoRoom,
          links: [
            { from: { room: "hall", wall: "south", at: 3 }, to: { room: "crypt", wall: "north", at: 2 } },
            { from: { room: "crypt", wall: "north", at: 2 }, to: { room: "hall", wall: "south", at: 3 } },
          ],
        },
        pack,
        BASE,
      ),
    ).toThrow(/Duplicate link/);
  });

  it("rejects duplicate room ids and disconnected rooms", () => {
    expect(() =>
      layoutDungeon({ rooms: [hall, { ...crypt, id: "hall" }], links: twoRoom.links }, pack, BASE),
    ).toThrow(/Duplicate room id/);
    const stranded: RoomSpec & { id: string } = {
      id: "stranded",
      name: "Stranded",
      gridW: 5,
      gridH: 5,
      doors: [{ wall: "north", at: 2 }],
    };
    expect(() =>
      layoutDungeon({ rooms: [hall, crypt, stranded], links: twoRoom.links }, pack, BASE),
    ).toThrow(/not connected.*stranded/);
  });
});
