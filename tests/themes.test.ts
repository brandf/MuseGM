/**
 * Unit tests for theme re-skin (FR-2): src/worldbuilding/themes.ts.
 * Pure composition math only — no Foundry, no network.
 * Run: bun test tests/themes.test.ts
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
  DUNGEON_THEME,
  THEMES,
  WESTERN_THEME,
  listThemes,
  resolveTheme,
  themeTileGaps,
  themeTileNames,
} from "../src/worldbuilding/themes.js";
import {
  LAYER_SORT,
  TILE_PX,
  layoutDungeon,
  layoutRoom,
  loadPack,
  type DungeonSpec,
  type Pack,
  type RoomSpec,
  type TileDoc,
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

const floorTiles = (layout: { tiles: TileDoc[] }) =>
  layout.tiles.filter((t) => t.elevation === 0 && t.sort === LAYER_SORT.floor);
const srcName = (t: TileDoc) => path.basename(t.texture.src);

describe("resolveTheme — one-word choices", () => {
  it("defaults to the dungeon baseline for undefined, empty, and blank input", () => {
    expect(resolveTheme()).toBe(DUNGEON_THEME);
    expect(resolveTheme("")).toBe(DUNGEON_THEME);
    expect(resolveTheme("   ")).toBe(DUNGEON_THEME);
  });

  it("resolves by name, case-insensitively, with surrounding space trimmed", () => {
    expect(resolveTheme("dungeon")).toBe(DUNGEON_THEME);
    expect(resolveTheme("western")).toBe(WESTERN_THEME);
    expect(resolveTheme("Western")).toBe(WESTERN_THEME);
    expect(resolveTheme("  WESTERN  ")).toBe(WESTERN_THEME);
  });

  it("passes a ThemeSpec object through untouched", () => {
    expect(resolveTheme(WESTERN_THEME)).toBe(WESTERN_THEME);
  });

  it("throws for an unknown theme, listing the themes that exist", () => {
    expect(() => resolveTheme("gothic")).toThrow(/Unknown theme "gothic"/);
    expect(() => resolveTheme("gothic")).toThrow(/dungeon, western/);
    expect(() => resolveTheme("sci-fi")).toThrow(/Unknown theme/);
  });

  it("lists the themes the GM can pick", () => {
    expect(listThemes()).toEqual(["dungeon", "western"]);
    expect(Object.keys(THEMES)).toEqual(["dungeon", "western"]);
  });
});

describe("themeTileGaps — never fake a tile", () => {
  it("both shipped themes have zero gaps against the real pack", () => {
    expect(themeTileGaps(DUNGEON_THEME, pack)).toEqual([]);
    expect(themeTileGaps(WESTERN_THEME, pack)).toEqual([]);
    expect(themeTileNames(WESTERN_THEME)).toContain("floor-sand");
    expect(themeTileNames(WESTERN_THEME)).toContain("wall-wood-door");
    expect(themeTileNames(WESTERN_THEME)).toContain("dust-pool");
  });

  it("reports a theme's missing tiles by name, deduplicated", () => {
    const broken = {
      ...WESTERN_THEME,
      id: "broken",
      floor: { ...WESTERN_THEME.floor, plain: "floor-nope", dark: "floor-nope" },
    };
    expect(themeTileGaps(broken, pack)).toEqual(["floor-nope"]);
  });
});

describe("layoutRoom — the dungeon default is unchanged", () => {
  it("no theme, spec.theme dungeon, and an explicit dungeon theme all lay out identically", () => {
    const plain = layoutRoom(baseSpec, pack, BASE);
    const viaSpec = layoutRoom({ ...baseSpec, theme: "dungeon" }, pack, BASE);
    const viaArg = layoutRoom(baseSpec, pack, BASE, DUNGEON_THEME);
    const viaName = layoutRoom(baseSpec, pack, BASE, "dungeon");
    expect(JSON.stringify(viaSpec)).toBe(JSON.stringify(plain));
    expect(JSON.stringify(viaArg)).toBe(JSON.stringify(plain));
    expect(JSON.stringify(viaName)).toBe(JSON.stringify(plain));
  });

  it("the dungeon theme still uses the old tile names and the warm amber torch", () => {
    const layout = layoutRoom(baseSpec, pack, BASE);
    const names = new Set(floorTiles(layout).map(srcName));
    expect(names.has("floor-plain.png")).toBe(true);
    expect([...names].every((n) => n.startsWith("floor-"))).toBe(true);
    expect(layout.lights[0]).toEqual({
      x: 150, y: 150, dim: 300, bright: 120, color: "#ff9a3c",
    });
    expect(layout.tiles.some((t) => srcName(t) === "wall-straight.png")).toBe(true);
  });
});

describe("layoutRoom — western theme end to end", () => {
  const western = layoutRoom({ ...baseSpec, theme: "western" }, pack, BASE);

  it("lays out the same room in sandstone and wood", () => {
    expect(western.width).toBe(800);
    expect(western.height).toBe(600);
    const names = new Set(floorTiles(western).map(srcName));
    expect(names.size).toBeGreaterThan(0);
    for (const n of names) expect(n.startsWith("floor-sand")).toBe(true);
    expect(names.has("floor-sand.png")).toBe(true);
    expect(western.tiles.some((t) => srcName(t) === "wall-wood-straight.png")).toBe(true);
    expect(western.tiles.some((t) => srcName(t) === "wall-wood-corner.png")).toBe(true);
    const door = western.tiles.filter((t) => srcName(t) === "wall-wood-door.png");
    expect(door).toHaveLength(1);
    expect(door[0].x).toBe(3 * TILE_PX);
    expect(door[0].y).toBe(5 * TILE_PX);
    // No dungeon tiles leak into a western room.
    for (const t of western.tiles) {
      expect(srcName(t)).not.toMatch(/^(floor-plain|floor-cracked|floor-rubble|floor-dark|wall-straight|wall-corner|wall-door|fog-)/);
    }
  });

  it("re-skins the fog to dust and the torch to lantern gold", () => {
    const fog = western.tiles.filter((t) => t.elevation === 1);
    expect(fog).toHaveLength(1);
    expect(srcName(fog[0])).toBe("dust-wisp-large.png");
    expect(western.lights[0]).toEqual({
      x: 150, y: 150, dim: 280, bright: 110, color: "#ffb347",
    });
  });

  it("the dark floor style uses the western dark tile", () => {
    const dark = layoutRoom({ ...baseSpec, theme: "western", floorStyle: "dark" }, pack, BASE);
    expect(floorTiles(dark).every((t) => srcName(t) === "floor-sand-dark.png")).toBe(true);
  });

  it("an explicit theme argument overrides the theme on the spec", () => {
    const overridden = layoutRoom({ ...baseSpec, theme: "dungeon" }, pack, BASE, "western");
    expect(JSON.stringify(overridden)).toBe(JSON.stringify(western));
    const back = layoutRoom({ ...baseSpec, theme: "western" }, pack, BASE, "dungeon");
    expect(JSON.stringify(back)).toBe(JSON.stringify(layoutRoom(baseSpec, pack, BASE)));
  });
});

describe("layoutRoom — re-skin preserves the layout", () => {
  it("dungeon vs western: same geometry, only the look changes", () => {
    const dungeon = layoutRoom(baseSpec, pack, BASE);
    const western = layoutRoom({ ...baseSpec, theme: "western" }, pack, BASE);
    expect(western.width).toBe(dungeon.width);
    expect(western.height).toBe(dungeon.height);
    // Collision walls are identical — the party walks the same room.
    expect(western.walls).toEqual(dungeon.walls);
    // Every tile sits in the same place, same size, same layer, same
    // rotation — only the texture changes.
    expect(western.tiles).toHaveLength(dungeon.tiles.length);
    for (let i = 0; i < dungeon.tiles.length; i++) {
      const a = dungeon.tiles[i];
      const b = western.tiles[i];
      expect({ ...b, texture: a.texture }).toEqual(a);
    }
    // Lights sit in the same places; only the palette changes.
    expect(western.lights).toHaveLength(dungeon.lights.length);
    expect(western.lights[0].x).toBe(dungeon.lights[0].x);
    expect(western.lights[0].y).toBe(dungeon.lights[0].y);
    expect(western.lights[0].color).not.toBe(dungeon.lights[0].color);
  });
});

describe("layoutRoom — remap mechanics", () => {
  it("a synthetic theme proves the dressing remap without faking a tile", () => {
    // bones -> rubble: both are real pack tiles, so the remap is a
    // pure mechanism check, not a claim about a new tile.
    const remap = {
      ...DUNGEON_THEME,
      id: "remap-test",
      dressing: { bones: "rubble" },
    };
    const layout = layoutRoom(baseSpec, pack, BASE, remap);
    expect(layout.tiles.some((t) => srcName(t) === "bones.png")).toBe(false);
    const rubble = layout.tiles.filter((t) => srcName(t) === "rubble.png");
    // The dressing bones became a rubble tile at the bones cell.
    expect(rubble.some((t) => t.x === 200 && t.y === 200)).toBe(true);
  });

  it("fog remaps only the names the theme lists; unlisted fog keeps its tile", () => {
    const partial = {
      ...DUNGEON_THEME,
      id: "partial-fog",
      atmosphere: { "fog-wisp-large": "dust-wisp-large" },
    };
    const large = layoutRoom(baseSpec, pack, BASE, partial);
    expect(large.tiles.some((t) => srcName(t) === "dust-wisp-large.png")).toBe(true);
    const pool = layoutRoom(
      { ...baseSpec, fog: [{ tile: "fog-pool", gx: 0, gy: 0 }] },
      pack, BASE, partial,
    );
    expect(pool.tiles.some((t) => srcName(t) === "fog-pool.png")).toBe(true);
  });

  it("an unknown theme on the spec throws at layout time", () => {
    expect(() => layoutRoom({ ...baseSpec, theme: "gothic" }, pack, BASE)).toThrow(/Unknown theme "gothic"/);
  });

  it("a theme naming a tile the pack lacks throws, naming the theme and the tile", () => {
    const broken = {
      ...WESTERN_THEME,
      id: "broken",
      floor: { ...WESTERN_THEME.floor, plain: "floor-nope" },
    };
    expect(() => layoutRoom(baseSpec, pack, BASE, broken)).toThrow(
      /Theme "broken" needs tile not in the pack: floor-nope/,
    );
  });
});

describe("layoutDungeon — themes per room and per dungeon", () => {
  const hall: RoomSpec & { id: string } = {
    id: "hall",
    name: "Entry Hall",
    gridW: 8,
    gridH: 6,
    seed: 1,
    doors: [{ wall: "south", at: 3 }],
  };
  const street: RoomSpec & { id: string } = {
    id: "street",
    name: "Main Street",
    gridW: 6,
    gridH: 6,
    seed: 2,
    theme: "western",
    doors: [{ wall: "north", at: 2 }],
  };
  const twoRoom: DungeonSpec = {
    rooms: [hall, street],
    links: [{ from: { room: "hall", wall: "south", at: 3 }, to: { room: "street", wall: "north", at: 2 } }],
  };

  it("each room builds in its own theme, and the link still resolves", () => {
    const d = layoutDungeon(twoRoom, pack, BASE);
    expect(d.rooms).toHaveLength(2);
    expect(floorTiles(d.rooms[0].layout).every((t) => srcName(t).startsWith("floor-plain") || srcName(t).startsWith("floor-cracked") || srcName(t).startsWith("floor-rubble"))).toBe(true);
    expect(floorTiles(d.rooms[1].layout).every((t) => srcName(t).startsWith("floor-sand"))).toBe(true);
    expect(d.links).toHaveLength(1);
    expect(d.links[0].from).toEqual({ room: "hall", wall: "south", at: 3, enterGx: 3, enterGy: 4, floor: 0 });
  });

  it("a dungeon-level theme re-skins every room at once", () => {
    const d = layoutDungeon(twoRoom, pack, BASE, "western");
    for (const room of d.rooms) {
      expect(floorTiles(room.layout).every((t) => srcName(t).startsWith("floor-sand"))).toBe(true);
    }
    expect(d.links).toHaveLength(1);
  });
});
