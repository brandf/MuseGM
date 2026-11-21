/**
 * Tests for FR-6 prop persistence (BRA-218): props as first-class
 * objects on the RoomSpec.
 *
 * - The prop list lives in the spec (pure data): place/move/remove
 *   are pure spec edits, the composer reads them deterministically.
 * - A rebuild re-places the same props in the same cells; the seed
 *   never re-randomizes them.
 * - A theme re-skin keeps each prop, or swaps it for the theme's
 *   variant when the theme defines one.
 * - Invalid props are rejected with an error naming the known props.
 *
 * Run: bun test tests/props.test.ts
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
  carveMazeRegion,
  layoutRoom,
  listProps,
  listPropTiles,
  loadPack,
  moveProp,
  placeProp,
  removeProp,
  validateRoomSpec,
  widenRoom,
  type Pack,
  type RoomSpec,
} from "../src/worldbuilding/tiles-layout.js";
import { DUNGEON_THEME } from "../src/worldbuilding/themes.js";

const pack: Pack = loadPack(path.resolve(import.meta.dir, "../tiles/manifest.json"));
const BASE = "worlds/testbed";
const KNOWN_PROPS = "altar, bones, chest, pillar, ritual-circle, rubble, sconce, skeleton, spear";

/** 8x6 room with one legacy prop (no id — written before ids existed). */
const baseSpec: RoomSpec = {
  name: "Test Room",
  gridW: 8,
  gridH: 6,
  seed: 42,
  doors: [{ wall: "south", at: 3 }],
  dressing: [{ tile: "bones", gx: 2, gy: 2 }],
  fog: [{ tile: "fog-wisp-large", gx: 1, gy: 1 }],
  torches: [{ gx: 1, gy: 1 }],
  description: "A dusty test room.",
};

/** Dressing TileDocs from a layout, keyed by tile file name. */
const dressingTiles = (spec: RoomSpec, theme?: string) => {
  const layout = layoutRoom(spec, pack, BASE, theme);
  return layout.tiles.filter((t) => t.sort === 20);
};
const srcName = (t: { texture: { src: string } }) => t.texture.src.split("/").pop() ?? t.texture.src;

describe("listPropTiles", () => {
  it("names the dressing-layer tiles, sorted — and no brazier", () => {
    expect(listPropTiles(pack)).toEqual(KNOWN_PROPS.split(", "));
    expect(listPropTiles(pack)).not.toContain("brazier");
    expect(listPropTiles(pack)).not.toContain("candle");
  });
});

describe("listProps", () => {
  it("lists the room's props with synthesized ids for legacy placements", () => {
    expect(listProps(baseSpec)).toEqual([{ id: "bones@2,2", tile: "bones", gx: 2, gy: 2 }]);
  });

  it("lists placed props with their real ids, in spec order", () => {
    const spec = placeProp(placeProp(baseSpec, { tile: "chest", gx: 5, gy: 4 }, pack), { tile: "altar", gx: 0, gy: 0 }, pack);
    expect(listProps(spec)).toEqual([
      { id: "bones@2,2", tile: "bones", gx: 2, gy: 2 },
      { id: "prop-1", tile: "chest", gx: 5, gy: 4 },
      { id: "prop-2", tile: "altar", gx: 0, gy: 0 },
    ]);
  });

  it("lists no props for a bare room", () => {
    expect(listProps({ name: "Bare", gridW: 4, gridH: 4 })).toEqual([]);
  });
});

describe("placeProp", () => {
  it("appends a prop with a fresh id and leaves the input spec untouched", () => {
    const spec = placeProp(baseSpec, { tile: "chest", gx: 5, gy: 4 }, pack);
    expect(spec.dressing).toEqual([
      { tile: "bones", gx: 2, gy: 2 },
      { tile: "chest", gx: 5, gy: 4, id: "prop-1" },
    ]);
    // The input spec is never mutated.
    expect(baseSpec.dressing).toEqual([{ tile: "bones", gx: 2, gy: 2 }]);
  });

  it("numbers ids past the highest prop number, never reusing a freed one", () => {
    const spec = placeProp(placeProp(baseSpec, { tile: "chest", gx: 5, gy: 4 }, pack), { tile: "pillar", gx: 0, gy: 0 }, pack);
    expect(listProps(spec).map((p) => p.id)).toEqual(["bones@2,2", "prop-1", "prop-2"]);
    // After removing prop-1, the next place is prop-3, not prop-1:
    // ids are monotonic, so a GM's notes never rebind to a new prop.
    const removed = removeProp(spec, "prop-1");
    expect(listProps(placeProp(removed, { tile: "rubble", gx: 5, gy: 0 }, pack)).map((p) => p.id)).toEqual([
      "bones@2,2",
      "prop-2",
      "prop-3",
    ]);
  });

  it("keeps rotation and alpha on the placed prop", () => {
    const spec = placeProp(baseSpec, { tile: "spear", gx: 0, gy: 0, rotation: 90, alpha: 0.5 }, pack);
    expect(spec.dressing?.[1]).toEqual({ tile: "spear", gx: 0, gy: 0, rotation: 90, alpha: 0.5, id: "prop-1" });
  });

  it("rejects an unknown tile with an error naming the known props", () => {
    expect(() => placeProp(baseSpec, { tile: "dragon", gx: 0, gy: 0 }, pack)).toThrow(
      `Unknown prop "dragon" — not in the pack. Known props: ${KNOWN_PROPS}.`,
    );
  });

  it("rejects a brazier — no such tile exists, so it is never smuggled in", () => {
    expect(() => placeProp(baseSpec, { tile: "brazier", gx: 0, gy: 0 }, pack)).toThrow(
      `Unknown prop "brazier" — not in the pack. Known props: ${KNOWN_PROPS}.`,
    );
  });

  it("rejects a real tile that is not a prop, naming its layer", () => {
    expect(() => placeProp(baseSpec, { tile: "floor-plain", gx: 0, gy: 0 }, pack)).toThrow(
      `"floor-plain" is a floor tile, not a prop. Known props: ${KNOWN_PROPS}.`,
    );
  });

  it("rejects a placement outside the room and one on a maze wall", () => {
    expect(() => placeProp(baseSpec, { tile: "bones", gx: 7, gy: 5 }, pack)).toThrow(/does not fit/);
    // 5x5 maze region at (1,1): its top border is a wall everywhere
    // except the entrance opening at (4,1), so a 2x2 prop at (1,1)
    // covers wall cells (1,1) and (2,1).
    const mazeSpec = carveMazeRegion(
      { name: "Maze Room", gridW: 8, gridH: 8, seed: 1, doors: [{ wall: "north", at: 3 }] },
      { gx: 1, gy: 1, w: 5, h: 5, seed: 7 },
    );
    expect(() => placeProp(mazeSpec, { tile: "bones", gx: 1, gy: 1 }, pack)).toThrow(/maze wall/);
  });
});

describe("moveProp", () => {
  /** Chest placed at (5,4) with id prop-1. */
  const withChest = placeProp(baseSpec, { tile: "chest", gx: 5, gy: 4 }, pack);

  it("moves a prop by id, keeping the id, and leaves the input untouched", () => {
    const spec = moveProp(withChest, "prop-1", { gx: 0, gy: 4 }, pack);
    expect(listProps(spec)).toEqual([
      { id: "bones@2,2", tile: "bones", gx: 2, gy: 2 },
      { id: "prop-1", tile: "chest", gx: 0, gy: 4 },
    ]);
    expect(listProps(withChest)[1]).toEqual({ id: "prop-1", tile: "chest", gx: 5, gy: 4 });
  });

  it("moves by bare tile name when the room holds exactly one of it", () => {
    expect(listProps(moveProp(withChest, "chest", { gx: 0, gy: 4 }, pack))[1]).toEqual({
      id: "prop-1",
      tile: "chest",
      gx: 0,
      gy: 4,
    });
  });

  it("moves a legacy prop by tile + cell, and by synthesized id", () => {
    expect(listProps(moveProp(baseSpec, { tile: "bones", gx: 2, gy: 2 }, { gx: 4, gy: 0 }, pack))).toEqual([
      { id: "bones@4,0", tile: "bones", gx: 4, gy: 0 },
    ]);
    expect(listProps(moveProp(baseSpec, "bones@2,2", { gx: 4, gy: 0 }, pack))).toEqual([
      { id: "bones@4,0", tile: "bones", gx: 4, gy: 0 },
    ]);
  });

  it("refuses an unknown prop, naming what the room actually has", () => {
    expect(() => moveProp(withChest, "dragon", { gx: 0, gy: 0 }, pack)).toThrow(
      `No prop "dragon" in this room — the room has: "bones" at (2,2), "chest" at (5,4).`,
    );
    expect(() => moveProp(withChest, { tile: "chest", gx: 0, gy: 0 }, { gx: 1, gy: 1 }, pack)).toThrow(
      `No "chest" at (0,0) in this room — the room has: "bones" at (2,2), "chest" at (5,4).`,
    );
  });

  it("refuses an ambiguous bare name, listing both cells", () => {
    const twoBones = placeProp(baseSpec, { tile: "bones", gx: 5, gy: 4 }, pack);
    expect(() => moveProp(twoBones, "bones", { gx: 0, gy: 0 }, pack)).toThrow(
      `More than one "bones" in this room — say which one: "bones" at (2,2), "bones" at (5,4).`,
    );
  });

  it("refuses a destination outside the room", () => {
    expect(() => moveProp(withChest, "prop-1", { gx: 7, gy: 5 }, pack)).toThrow(/does not fit/);
  });
});

describe("removeProp", () => {
  const withChest = placeProp(baseSpec, { tile: "chest", gx: 5, gy: 4 }, pack);

  it("removes by id, by bare name, and by tile + cell — the rest keep their ids", () => {
    expect(listProps(removeProp(withChest, "prop-1"))).toEqual([{ id: "bones@2,2", tile: "bones", gx: 2, gy: 2 }]);
    expect(listProps(removeProp(withChest, "chest"))).toEqual([{ id: "bones@2,2", tile: "bones", gx: 2, gy: 2 }]);
    expect(listProps(removeProp(withChest, { tile: "chest", gx: 5, gy: 4 }))).toEqual([
      { id: "bones@2,2", tile: "bones", gx: 2, gy: 2 },
    ]);
    expect(listProps(removeProp(baseSpec, "bones@2,2"))).toEqual([]);
  });

  it("refuses an unknown or ambiguous prop, naming what the room has", () => {
    expect(() => removeProp(withChest, "dragon")).toThrow(
      `No prop "dragon" in this room — the room has: "bones" at (2,2), "chest" at (5,4).`,
    );
    const twoBones = placeProp(baseSpec, { tile: "bones", gx: 5, gy: 4 }, pack);
    expect(() => removeProp(twoBones, "bones")).toThrow(/More than one "bones" in this room/);
  });
});

describe("props survive a rebuild round-trip", () => {
  const spec = placeProp(placeProp(baseSpec, { tile: "chest", gx: 5, gy: 4 }, pack), { tile: "altar", gx: 0, gy: 0 }, pack);

  it("the composer places the same props in the same cells", () => {
    const tiles = dressingTiles(spec);
    expect(tiles.map((t) => `${srcName(t)}@${t.x / 100},${t.y / 100}`).sort()).toEqual([
      "altar.png@0,0",
      "bones.png@2,2",
      "chest.png@5,4",
    ]);
  });

  it("the seed never re-randomizes props", () => {
    const a = dressingTiles(spec);
    const b = dressingTiles({ ...spec, seed: 7 });
    expect(b.map((t) => `${srcName(t)}@${t.x},${t.y}`).sort()).toEqual(a.map((t) => `${srcName(t)}@${t.x},${t.y}`).sort());
  });

  it("widening keeps the props — shifted when the growth is on the west", () => {
    const east = dressingTiles(widenRoom(spec, "east", 2));
    expect(east.map((t) => `${srcName(t)}@${t.x / 100},${t.y / 100}`).sort()).toEqual([
      "altar.png@0,0",
      "bones.png@2,2",
      "chest.png@5,4",
    ]);
    const west = dressingTiles(widenRoom(spec, "west", 2));
    expect(west.map((t) => `${srcName(t)}@${t.x / 100},${t.y / 100}`).sort()).toEqual([
      "altar.png@2,0",
      "bones.png@4,2",
      "chest.png@7,4",
    ]);
  });
});

describe("a theme re-skin keeps or swaps each prop", () => {
  it("western keeps the props — the theme defines no dressing variants", () => {
    const tiles = dressingTiles(baseSpec, "western");
    expect(tiles.map((t) => `${srcName(t)}@${t.x / 100},${t.y / 100}`)).toEqual(["bones.png@2,2"]);
  });

  it("a theme with a dressing variant swaps the prop for it", () => {
    // bones -> skeleton: both are real pack tiles, so the swap is a
    // pure mechanism check, not a claim about a new tile.
    const remap = { ...DUNGEON_THEME, id: "remap-test", dressing: { bones: "skeleton" } };
    const layout = layoutRoom(baseSpec, pack, BASE, remap);
    const tiles = layout.tiles.filter((t) => t.sort === 20);
    expect(tiles.map((t) => `${srcName(t)}@${t.x / 100},${t.y / 100}`)).toEqual(["skeleton.png@2,2"]);
  });
});

describe("validateRoomSpec", () => {
  it("rejects duplicate prop ids", () => {
    const spec: RoomSpec = {
      ...baseSpec,
      dressing: [
        { tile: "bones", gx: 2, gy: 2, id: "prop-1" },
        { tile: "chest", gx: 5, gy: 4, id: "prop-1" },
      ],
    };
    expect(() => validateRoomSpec(spec, pack)).toThrow(
      `Duplicate prop id "prop-1" in room spec — each prop needs its own id.`,
    );
  });

  it("rejects an unknown dressing tile, naming the known props", () => {
    expect(() => validateRoomSpec({ ...baseSpec, dressing: [{ tile: "dragon", gx: 0, gy: 0 }] }, pack)).toThrow(
      `Unknown dressing tile "dragon" — not in the pack. Known props: ${KNOWN_PROPS}.`,
    );
  });

  it("rejects a floor tile on the dressing layer", () => {
    expect(() => validateRoomSpec({ ...baseSpec, dressing: [{ tile: "floor-plain", gx: 0, gy: 0 }] }, pack)).toThrow(
      `"floor-plain" is a floor tile, not a prop. Known props: ${KNOWN_PROPS}.`,
    );
  });
});
