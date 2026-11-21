/**
 * Tests for multi-floor dungeons + gated reveals (FR-3 / BRA-195).
 *
 * Two halves, like the implementation:
 * - Pure (src/worldbuilding/floors.ts + the stair validation in
 *   layoutDungeon): gate validation/evaluation, floor visibility,
 *   reveal planning, stair walks, staircase zones, zone-set
 *   validation, and the --dungeon/--gate-state file parsers. No
 *   Foundry, no network.
 * - Live (FloorSession + climbStair + revealFloorLive + the
 *   TrapWatcher reveal-floor action) against a compact in-memory
 *   fake world: scenes with navigation/active flags, tokens,
 *   modifyDocument for Scene updates and Token create/delete.
 *
 * Not covered here: buildTileRoom's `hidden` navigation flag and
 * buildDungeon's hideFloors option — those need the full scene-build
 * fake (see tests/tile-keys.test.ts); they are live-checklist items.
 * Run: bun test tests/floors.test.ts
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
  describeGate,
  evaluateGate,
  emptyFloorVisibility,
  floorsOf,
  FloorSession,
  gateFacts,
  hiddenFloors,
  isFloorRevealed,
  parseBuiltDungeon,
  parseGateState,
  planFloorReveals,
  planStairReveal,
  revealFloor,
  revealFloorLive,
  climbStair,
  resolveStairWalk,
  staircaseZone,
  validateGate,
  visibleRooms,
  type FloorDungeonFile,
  type GateState,
} from "../src/worldbuilding/floors.js";
import {
  doorEntryCell,
  layoutDungeon,
  loadPack,
  stairDirection,
  type DungeonRoomSpec,
  type DungeonSpec,
  type Pack,
  type ResolvedStairLink,
} from "../src/worldbuilding/tiles-layout.js";
import { resolveZoneSet } from "../src/session/zone-cutscene.js";
import { TrapWatcher } from "../src/session/traps.js";
import type { FoundryLive } from "../src/live.js";

const pack: Pack = loadPack(path.resolve(import.meta.dir, "../tiles/manifest.json"));
const BASE = "worlds/testbed";

const entryHall: DungeonRoomSpec = {
  id: "entry",
  name: "Entry Hall",
  gridW: 8,
  gridH: 6,
  seed: 42,
  floor: 0,
  doors: [{ wall: "north", at: 4 }],
  description: "The entry hall.",
};
const upperHall: DungeonRoomSpec = {
  id: "upper",
  name: "Upper Hall",
  gridW: 8,
  gridH: 6,
  seed: 7,
  floor: 1,
  doors: [{ wall: "south", at: 2 }],
  description: "The upper hall.",
};
const gatedStair = {
  from: { room: "entry", wall: "north" as const, at: 4 },
  to: { room: "upper", wall: "south" as const, at: 2 },
  gate: { kind: "plate-solved" as const, plate: "sun-plate" },
};
const twoFloor: DungeonSpec = {
  rooms: [entryHall, upperHall],
  links: [],
  stairs: [gatedStair],
};
const EMPTY: GateState = { platesSolved: [], doorsUnlocked: [], leversPulled: [] };

function layout() {
  return layoutDungeon(twoFloor, pack, BASE);
}

// ---------------------------------------------------------------- gates

describe("validateGate", () => {
  it("accepts every gate kind, including nested all/any", () => {
    for (const g of [
      { kind: "always" },
      { kind: "plate-solved", plate: "sun-plate" },
      { kind: "door-unlocked", door: "entry:north:4" },
      { kind: "lever-pulled", lever: "brass-lever" },
      {
        kind: "all",
        gates: [
          { kind: "plate-solved", plate: "a" },
          { kind: "any", gates: [{ kind: "lever-pulled", lever: "x" }, { kind: "always" }] },
        ],
      },
    ]) {
      const r = validateGate(g);
      expect(r.ok).toBe(true);
    }
  });

  it("rejects unknown kinds, empty names, empty lists, and unknown fields — naming the problem", () => {
    const bad: [unknown, RegExp][] = [
      [{ kind: "lever" }, /"kind" must be always\|plate-solved/],
      [{ kind: "plate-solved", plate: "" }, /"plate" must be a non-empty string/],
      [{ kind: "door-unlocked" }, /"door" must be a non-empty string/],
      [{ kind: "all", gates: [] }, /"gates" must be a non-empty array/],
      [{ kind: "any", gates: [{ kind: "nope" }] }, /"kind" must be always/],
      [{ kind: "always", extra: 1 }, /unknown field "extra"/],
      ["plate", /a gate must be an object/],
    ];
    for (const [g, re] of bad) {
      const r = validateGate(g);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.join(" ")).toMatch(re);
    }
  });
});

describe("evaluateGate + describeGate + gateFacts", () => {
  it("evaluates always/plate/door/lever/all/any against the facts", () => {
    const state: GateState = {
      platesSolved: ["sun-plate"],
      doorsUnlocked: ["entry:north:4"],
      leversPulled: [],
    };
    expect(evaluateGate({ kind: "always" }, state)).toBe(true);
    expect(evaluateGate({ kind: "plate-solved", plate: "sun-plate" }, state)).toBe(true);
    expect(evaluateGate({ kind: "plate-solved", plate: "moon-plate" }, state)).toBe(false);
    expect(evaluateGate({ kind: "door-unlocked", door: "entry:north:4" }, state)).toBe(true);
    expect(evaluateGate({ kind: "lever-pulled", lever: "brass-lever" }, state)).toBe(false);
    expect(
      evaluateGate(
        { kind: "all", gates: [{ kind: "plate-solved", plate: "sun-plate" }, { kind: "door-unlocked", door: "entry:north:4" }] },
        state,
      ),
    ).toBe(true);
    expect(
      evaluateGate(
        { kind: "all", gates: [{ kind: "plate-solved", plate: "sun-plate" }, { kind: "lever-pulled", lever: "brass-lever" }] },
        state,
      ),
    ).toBe(false);
    expect(
      evaluateGate(
        { kind: "any", gates: [{ kind: "plate-solved", plate: "moon-plate" }, { kind: "lever-pulled", lever: "brass-lever" }] },
        state,
      ),
    ).toBe(false);
    expect(
      evaluateGate(
        { kind: "any", gates: [{ kind: "plate-solved", plate: "moon-plate" }, { kind: "always" }] },
        state,
      ),
    ).toBe(true);
  });

  it("describes gates in plain words, and lists the facts they read", () => {
    expect(describeGate({ kind: "always" })).toMatch(/nothing/);
    expect(describeGate({ kind: "plate-solved", plate: "sun-plate" })).toBe(
      `the "sun-plate" pressure plate is solved`,
    );
    expect(describeGate({ kind: "door-unlocked", door: "entry:north:4" })).toBe(
      `the door "entry:north:4" is unlocked`,
    );
    expect(
      describeGate({
        kind: "all",
        gates: [
          { kind: "plate-solved", plate: "a" },
          { kind: "lever-pulled", lever: "b" },
        ],
      }),
    ).toBe(`the "a" pressure plate is solved and the "b" lever is pulled`);
    expect(
      gateFacts({
        kind: "all",
        gates: [
          { kind: "plate-solved", plate: "a" },
          { kind: "any", gates: [{ kind: "lever-pulled", lever: "b" }, { kind: "always" }] },
        ],
      }),
    ).toEqual(["plate:a", "lever:b"]);
  });
});

// ---------------------------------------------------------------- layout: stairs

describe("layoutDungeon with stairs", () => {
  it("resolves a gated stair up: direction, arrival cells, floors", () => {
    const d = layout();
    expect(d.stairs).toHaveLength(1);
    const s = d.stairs[0];
    expect(s.direction).toBe("up");
    expect(s.from).toEqual({ room: "entry", wall: "north", at: 4, enterGx: 4, enterGy: 1, floor: 0 });
    expect(s.to).toEqual({ room: "upper", wall: "south", at: 2, enterGx: 2, enterGy: 4, floor: 1 });
    expect(s.gate).toEqual({ kind: "plate-solved", plate: "sun-plate" });
  });

  it("derives 'down' when the stair runs from the upper room", () => {
    const d = layoutDungeon(
      {
        rooms: [entryHall, upperHall],
        links: [],
        stairs: [{ from: { room: "upper", wall: "south", at: 2 }, to: { room: "entry", wall: "north", at: 4 } }],
      },
      pack,
      BASE,
    );
    expect(d.stairs[0].direction).toBe("down");
    expect(d.stairs[0].gate).toBeUndefined();
  });

  it("counts stairs as graph edges: a room reachable only by stair lays out", () => {
    expect(() => layout()).not.toThrow();
  });

  it("rejects a stair end that is not a declared door or opening", () => {
    expect(() =>
      layoutDungeon(
        {
          rooms: [entryHall, upperHall],
          links: [],
          stairs: [{ from: { room: "entry", wall: "north", at: 1 }, to: { room: "upper", wall: "south", at: 2 } }],
        },
        pack,
        BASE,
      ),
    ).toThrow(/not a declared door or opening/);
  });

  it("rejects a stair whose ends are on the same floor", () => {
    expect(() =>
      layoutDungeon(
        {
          rooms: [entryHall, { ...upperHall, floor: 0 }],
          links: [],
          stairs: [gatedStair],
        },
        pack,
        BASE,
      ),
    ).toThrow(/stays on floor 0/);
  });

  it("rejects a door used in both a link and a stair, and a duplicate stair", () => {
    const withLink: DungeonSpec = {
      rooms: [entryHall, upperHall],
      links: [{ from: { room: "entry", wall: "north", at: 4 }, to: { room: "upper", wall: "south", at: 2 } }],
      stairs: [gatedStair],
    };
    expect(() => layoutDungeon(withLink, pack, BASE)).toThrow(/used in two links/);
    const dup: DungeonSpec = {
      rooms: [entryHall, upperHall],
      links: [],
      stairs: [
        gatedStair,
        { from: { room: "upper", wall: "south", at: 2 }, to: { room: "entry", wall: "north", at: 4 } },
      ],
    };
    expect(() => layoutDungeon(dup, pack, BASE)).toThrow(/Duplicate stair/);
  });

  it("rejects unknown stair rooms, self-stairs, and bad floor numbers", () => {
    expect(() =>
      layoutDungeon(
        { rooms: [entryHall, upperHall], links: [], stairs: [{ from: { room: "nope", wall: "north", at: 4 }, to: { room: "upper", wall: "south", at: 2 } }] },
        pack,
        BASE,
      ),
    ).toThrow(/unknown room "nope"/);
    expect(() =>
      layoutDungeon(
        { rooms: [entryHall, upperHall], links: [], stairs: [{ from: { room: "entry", wall: "north", at: 4 }, to: { room: "entry", wall: "north", at: 4 } }] },
        pack,
        BASE,
      ),
    ).toThrow(/to itself/);
    expect(() =>
      layoutDungeon({ rooms: [{ ...entryHall, floor: -1 }, upperHall], links: [], stairs: [gatedStair] }, pack, BASE),
    ).toThrow(/"floor" must be a non-negative integer/);
    expect(() =>
      layoutDungeon({ rooms: [{ ...entryHall, floor: 1.5 }, upperHall], links: [], stairs: [gatedStair] }, pack, BASE),
    ).toThrow(/"floor" must be a non-negative integer/);
  });

  it("a dungeon with no stairs lays out with an empty stairs list", () => {
    const d = layoutDungeon({ rooms: [entryHall], links: [] }, pack, BASE);
    expect(d.stairs).toEqual([]);
  });

  it("stairDirection derives up/down from floor numbers", () => {
    expect(stairDirection(0, 1)).toBe("up");
    expect(stairDirection(1, 0)).toBe("down");
    expect(stairDirection(2, 3)).toBe("up");
  });

  it("doorEntryCell still resolves the arrival cell for stair ends", () => {
    expect(doorEntryCell("north", 4, 8, 6)).toEqual({ gx: 4, gy: 1 });
    expect(doorEntryCell("south", 2, 8, 6)).toEqual({ gx: 2, gy: 4 });
  });
});

// ---------------------------------------------------------------- visibility

describe("floor visibility", () => {
  it("floor 0 is always revealed; revealFloor is immutable and sorted", () => {
    const v = emptyFloorVisibility();
    expect(isFloorRevealed(v, 0)).toBe(true);
    expect(isFloorRevealed(v, 1)).toBe(false);
    const v2 = revealFloor(v, 2);
    expect(v.revealed).toEqual([0]);
    expect(v2.revealed).toEqual([0, 2]);
    expect(revealFloor(v2, 1).revealed).toEqual([0, 1, 2]);
    expect(revealFloor(v2, 2)).toEqual(v2);
  });

  it("floorsOf / hiddenFloors / visibleRooms follow the dungeon + visibility", () => {
    expect(floorsOf(twoFloor)).toEqual([0, 1]);
    expect(hiddenFloors(twoFloor, emptyFloorVisibility())).toEqual([1]);
    expect(hiddenFloors(twoFloor, revealFloor(emptyFloorVisibility(), 1))).toEqual([]);
    expect(visibleRooms(twoFloor, emptyFloorVisibility()).map((r) => r.id)).toEqual(["entry"]);
    expect(visibleRooms(twoFloor, revealFloor(emptyFloorVisibility(), 1)).map((r) => r.id)).toEqual([
      "entry",
      "upper",
    ]);
  });
});

// ---------------------------------------------------------------- reveal planning + stair walks

describe("planStairReveal + resolveStairWalk", () => {
  const stair: ResolvedStairLink = layout().stairs[0];

  it("reveals when the gate is satisfied, blocks with the gate named when it is not", () => {
    const solved: GateState = { platesSolved: ["sun-plate"], doorsUnlocked: [], leversPulled: [] };
    expect(planStairReveal(stair, solved, emptyFloorVisibility())).toEqual({
      action: "reveal",
      floor: 1,
      stair,
    });
    const blocked = planStairReveal(stair, EMPTY, emptyFloorVisibility());
    expect(blocked.action).toBe("blocked");
    if (blocked.action === "blocked") {
      expect(blocked.reason).toMatch(/sealed until the "sun-plate" pressure plate is solved/);
    }
    const done = planStairReveal(stair, solved, revealFloor(emptyFloorVisibility(), 1));
    expect(done).toEqual({ action: "already-revealed", floor: 1, stair });
  });

  it("an ungated stair reveals immediately", () => {
    const open: ResolvedStairLink = { ...stair, gate: undefined };
    expect(planStairReveal(open, EMPTY, emptyFloorVisibility()).action).toBe("reveal");
  });

  it("a stair walk resolves once revealed, and is blocked while hidden", () => {
    const d = layout();
    const hidden = resolveStairWalk(d, "entry", "north", 4, emptyFloorVisibility());
    expect(hidden.ok).toBe(false);
    if (!hidden.ok) expect(hidden.reason).toMatch(/sealed until the "sun-plate" pressure plate is solved/);
    const revealed = resolveStairWalk(d, "entry", "north", 4, revealFloor(emptyFloorVisibility(), 1));
    expect(revealed.ok).toBe(true);
    if (revealed.ok) {
      expect(revealed.destination).toEqual({ room: "upper", wall: "south", at: 2, enterGx: 2, enterGy: 4, floor: 1 });
    }
    // Walking down from the upper room resolves too.
    const down = resolveStairWalk(d, "upper", "south", 2, revealFloor(emptyFloorVisibility(), 1));
    expect(down.ok).toBe(true);
    if (down.ok) expect(down.destination.room).toBe("entry");
  });

  it("a walk with no staircase errors plainly", () => {
    const d = layout();
    const r = resolveStairWalk(d, "entry", "south", 3, emptyFloorVisibility());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/No staircase at entry:south:3/);
  });
});

// ---------------------------------------------------------------- staircase zone

describe("staircaseZone", () => {
  it("covers the door cell + the cell just inside, on every wall", () => {
    const cases: [DungeonRoomSpec, "north" | "south" | "east" | "west", number, { x: number; y: number; w: number; h: number }][] = [
      [entryHall, "north", 4, { x: 400, y: 0, w: 100, h: 200 }],
      [entryHall, "south", 2, { x: 200, y: 400, w: 100, h: 200 }],
      [entryHall, "west", 3, { x: 0, y: 300, w: 200, h: 100 }],
      [entryHall, "east", 3, { x: 600, y: 300, w: 200, h: 100 }],
    ];
    for (const [room, wall, at, shape] of cases) {
      const z = staircaseZone(room, { room: room.id, wall, at });
      expect(z.shape).toEqual({ kind: "rect", ...shape });
      expect(z.actions).toEqual([
        { type: "reveal-floor", stair: { room: room.id, wall, at } },
      ]);
      // NOT fireOnce: a gate-blocked reveal must be retryable.
      expect(z.fireOnce).toBe(false);
    }
  });

  it("carries the gate through, and names the zone after the room", () => {
    const z = staircaseZone(entryHall, { room: "entry", wall: "north", at: 4 }, { gate: gatedStair.gate });
    expect(z.name).toBe("Staircase — Entry Hall");
    expect(z.actions[0]).toEqual({
      type: "reveal-floor",
      stair: { room: "entry", wall: "north", at: 4 },
      gate: { kind: "plate-solved", plate: "sun-plate" },
    });
  });
});

// ---------------------------------------------------------------- zone-set validation + planning

describe("resolveZoneSet with reveal-floor", () => {
  const loadFile = (_p: string): string => {
    throw new Error("no files in this test");
  };
  const zonesDoc = {
    sceneId: "scene-entry",
    zones: [
      {
        name: "Staircase",
        shape: { kind: "rect", x: 400, y: 0, w: 100, h: 200 },
        actions: [
          {
            type: "reveal-floor",
            stair: { room: "entry", wall: "north", at: 4 },
            gate: { kind: "plate-solved", plate: "sun-plate" },
          },
        ],
      },
    ],
  };

  it("parses a reveal-floor action, and plans it for --plan", () => {
    const r = resolveZoneSet(zonesDoc, loadFile);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.zoneSet.zones[0].actions).toEqual([
      {
        type: "reveal-floor",
        stair: { room: "entry", wall: "north", at: 4 },
        gate: { kind: "plate-solved", plate: "sun-plate" },
      },
    ]);
    const plan = planFloorReveals(r.zoneSet);
    expect(plan).toEqual({
      sceneId: "scene-entry",
      reveals: [
        {
          zone: "Staircase",
          stair: { room: "entry", wall: "north", at: 4 },
          gateDescription: `the "sun-plate" pressure plate is solved`,
          mode: "per-token",
        },
      ],
    });
  });

  it("rejects a bad gate, a bad stair, and unknown action fields — naming each", () => {
    const badGate = structuredClone(zonesDoc);
    (badGate.zones[0].actions[0] as Record<string, unknown>).gate = { kind: "lever" };
    const r1 = resolveZoneSet(badGate, loadFile);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.errors.join(" ")).toMatch(/gate:.*"kind" must be always/);

    const badWall = structuredClone(zonesDoc);
    (badWall.zones[0].actions[0] as Record<string, unknown>).stair = { room: "entry", wall: "up", at: 4 };
    const r2 = resolveZoneSet(badWall, loadFile);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.errors.join(" ")).toMatch(/"stair.wall" must be north\|south\|east\|west/);

    const badAt = structuredClone(zonesDoc);
    (badAt.zones[0].actions[0] as Record<string, unknown>).stair = { room: "entry", wall: "north", at: -1 };
    const r3 = resolveZoneSet(badAt, loadFile);
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.errors.join(" ")).toMatch(/"stair.at" must be a non-negative integer/);

    const badField = structuredClone(zonesDoc);
    (badField.zones[0].actions[0] as Record<string, unknown>).floor = 1;
    const r4 = resolveZoneSet(badField, loadFile);
    expect(r4.ok).toBe(false);
    if (!r4.ok) expect(r4.errors.join(" ")).toMatch(/unknown field "floor"/);
  });
});

// ---------------------------------------------------------------- file parsers

describe("parseBuiltDungeon + parseGateState", () => {
  const dungeonJson = {
    rooms: [
      { id: "entry", sceneId: "scene-entry", floor: 0 },
      { id: "upper", sceneId: "scene-upper", floor: 1 },
    ],
    stairs: [
      {
        from: { room: "entry", wall: "north", at: 4, enterGx: 4, enterGy: 1 },
        to: { room: "upper", wall: "south", at: 2, enterGx: 2, enterGy: 4 },
        gate: { kind: "plate-solved", plate: "sun-plate" },
      },
    ],
  };

  it("parses a dungeon file, deriving direction from the room floors", () => {
    const r = parseBuiltDungeon(dungeonJson);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dungeon.rooms).toEqual([
      { id: "entry", sceneId: "scene-entry", floor: 0 },
      { id: "upper", sceneId: "scene-upper", floor: 1 },
    ]);
    expect(r.dungeon.stairs[0].direction).toBe("up");
    expect(r.dungeon.stairs[0].from.floor).toBe(0);
    expect(r.dungeon.stairs[0].to.floor).toBe(1);
  });

  it("rejects bad dungeon files — naming each problem", () => {
    const cases: [unknown, RegExp][] = [
      [{ rooms: [] }, /"rooms" must be a non-empty array/],
      [{ rooms: [{ id: "a", sceneId: "s1" }, { id: "a", sceneId: "s2" }] }, /duplicate room id "a"/],
      [
        { rooms: [{ id: "a", sceneId: "s1" }], stairs: [{ from: { room: "a", wall: "north", at: 1, enterGx: 1, enterGy: 1 }, to: { room: "ghost", wall: "south", at: 1, enterGx: 1, enterGy: 1 } }] },
        /unknown room "ghost"/,
      ],
      [
        { rooms: [{ id: "a", sceneId: "s1", floor: 0 }, { id: "b", sceneId: "s2", floor: 0 }], stairs: [{ from: { room: "a", wall: "north", at: 1, enterGx: 1, enterGy: 1 }, to: { room: "b", wall: "south", at: 1, enterGx: 1, enterGy: 1 } }] },
        /stays on floor 0/,
      ],
      [
        { rooms: [{ id: "a", sceneId: "s1" }], stairs: [{ from: { room: "a", wall: "north", at: 1, enterGx: 1, enterGy: 1 }, to: { room: "a", wall: "south", at: 1, enterGx: 1, enterGy: 1 } }] },
        /must lead to another room/,
      ],
    ];
    for (const [doc, re] of cases) {
      const r = parseBuiltDungeon(doc);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.join(" ")).toMatch(re);
    }
  });

  it("parses gate state, rejecting unknown fields and non-string facts", () => {
    expect(parseGateState({ platesSolved: ["sun-plate"], leversPulled: [] })).toEqual({
      ok: true,
      state: { platesSolved: ["sun-plate"], doorsUnlocked: [], leversPulled: [] },
    });
    const r = parseGateState({ platesSolved: ["a", 3] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/"platesSolved" must be an array of non-empty strings/);
    const r2 = parseGateState({ unknownThing: [] });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.errors.join(" ")).toMatch(/Unknown field "unknownThing"/);
  });
});

// ---------------------------------------------------------------- live: fake world

interface FakeToken {
  _id: string;
  name: string;
  actorId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FakeScene {
  _id: string;
  name: string;
  navigation: boolean;
  active: boolean;
  tokens: FakeToken[];
}

/** Minimal in-memory Foundry stand-in: scenes (navigation/active),
 *  tokens, chat, and the modifyDocument calls the floor layer uses. */
class FakeLive {
  scenes: FakeScene[];
  chats: string[] = [];
  calls: string[] = [];
  private counter = 0;

  constructor(scenes: FakeScene[]) {
    this.scenes = scenes;
  }

  getUsers() {
    return [{ _id: "gm-1", name: "Gamemaster", role: 4, active: true }];
  }

  raw() {
    return {
      getScenes: () => this.scenes,
      getWorldData: () => ({ scenes: this.scenes }),
      getRawActor: (id: string) =>
        id === "actor-valeros"
          ? { name: "Valeros", type: "character", img: "icons/valeros.svg" }
          : undefined,
    };
  }

  getChatMessages(limit = 20): string[] {
    return this.chats.slice(-limit);
  }

  async sendChat(content: string): Promise<string> {
    this.chats.push(content);
    return `msg-${++this.counter}`;
  }

  async modifyDocument(
    type: string,
    action: string,
    opts: { data?: Record<string, unknown>[]; updates?: Record<string, unknown>[]; ids?: string[]; parentUuid?: string },
  ): Promise<Record<string, unknown>[]> {
    this.calls.push(`${type}:${action}`);
    if (type === "Scene" && action === "update") {
      for (const u of opts.updates ?? []) {
        const scene = this.scenes.find((s) => s._id === u._id);
        if (!scene) throw new Error(`FakeLive: no scene ${String(u._id)}`);
        if (u.navigation !== undefined) scene.navigation = Boolean(u.navigation);
        if (u.active !== undefined) {
          for (const s of this.scenes) s.active = false;
          scene.active = Boolean(u.active);
        }
      }
      return opts.updates ?? [];
    }
    if (type === "Token" && action === "create") {
      const parent = String(opts.parentUuid ?? "").replace(/^Scene\./, "");
      const scene = this.scenes.find((s) => s._id === parent);
      if (!scene) throw new Error(`FakeLive: no scene ${parent}`);
      return (opts.data ?? []).map((d) => {
        const token: FakeToken = {
          _id: `token-${++this.counter}`,
          name: String(d.name ?? "Token"),
          actorId: String(d.actorId ?? ""),
          x: Number(d.x ?? 0),
          y: Number(d.y ?? 0),
          width: 1,
          height: 1,
        };
        scene.tokens.push(token);
        return { _id: token._id };
      });
    }
    if (type === "Token" && action === "delete") {
      const parent = String(opts.parentUuid ?? "").replace(/^Scene\./, "");
      const scene = this.scenes.find((s) => s._id === parent);
      if (!scene) throw new Error(`FakeLive: no scene ${parent}`);
      for (const id of opts.ids ?? []) {
        scene.tokens = scene.tokens.filter((t) => t._id !== id);
      }
      return [];
    }
    throw new Error(`FakeLive: unsupported ${type}:${action}`);
  }
}

function twoFloorWorld(): { live: FakeLive; dungeon: FloorDungeonFile } {
  const dungeon: FloorDungeonFile = {
    rooms: [
      { id: "entry", sceneId: "scene-entry", floor: 0 },
      { id: "upper", sceneId: "scene-upper", floor: 1 },
    ],
    stairs: [
      {
        from: { room: "entry", wall: "north", at: 4, enterGx: 4, enterGy: 1, floor: 0 },
        to: { room: "upper", wall: "south", at: 2, enterGx: 2, enterGy: 4, floor: 1 },
        direction: "up",
        gate: { kind: "plate-solved", plate: "sun-plate" },
      },
    ],
  };
  const live = new FakeLive([
    {
      _id: "scene-entry",
      name: "Entry Hall",
      navigation: true,
      active: true,
      tokens: [{ _id: "token-1", name: "Valeros", actorId: "actor-valeros", x: 450, y: 50, width: 1, height: 1 }],
    },
    { _id: "scene-upper", name: "Upper Hall", navigation: false, active: false, tokens: [] },
  ]);
  return { live, dungeon };
}

describe("climbStair + revealFloorLive (fake live)", () => {
  it("climbs a token through the stair to the arrival cell", async () => {
    const { live, dungeon } = twoFloorWorld();
    const stair = dungeon.stairs[0];
    const out = await climbStair(live as unknown as FoundryLive, dungeon, stair, stair.from, ["token-1"]);
    expect(out.toSceneId).toBe("scene-upper");
    expect(out.tokens).toEqual([{ oldId: "token-1", newId: expect.any(String), name: "Valeros" }]);
    expect(live.scenes[0].tokens).toEqual([]);
    expect(live.scenes[1].tokens).toHaveLength(1);
    expect(live.scenes[1].tokens[0].x).toBe(250);
    expect(live.scenes[1].tokens[0].y).toBe(450);
    expect(live.scenes[1].tokens[0].actorId).toBe("actor-valeros");
  });

  it("climbing from an end that is not a stair throws plainly", async () => {
    const { live, dungeon } = twoFloorWorld();
    await expect(
      climbStair(live as unknown as FoundryLive, dungeon, dungeon.stairs[0], { room: "entry", wall: "south", at: 3 }, ["token-1"]),
    ).rejects.toThrow(/No staircase at entry:south:3/);
  });

  it("revealFloorLive flips navigation, activates the upper scene, and moves the token", async () => {
    const { live, dungeon } = twoFloorWorld();
    const out = await revealFloorLive(live as unknown as FoundryLive, dungeon, dungeon.stairs[0], ["token-1"]);
    expect(out.toSceneId).toBe("scene-upper");
    expect(live.scenes[1].navigation).toBe(true);
    expect(live.scenes[1].active).toBe(true);
    expect(live.scenes[0].active).toBe(false);
    expect(live.scenes[1].tokens).toHaveLength(1);
    expect(live.calls).toContain("Scene:update");
  });
});

describe("FloorSession (fake live)", () => {
  it("blocks the reveal while the gate is unsolved, then reveals once it is", async () => {
    const { live, dungeon } = twoFloorWorld();
    const session = new FloorSession(dungeon);
    const player = session.revealPlayer();
    const action = {
      type: "reveal-floor" as const,
      stair: { room: "entry", wall: "north" as const, at: 4 },
    };
    const token = { _id: "token-1", name: "Valeros" };
    const blocked = await player(live as unknown as FoundryLive, action, token);
    expect(blocked).toEqual({
      revealed: false,
      reason: `The way up is sealed until the "sun-plate" pressure plate is solved.`,
    });
    expect(live.chats.join(" ")).toMatch(/sealed until the "sun-plate" pressure plate is solved/);
    expect(live.scenes[1].navigation).toBe(false);
    expect(live.scenes[1].tokens).toEqual([]);

    session.markPlateSolved("sun-plate");
    const revealed = await player(live as unknown as FoundryLive, action, token);
    expect(revealed).toEqual({ revealed: true });
    expect(live.scenes[1].navigation).toBe(true);
    expect(live.scenes[1].active).toBe(true);
    expect(live.scenes[1].tokens).toHaveLength(1);
    expect(live.scenes[0].tokens).toEqual([]);
    expect(session.state.visibility.revealed).toEqual([0, 1]);
    expect(live.chats.join(" ")).toMatch(/floor 1 is revealed/);

    // A re-fire after the reveal is silent: no second reveal, no chat spam.
    const chatCount = live.chats.length;
    const again = await player(live as unknown as FoundryLive, action, { _id: "token-2", name: "Valeros" });
    expect(again).toEqual({ revealed: true });
    expect(live.chats.length).toBe(chatCount);
  });

  it("a zone naming a stair the dungeon does not have posts and reports it", async () => {
    const { live, dungeon } = twoFloorWorld();
    const session = new FloorSession(dungeon);
    const out = await session.revealPlayer()(live as unknown as FoundryLive, {
      type: "reveal-floor",
      stair: { room: "entry", wall: "south", at: 3 },
    }, { _id: "token-1", name: "Valeros" });
    expect(out.revealed).toBe(false);
    expect(out.reason).toMatch(/No staircase at entry:south:3/);
    expect(live.chats.join(" ")).toMatch(/not wired/);
  });

  it("marking facts is idempotent, and the gate state starts empty", () => {
    const { dungeon } = twoFloorWorld();
    const session = new FloorSession(dungeon);
    expect(session.state.gateState).toEqual({ platesSolved: [], doorsUnlocked: [], leversPulled: [] });
    session.markPlateSolved("sun-plate");
    session.markPlateSolved("sun-plate");
    session.markDoorUnlocked("entry:north:4");
    session.markLeverPulled("brass-lever");
    expect(session.state.gateState).toEqual({
      platesSolved: ["sun-plate"],
      doorsUnlocked: ["entry:north:4"],
      leversPulled: ["brass-lever"],
    });
  });

  it("two sessions do not share gate facts (no shared mutable state)", () => {
    const { dungeon } = twoFloorWorld();
    const a = new FloorSession(dungeon);
    const b = new FloorSession(dungeon);
    a.markPlateSolved("sun-plate");
    expect(a.state.gateState.platesSolved).toEqual(["sun-plate"]);
    expect(b.state.gateState.platesSolved).toEqual([]);
  });
});

describe("TrapWatcher reveal-floor action (fake live)", () => {
  it("fires the injected player once on entry, and re-arms on leave so a solved gate retries", async () => {
    const { live, dungeon } = twoFloorWorld();
    const session = new FloorSession(dungeon);
    const calls: { stair: unknown; token: string }[] = [];
    const player = async (
      l: FoundryLive,
      action: { type: "reveal-floor"; stair: { room: string; wall: "north" | "south" | "east" | "west"; at: number } },
      token: { _id: string; name: string },
    ) => {
      calls.push({ stair: action.stair, token: token._id });
      return session.revealPlayer()(l, action, token);
    };
    const zone = staircaseZone(entryHall, { room: "entry", wall: "north", at: 4 }, { gate: gatedStair.gate });
    const watcher = new TrapWatcher(live as unknown as FoundryLive, { sceneId: "scene-entry", zones: [zone] }, 100, {
      floorRevealPlayer: player,
    });
    // Token starts on the door cell: first poll fires (blocked — gate unsolved).
    const first = await watcher.checkOnce();
    expect(first).toHaveLength(1);
    expect(first[0].zone).toBe("Staircase — Entry Hall");
    expect(calls).toHaveLength(1);
    expect(live.scenes[1].navigation).toBe(false);
    // Still inside: no second fire.
    expect(await watcher.checkOnce()).toHaveLength(0);
    expect(calls).toHaveLength(1);
    // Leave, solve the gate, come back: fires again, and this time reveals.
    live.scenes[0].tokens[0].x = 100;
    live.scenes[0].tokens[0].y = 500;
    expect(await watcher.checkOnce()).toHaveLength(0);
    session.markPlateSolved("sun-plate");
    live.scenes[0].tokens[0].x = 450;
    live.scenes[0].tokens[0].y = 50;
    const second = await watcher.checkOnce();
    expect(second).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(live.scenes[1].navigation).toBe(true);
    expect(live.scenes[1].tokens).toHaveLength(1);
  });

  it("with no player injected, the zone posts 'not wired' and does nothing", async () => {
    const { live } = twoFloorWorld();
    const zone = staircaseZone(entryHall, { room: "entry", wall: "north", at: 4 });
    const watcher = new TrapWatcher(live as unknown as FoundryLive, { sceneId: "scene-entry", zones: [zone] }, 100);
    const fires = await watcher.checkOnce();
    expect(fires).toHaveLength(1);
    expect(live.chats.join(" ")).toMatch(/isn't wired to a dungeon yet/);
    expect(live.scenes[1].navigation).toBe(false);
  });
});
