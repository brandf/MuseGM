/**
 * Unit tests for the chat-driven building loop (FR-1) + undo (FR-8).
 * Pure — no Foundry connection needed. Run with `bun test`.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BuildSession,
  applyOp,
  canonical,
  describeDungeon,
  diffSummary,
  formatBuildLine,
  isBuildSessionSnapshot,
  loadBuildState,
  parseBuildRequest,
  parseBuildRequests,
  planSync,
  resolveHere,
  resolveHereRegion,
  saveBuildState,
  type BuildOp,
  type BuildParseContext,
  type BuildParseResult,
  type BuildState,
  type CompoundParseResult,
} from "../src/session/build-loop.js";
import { classifyMessage, runMonitor } from "../src/session/monitor.js";
import type { FoundryLive } from "../src/live.js";
import {
  layoutRoom,
  packFromManifest,
  type DungeonSpec,
  type Pack,
  type RoomSpec,
} from "../src/worldbuilding/tiles-layout.js";
import type { ChatMessage } from "../src/types.js";

/** A fake pack with all 19 real tile names (sizes match the manifest). */
function fakePack(): Pack {
  const defs: [string, number][] = [
    ["floor-plain", 100], ["floor-cracked", 100], ["floor-rubble", 100], ["floor-dark", 100],
    ["wall-straight", 100], ["wall-corner", 100], ["wall-door", 100],
    ["fog-wisp-small", 200], ["fog-wisp-large", 400], ["fog-pool", 400],
    ["rubble", 200], ["bones", 200], ["pillar", 200], ["sconce", 200],
    ["ritual-circle", 200], ["spear", 200], ["skeleton", 200], ["chest", 200], ["altar", 200],
  ];
  const tiles = defs.map(([name, sizePx]) => ({ name, file: `pack/${name}.png`, sizePx, layer: "floor" as const, tags: [] as string[] }));
  return packFromManifest({ version: 1, tilePx: 100, tiles, gaps: [] });
}

const PACK = fakePack();
const SERVER_BASE = "worlds/testbed";

function room(overrides: Partial<RoomSpec> = {}): RoomSpec {
  return {
    name: "Entry Hall",
    gridW: 8,
    gridH: 6,
    seed: 1,
    doors: [{ wall: "south", at: 3 }],
    ...overrides,
  };
}

function stateWithRoom(r?: RoomSpec): BuildState {
  const rm = r ?? room();
  return {
    dungeon: { rooms: [{ ...rm, id: "entry-hall" }], links: [] },
    activeRoom: "entry-hall",
  };
}

function buildOf(result: BuildParseResult | null): { kind: "build"; op: BuildOp } {
  if (!result || result.kind !== "build") throw new Error(`expected a build parse, got ${JSON.stringify(result)}`);
  return result;
}

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return { id: "m1", author: "author-1", content: "hello", style: 1, timestamp: 0, ...partial };
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object") {
    for (const child of Object.values(v)) deepFreeze(child);
    Object.freeze(v);
  }
  return v;
}

// ---------------------------------------------------------------- parser: rooms

describe("parseBuildRequest — create room", () => {
  it("build an 8x6 room", () => {
    const r = buildOf(parseBuildRequest("build an 8x6 room"));
    expect(r.op).toEqual({
      type: "create-room", name: "Room", gridW: 8, gridH: 6,
      doors: [], chest: false, torches: false, fog: false,
    });
  });

  it("build a room with a south door and a chest", () => {
    const r = buildOf(parseBuildRequest("build a 8x6 room with a south door and a chest"));
    expect(r.op).toMatchObject({
      type: "create-room", gridW: 8, gridH: 6, chest: true,
      doors: [{ wall: "south" }],
    });
  });

  it("start with a small entry room", () => {
    const r = buildOf(parseBuildRequest("start with a small entry room"));
    expect(r.op).toMatchObject({ type: "create-room", name: "Entry Hall", gridW: 6, gridH: 5 });
  });

  it("build a crypt names it Crypt", () => {
    const r = buildOf(parseBuildRequest("build a crypt"));
    expect(r.op).toMatchObject({ type: "create-room", name: "Crypt" });
  });

  it("build a room called the Sunken Chapel", () => {
    const r = buildOf(parseBuildRequest('build a room called the Sunken Chapel'));
    expect(r.op).toMatchObject({ type: "create-room", name: "Sunken Chapel" });
  });

  it("build a wider room is a create, not a widen", () => {
    const r = buildOf(parseBuildRequest("build a wider room"));
    expect(r.op).toMatchObject({ type: "create-room", name: "Room" });
  });

  it("a whole dungeon is unsupported, not a hallucinated build", () => {
    const r = parseBuildRequest("build a 3-room dungeon");
    expect(r?.kind).toBe("unsupported");
  });

  it("non-build lines return null", () => {
    expect(parseBuildRequest("roll 1d20")).toBeNull();
    expect(parseBuildRequest("whose turn is it")).toBeNull();
    expect(parseBuildRequest("hello everyone")).toBeNull();
    expect(parseBuildRequest("make a perception check")).toBeNull();
    expect(parseBuildRequest("what's Valeros's hp")).toBeNull();
  });
});

// ---------------------------------------------------------------- parser: widen / doors

describe("parseBuildRequest — widen and doors", () => {
  it("make this room 10 units wider", () => {
    const r = buildOf(parseBuildRequest("make this room 10 units wider"));
    expect(r.op).toEqual({ type: "widen", side: "east", by: 10 });
  });

  it("10 meters converts to squares (10 m = 7 squares)", () => {
    const r = buildOf(parseBuildRequest("make this room 10 meters wider"));
    expect(r.op).toEqual({ type: "widen", side: "east", by: 7 });
  });

  it("a bit wider is a small default widen", () => {
    const r = buildOf(parseBuildRequest("a bit wider"));
    expect(r.op).toEqual({ type: "widen", side: "east", by: 2 });
  });

  it("widen the room west by 5", () => {
    const r = buildOf(parseBuildRequest("widen the room west by 5"));
    expect(r.op).toEqual({ type: "widen", side: "west", by: 5 });
  });

  it("add a door here asks which wall", () => {
    const r = parseBuildRequest("add a door here");
    expect(r?.kind).toBe("clarify");
    expect((r as { question: string }).question).toContain("wall");
  });

  it("add a door on the north wall", () => {
    const r = buildOf(parseBuildRequest("add a door on the north wall"));
    expect(r.op).toEqual({ type: "add-door", wall: "north", at: -1 });
  });

  it("put a secret door in the north wall", () => {
    const r = buildOf(parseBuildRequest("put a secret door in the north wall"));
    expect(r.op).toEqual({ type: "add-door", wall: "north", at: -1, secret: true });
  });

  it("move that door left resolves the only door (south wall, left = east = at+1)", () => {
    const r = buildOf(parseBuildRequest("move that door left", { room: room() }));
    expect(r.op).toEqual({ type: "move-door", wall: "south", fromAt: 3, toAt: 4 });
  });

  it("move the north door right resolves against the wall (north wall, right = at+1)", () => {
    const r = buildOf(
      parseBuildRequest("move the north door right", { room: room({ doors: [{ wall: "north", at: 4 }] }) }),
    );
    expect(r.op).toEqual({ type: "move-door", wall: "north", fromAt: 4, toAt: 5 });
  });

  it("move the south door to cell 5", () => {
    const r = buildOf(parseBuildRequest("move the south door to cell 5", { room: room() }));
    expect(r.op).toEqual({ type: "move-door", wall: "south", fromAt: 3, toAt: 5 });
  });

  it("move that door with no doors asks", () => {
    const r = parseBuildRequest("move that door left", { room: room({ doors: [] }) });
    expect(r?.kind).toBe("clarify");
  });

  it("move that door with two doors asks which one", () => {
    const r = parseBuildRequest("move that door left", {
      room: room({ doors: [{ wall: "north", at: 2 }, { wall: "south", at: 3 }] }),
    });
    expect(r?.kind).toBe("clarify");
  });
});

// ---------------------------------------------------------------- parser: dressing / fog / overlay / corridor

describe("parseBuildRequest — dressing, fog, overlay, corridor", () => {
  it("add some bones defaults to the south-east corner", () => {
    const r = buildOf(parseBuildRequest("add some bones"));
    expect(r.op).toEqual({
      type: "add-dressing", tile: "bones", where: { kind: "corner", corner: "se" },
    });
  });

  it("add a chest in the northwest corner", () => {
    const r = buildOf(parseBuildRequest("add a chest in the northwest corner"));
    expect(r.op).toEqual({
      type: "add-dressing", tile: "chest", where: { kind: "corner", corner: "nw" },
    });
  });

  it("add a chest here asks where", () => {
    const r = parseBuildRequest("add a chest here");
    expect(r?.kind).toBe("clarify");
  });

  it("add torches", () => {
    expect(buildOf(parseBuildRequest("add torches")).op).toEqual({ type: "add-torches" });
  });

  it("add fog", () => {
    expect(buildOf(parseBuildRequest("add fog")).op).toEqual({ type: "add-fog" });
  });

  it("make the north half underwater", () => {
    const r = buildOf(parseBuildRequest("make the north half underwater"));
    expect(r.op).toEqual({
      type: "overlay",
      region: "north-half",
      variants: { "floor-plain": "floor-dark", "floor-cracked": "floor-dark", "floor-rubble": "floor-dark" },
    });
  });

  it("make this part underwater asks which part", () => {
    const r = parseBuildRequest("make this part underwater");
    expect(r?.kind).toBe("clarify");
  });

  it("add a corridor going north for 100 meters", () => {
    const r = buildOf(parseBuildRequest("add a corridor going north for 100 meters"));
    expect(r.op).toEqual({ type: "add-corridor", direction: "north", length: 100, unit: "m" });
  });

  it("add a corridor with no direction asks which way", () => {
    const r = parseBuildRequest("add a corridor");
    expect(r?.kind).toBe("clarify");
  });

  it("make it darker is unsupported, not a build", () => {
    const r = parseBuildRequest("make it darker");
    expect(r?.kind).toBe("unsupported");
  });

  it("undo / redo parse", () => {
    expect(buildOf(parseBuildRequest("undo that")).op).toEqual({ type: "undo" });
    expect(buildOf(parseBuildRequest("actually undo that room")).op).toEqual({ type: "undo" });
    expect(buildOf(parseBuildRequest("redo")).op).toEqual({ type: "redo" });
  });
});

// ---------------------------------------------------------------- move / remove props (BRA-241)

describe("parseBuildRequest + applyOp — move / remove props (BRA-241)", () => {
  /** The pack with real layers: moveProp validates the spec, and a
   *  dressing placement must name a dressing-layer tile. */
  function propPack(): Pack {
    const dressing = new Set([
      "rubble", "bones", "pillar", "sconce", "ritual-circle", "spear", "skeleton", "chest", "altar",
    ]);
    const atmosphere = new Set(["fog-wisp-small", "fog-wisp-large", "fog-pool"]);
    const defs: [string, number][] = [
      ["floor-plain", 100], ["floor-cracked", 100], ["floor-rubble", 100], ["floor-dark", 100],
      ["wall-straight", 100], ["wall-corner", 100], ["wall-door", 100],
      ["fog-wisp-small", 200], ["fog-wisp-large", 400], ["fog-pool", 400],
      ["rubble", 200], ["bones", 200], ["pillar", 200], ["sconce", 100],
      ["ritual-circle", 200], ["spear", 200], ["skeleton", 200], ["chest", 200], ["altar", 200],
    ];
    const tiles = defs.map(([name, sizePx]) => ({
      name,
      file: `pack/${name}.png`,
      sizePx,
      layer: (dressing.has(name)
        ? "dressing"
        : atmosphere.has(name)
          ? "atmosphere"
          : "floor") as "floor" | "dressing" | "atmosphere",
      tags: [] as string[],
    }));
    return packFromManifest({ version: 1, tilePx: 100, tiles, gaps: [] });
  }

  const PROP_PACK = propPack();

  /** 8x6 Entry Hall: chest in the SE corner, bones in the SW and NE
   *  corners — two of a kind, so every disambiguation rule is
   *  exercised. */
  const PROP_ROOM = room({
    dressing: [
      { tile: "chest", gx: 6, gy: 4 },
      { tile: "bones", gx: 0, gy: 4 },
      { tile: "bones", gx: 6, gy: 0 },
    ],
  });
  const PROP_CTX: BuildParseContext = {
    room: PROP_ROOM,
    rooms: [{ ...PROP_ROOM, id: "entry-hall" }],
  };

  it("move the chest to the middle", () => {
    const r = buildOf(parseBuildRequest("move the chest to the middle", PROP_CTX));
    expect(r.op).toEqual({
      type: "move-prop",
      tile: "chest",
      from: { gx: 6, gy: 4 },
      to: { kind: "center" },
    });
  });

  it("move the bones to the middle asks — the middle is equally far from both", () => {
    const r = parseBuildRequest("move the bones to the middle", PROP_CTX);
    expect(r?.kind).toBe("clarify");
    expect((r as { question: string }).question).toMatch(/equally close/);
  });

  it("move the bones in the southwest corner to the middle picks the SW bones", () => {
    const r = buildOf(
      parseBuildRequest("move the bones in the southwest corner to the middle", PROP_CTX),
    );
    expect(r.op).toEqual({
      type: "move-prop",
      tile: "bones",
      from: { gx: 0, gy: 4 },
      to: { kind: "center" },
    });
  });

  it("move the bones near the door to the middle moves the bones by the door", () => {
    const r = buildOf(
      parseBuildRequest("move the bones near the door to the middle", PROP_CTX),
    );
    expect(r.op).toEqual({
      type: "move-prop",
      tile: "bones",
      from: { gx: 0, gy: 4 },
      to: { kind: "center" },
    });
  });

  it("move the bones here picks the bones nearest the ping", () => {
    const ctx: BuildParseContext = {
      ...PROP_CTX,
      here: { roomId: "entry-hall", x: 650, y: 50 },
    };
    const r = buildOf(parseBuildRequest("move the bones here", ctx));
    expect(r.op).toEqual({
      type: "move-prop",
      tile: "bones",
      from: { gx: 6, gy: 0 },
      to: { kind: "cell", gx: 6, gy: 0 },
      target: "entry-hall", // "here" targets the pinged room, like add-door here
    });
  });

  it("move the chest left / north by 2", () => {
    expect(buildOf(parseBuildRequest("move the chest left", PROP_CTX)).op).toEqual({
      type: "move-prop",
      tile: "chest",
      from: { gx: 6, gy: 4 },
      to: { kind: "cell", gx: 5, gy: 4 },
    });
    expect(buildOf(parseBuildRequest("move the chest north by 2", PROP_CTX)).op).toEqual({
      type: "move-prop",
      tile: "chest",
      from: { gx: 6, gy: 4 },
      to: { kind: "cell", gx: 6, gy: 2 },
    });
  });

  it("move the chest to cell 2, 3", () => {
    expect(buildOf(parseBuildRequest("move the chest to cell 2, 3", PROP_CTX)).op).toEqual({
      type: "move-prop",
      tile: "chest",
      from: { gx: 6, gy: 4 },
      to: { kind: "cell", gx: 2, gy: 3 },
    });
  });

  it("move the chest near the door / to the south door", () => {
    expect(buildOf(parseBuildRequest("move the chest near the door", PROP_CTX)).op).toEqual({
      type: "move-prop",
      tile: "chest",
      from: { gx: 6, gy: 4 },
      to: { kind: "entry" },
    });
    // "to the south door" is the door, not a move south.
    expect(buildOf(parseBuildRequest("move the bones to the south door", PROP_CTX)).op).toEqual({
      type: "move-prop",
      tile: "bones",
      from: { gx: 0, gy: 4 },
      to: { kind: "entry" },
    });
  });

  it("move the chest with no destination asks where", () => {
    const r = parseBuildRequest("move the chest", PROP_CTX);
    expect(r?.kind).toBe("clarify");
    expect((r as { question: string }).question).toMatch(/Where should the chest go/);
  });

  it("move the altar says there is no altar, listing the room", () => {
    const r = parseBuildRequest("move the altar", PROP_CTX);
    expect(r?.kind).toBe("clarify");
    expect((r as { question: string }).question).toMatch(/There's no altar in this room/);
    expect((r as { question: string }).question).toMatch(/a chest at \(6, 4\)/);
  });

  it("move the chest to the south wall asks — a wall is not a direction", () => {
    const r = parseBuildRequest("move the chest to the south wall", PROP_CTX);
    expect(r?.kind).toBe("clarify");
  });

  it("move the torch refuses — light and sconce move together", () => {
    const r = parseBuildRequest("move the torch", PROP_CTX);
    expect(r?.kind).toBe("clarify");
    expect((r as { question: string }).question).toMatch(/leave its light behind/);
  });

  it("move the door still parses as a door move, not a prop move", () => {
    const r = buildOf(parseBuildRequest("move the south door to cell 5", PROP_CTX));
    expect(r.op).toEqual({
      type: "move-door",
      wall: "south",
      fromAt: 3,
      toAt: 5,
    });
  });

  it("remove the bones asks when two match; at a cell picks one", () => {
    const r = parseBuildRequest("remove the bones", PROP_CTX);
    expect(r?.kind).toBe("clarify");
    expect((r as { question: string }).question).toMatch(/2 piles of bones/);
    expect(buildOf(parseBuildRequest("remove the bones at 0, 4", PROP_CTX)).op).toEqual({
      type: "remove-prop",
      tile: "bones",
      from: { gx: 0, gy: 4 },
    });
  });

  it("remove the chest / take the bones away / clear the rubble", () => {
    expect(buildOf(parseBuildRequest("remove the chest", PROP_CTX)).op).toEqual({
      type: "remove-prop",
      tile: "chest",
      from: { gx: 6, gy: 4 },
    });
    expect(
      buildOf(parseBuildRequest("remove the bones at cell 6, 0", PROP_CTX)).op,
    ).toEqual({
      type: "remove-prop",
      tile: "bones",
      from: { gx: 6, gy: 0 },
    });
    const withRubble = room({
      dressing: [{ tile: "rubble", gx: 2, gy: 2 }],
    });
    const ctx: BuildParseContext = {
      room: withRubble,
      rooms: [{ ...withRubble, id: "entry-hall" }],
    };
    expect(buildOf(parseBuildRequest("clear the rubble", ctx)).op).toEqual({
      type: "remove-prop",
      tile: "rubble",
      from: { gx: 2, gy: 2 },
    });
    expect(buildOf(parseBuildRequest("take the rubble away", ctx)).op).toEqual({
      type: "remove-prop",
      tile: "rubble",
      from: { gx: 2, gy: 2 },
    });
  });

  it("remove the torch refuses, like move", () => {
    const r = parseBuildRequest("remove the torch", PROP_CTX);
    expect(r?.kind).toBe("clarify");
    expect((r as { question: string }).question).toMatch(/leave its light behind/);
  });

  it("move the chest to the middle and add fog compounds", () => {
    const r = parseBuildRequests("move the chest to the middle and add fog", PROP_CTX);
    expect(r?.kind).toBe("build");
    if (r?.kind !== "build") throw new Error("expected a compound build");
    expect(r.ops).toHaveLength(2);
    expect(r.ops[0].type).toBe("move-prop");
    expect(r.ops[1]).toEqual({ type: "add-fog" });
  });

  it("move-prop applies, and undo returns the chest to its corner", () => {
    const s = new BuildSession({
      rooms: [{ ...PROP_ROOM, id: "entry-hall" }],
      links: [],
    });
    const applied = s.apply(
      {
        type: "move-prop",
        tile: "chest",
        from: { gx: 6, gy: 4 },
        to: { kind: "center" },
      },
      "move the chest to the middle",
      { pack: PROP_PACK },
    );
    expect(applied.changed).toBe(true);
    expect(applied.summary).toBe(
      "Moved the chest from the southeast corner to the middle in the Entry Hall.",
    );
    const moved = s.current().dungeon.rooms[0].dressing ?? [];
    expect(moved.find((p) => p.tile === "chest")).toMatchObject({ gx: 3, gy: 2 });
    expect(formatBuildLine(applied.summary, {
      type: "move-prop",
      tile: "chest",
      from: { gx: 6, gy: 4 },
      to: { kind: "center" },
    })).toMatch(/^📦 /);
    s.undo();
    expect(s.current().dungeon.rooms[0].dressing ?? []).toContainEqual(
      expect.objectContaining({ tile: "chest", gx: 6, gy: 4 }),
    );
    s.redo();
    expect(s.current().dungeon.rooms[0].dressing ?? []).toContainEqual(
      expect.objectContaining({ tile: "chest", gx: 3, gy: 2 }),
    );
  });

  it("remove-prop applies, and undo restores the bones", () => {
    const s = new BuildSession({
      rooms: [{ ...PROP_ROOM, id: "entry-hall" }],
      links: [],
    });
    const applied = s.apply(
      { type: "remove-prop", tile: "bones", from: { gx: 0, gy: 4 } },
      "remove the bones at 0, 4",
      { pack: PROP_PACK },
    );
    expect(applied.changed).toBe(true);
    expect(applied.summary).toBe(
      "Removed the bones from the southwest corner in the Entry Hall.",
    );
    expect(s.current().dungeon.rooms[0].dressing ?? []).toHaveLength(2);
    s.undo();
    expect(s.current().dungeon.rooms[0].dressing ?? []).toHaveLength(3);
    s.redo();
    expect(s.current().dungeon.rooms[0].dressing ?? []).toHaveLength(2);
  });

  it("move-prop to the same cell is a no-op", () => {
    const { summary, changed } = applyOp(
      stateWithRoom(PROP_ROOM),
      { type: "move-prop", tile: "chest", from: { gx: 6, gy: 4 }, to: { kind: "corner", corner: "se" } },
      { pack: PROP_PACK },
    );
    expect(changed).toBe(false);
    expect(summary).toBe("The chest is already at the southeast corner.");
  });

  it("move-prop for a missing prop throws, naming the cell", () => {
    expect(() =>
      applyOp(
        stateWithRoom(PROP_ROOM),
        { type: "move-prop", tile: "bones", from: { gx: 1, gy: 1 }, to: { kind: "center" } },
        { pack: PROP_PACK },
      ),
    ).toThrow(/No "bones" at \(1,1\)/);
  });

  it("move-prop out of the room throws", () => {
    expect(() =>
      applyOp(
        stateWithRoom(PROP_ROOM),
        { type: "move-prop", tile: "chest", from: { gx: 6, gy: 4 }, to: { kind: "cell", gx: 7, gy: 5 } },
        { pack: PROP_PACK },
      ),
    ).toThrow();
  });

  it("move-prop without a pack throws plainly", () => {
    expect(() =>
      applyOp(
        stateWithRoom(PROP_ROOM),
        { type: "move-prop", tile: "chest", from: { gx: 6, gy: 4 }, to: { kind: "center" } },
      ),
    ).toThrow(/needs the tile pack/);
  });
});

// ---------------------------------------------------------------- session: apply / undo / redo

describe("BuildSession — history is a list of specs", () => {
  function buildSession(): BuildSession {
    const s = new BuildSession();
    s.apply(
      buildOf(parseBuildRequest("build an 8x6 entry hall with a south door")).op,
      "build an 8x6 entry hall with a south door",
      { pack: PACK },
    );
    return s;
  }

  it("create then widen then add-door, then undo walks back one step at a time", () => {
    const s = buildSession();
    s.apply(buildOf(parseBuildRequest("make this room 10 units wider")).op, "widen", { pack: PACK });
    s.apply(buildOf(parseBuildRequest("add a secret door in the north wall")).op, "secret door", { pack: PACK });
    expect(s.current().dungeon.rooms[0].gridW).toBe(18);
    expect(s.current().dungeon.rooms[0].doors).toHaveLength(2);
    const undone = s.undo();
    expect(undone?.summary).toContain("secret door");
    expect(s.current().dungeon.rooms[0].doors).toHaveLength(1);
    expect(s.current().dungeon.rooms[0].gridW).toBe(18);
    s.undo();
    expect(s.current().dungeon.rooms[0].gridW).toBe(8);
    const redone = s.redo();
    expect(redone?.summary).toContain("Widened");
    expect(s.current().dungeon.rooms[0].gridW).toBe(18);
  });

  it("undo at the start of history returns null", () => {
    const s = new BuildSession();
    expect(s.undo()).toBeNull();
    expect(s.redo()).toBeNull();
    expect(s.canUndo()).toBe(false);
    expect(s.canRedo()).toBe(false);
  });

  it("a new edit after an undo drops the redo tail", () => {
    const s = buildSession();
    s.apply(buildOf(parseBuildRequest("make this room 10 units wider")).op, "widen", { pack: PACK });
    s.undo();
    expect(s.canRedo()).toBe(true);
    s.apply(buildOf(parseBuildRequest("add fog")).op, "fog", { pack: PACK });
    expect(s.canRedo()).toBe(false);
    expect(s.redo()).toBeNull();
    expect(s.current().dungeon.rooms[0].gridW).toBe(8);
    expect(s.current().dungeon.rooms[0].fog).toHaveLength(1);
  });

  it("history entries carry the GM's exact words and the summary", () => {
    const s = buildSession();
    expect(s.history()[0].said).toBe("build an 8x6 entry hall with a south door");
    expect(s.history()[0].summary).toContain("Built the 8×6 Entry Hall");
  });

  it("applyOp never mutates its input (frozen state survives)", () => {
    const state = deepFreeze(stateWithRoom());
    const op = buildOf(parseBuildRequest("make this room 10 units wider")).op;
    const out = applyOp(state, op, { pack: PACK });
    expect(out.state.dungeon.rooms[0].gridW).toBe(18);
    expect(state.dungeon.rooms[0].gridW).toBe(8);
  });

  it("activeRoom follows the last room created, and undo restores it", () => {
    const s = new BuildSession();
    s.apply(buildOf(parseBuildRequest("build an 8x6 entry hall")).op, "hall", { pack: PACK });
    expect(s.current().activeRoom).toBe("entry-hall");
    s.apply(buildOf(parseBuildRequest("build a 6x6 crypt")).op, "crypt", { pack: PACK });
    expect(s.current().activeRoom).toBe("crypt");
    s.undo();
    expect(s.current().activeRoom).toBe("entry-hall");
  });

  it("a corridor keeps the focus on the source room", () => {
    const s = buildSession();
    s.apply(
      buildOf(parseBuildRequest("add a corridor going north for 100 meters")).op,
      "corridor",
      { pack: PACK },
    );
    expect(s.current().dungeon.rooms).toHaveLength(2);
    expect(s.current().activeRoom).toBe("entry-hall");
    expect(s.current().dungeon.links).toHaveLength(1);
  });

  it("widen with no room yet throws a plain-English error", () => {
    const s = new BuildSession();
    expect(() =>
      s.apply(buildOf(parseBuildRequest("make this room wider")).op, "widen", { pack: PACK }),
    ).toThrow("No room to widen yet");
  });

  it("a door in a corner throws; a door colliding with another throws", () => {
    const s = buildSession();
    expect(() =>
      s.apply(
        { type: "add-door", wall: "south", at: 0 },
        "corner door",
        { pack: PACK },
      ),
    ).toThrow("not in a corner");
    expect(() =>
      s.apply(
        { type: "add-door", wall: "south", at: 4 },
        "same door",
        { pack: PACK },
      ),
    ).toThrow("already a door");
  });

  it("a fog pool in a 3x3 room throws", () => {
    const s = new BuildSession();
    expect(() =>
      s.apply(
        buildOf(parseBuildRequest("build a 3x3 room with fog")).op,
        "tiny fog room",
        { pack: PACK },
      ),
    ).toThrow("too small for a fog pool");
  });

  it("adding torches twice is a no-op the second time (and records no history)", () => {
    const s = buildSession();
    const first = s.apply(buildOf(parseBuildRequest("add torches")).op, "torches", { pack: PACK });
    expect(first.changed).toBe(true);
    expect(first.summary).toContain("torches");
    const n = s.history().length;
    const second = s.apply(buildOf(parseBuildRequest("add torches")).op, "torches again", { pack: PACK });
    expect(second.changed).toBe(false);
    expect(s.history().length).toBe(n);
  });
});

// ---------------------------------------------------------------- secret doors in the composer

describe("secret doors (DoorSpec.secret)", () => {
  it("a secret door gets a door:2 collision wall and a wall-straight tile", () => {
    const spec = room({ doors: [{ wall: "north", at: 4, secret: true }] });
    const layout = layoutRoom(spec, PACK, SERVER_BASE);
    const secret = layout.walls.find((w) => w.y1 === 0 && w.y2 === 0 && w.x1 === 400 && w.x2 === 500);
    expect(secret?.door).toBe(2);
    const tile = layout.tiles.find((t) => t.x === 400 && t.y === 0 && t.sort === 10);
    expect(tile?.texture.src.endsWith("wall-straight.png")).toBe(true);
  });

  it("a plain door still gets door:1 and the door tile", () => {
    const layout = layoutRoom(room({ doors: [{ wall: "south", at: 3 }] }), PACK, SERVER_BASE);
    const door = layout.walls.find((w) => w.y1 === 600 && w.y2 === 600 && w.x1 === 300 && w.x2 === 400);
    expect(door?.door).toBe(1);
    const tile = layout.tiles.find((t) => t.x === 300 && t.y === 500 && t.sort === 10);
    expect(tile?.texture.src.endsWith("wall-door.png")).toBe(true);
  });

  it("a secret door in a corner is rejected", () => {
    expect(() =>
      layoutRoom(room({ doors: [{ wall: "north", at: 0, secret: true }] }), PACK, SERVER_BASE),
    ).toThrow("out of range");
  });
});

// ---------------------------------------------------------------- sync planning

describe("planSync", () => {
  it("a new room plans a build, a changed room a rebuild, a removed room a delete", () => {
    const before: DungeonSpec = { rooms: [], links: [] };
    const after: DungeonSpec = {
      rooms: [{ ...room(), id: "entry-hall" }],
      links: [],
    };
    const built = new Map();
    const plan = planSync(before, after, built);
    expect(plan.build).toHaveLength(1);
    expect(plan.rebuild).toHaveLength(0);
    expect(plan.remove).toHaveLength(0);

    built.set("entry-hall", { sceneId: "scene-1", tileIds: [], wallIds: [], lightIds: [] });
    const widened: DungeonSpec = {
      rooms: [{ ...room(), id: "entry-hall", gridW: 18 }],
      links: [],
    };
    const plan2 = planSync(after, widened, built);
    expect(plan2.build).toHaveLength(0);
    expect(plan2.rebuild).toHaveLength(1);
    expect(plan2.rebuild[0].previous.sceneId).toBe("scene-1");

    const plan3 = planSync(widened, { rooms: [], links: [] }, built);
    expect(plan3.remove).toEqual([{ roomId: "entry-hall", sceneId: "scene-1" }]);
  });

  it("an unchanged room plans nothing", () => {
    const dungeon: DungeonSpec = { rooms: [{ ...room(), id: "entry-hall" }], links: [] };
    const built = new Map([
      ["entry-hall", { sceneId: "scene-1", tileIds: [], wallIds: [], lightIds: [] }],
    ]);
    const plan = planSync(dungeon, dungeon, built);
    expect(plan.build).toHaveLength(0);
    expect(plan.rebuild).toHaveLength(0);
    expect(plan.remove).toHaveLength(0);
  });

  it("canonical() ignores key order", () => {
    expect(canonical({ b: 1, a: { d: 4, c: 3 } })).toBe(canonical({ a: { c: 3, d: 4 }, b: 1 }));
  });
});

// ---------------------------------------------------------------- monitor routing

describe("classifyMessage — build routing", () => {
  const ctx = { room: room() };
  it("build requests route to build", () => {
    expect(classifyMessage(msg({ content: "add a door on the north wall" }), null, "Meroki", ctx)).toBe("build");
    expect(classifyMessage(msg({ content: "undo that" }), null, "Meroki", ctx)).toBe("build");
    expect(classifyMessage(msg({ content: "make this room 10 units wider" }), null, "Meroki", ctx)).toBe("build");
  });

  it("ambiguous build requests route to clarify", () => {
    expect(classifyMessage(msg({ content: "add a door here" }), null, "Meroki", ctx)).toBe("clarify");
  });

  it("out-of-scope build requests route to unsupported", () => {
    expect(classifyMessage(msg({ content: "make it darker" }), null, "Meroki", ctx)).toBe("unsupported");
  });

  it("rolls and questions still win over build", () => {
    expect(classifyMessage(msg({ content: "roll 1d20" }), null, "Meroki", ctx)).toBe("roll");
    expect(classifyMessage(msg({ content: "whose turn is it" }), null, "Meroki", ctx)).toBe("question");
  });

  it("plain chat stays chat", () => {
    expect(classifyMessage(msg({ content: "hello everyone" }), null, "Meroki", ctx)).toBe("chat");
  });

  it("without a build context, build lines stay chat (unchanged behaviour)", () => {
    expect(classifyMessage(msg({ content: "add a door on the north wall" }), null, "Meroki")).toBe("chat");
  });
});

// ---------------------------------------------------------------- formatting

describe("formatting", () => {
  it("formatBuildLine adds the icon per op", () => {
    expect(formatBuildLine("Built the 8×6 Entry Hall.", { type: "create-room", name: "Entry Hall", gridW: 8, gridH: 6, doors: [], chest: false, torches: false, fog: false })).toBe(
      "🏰 Built the 8×6 Entry Hall.",
    );
    expect(formatBuildLine("Widened the Entry Hall 10 squares east (now 18×6).", { type: "widen", side: "east", by: 10 })).toBe(
      "↔️ Widened the Entry Hall 10 squares east (now 18×6).",
    );
  });

  it("diffSummary reads as a change list", () => {
    const before: DungeonSpec = { rooms: [{ ...room(), id: "entry-hall" }], links: [] };
    const after: DungeonSpec = {
      rooms: [{ ...room(), id: "entry-hall", gridW: 18, doors: [{ wall: "south", at: 3 }, { wall: "north", at: 4, secret: true }] }],
      links: [],
    };
    const diff = diffSummary(before, after);
    expect(diff.some((l) => l.includes("8×6 → 18×6"))).toBe(true);
    expect(diff.some((l) => l.includes("secret door north@4"))).toBe(true);
  });

  it("describeDungeon lists rooms", () => {
    expect(describeDungeon({ rooms: [{ ...room(), id: "entry-hall" }], links: [] })).toEqual([
      "Entry Hall (8×6, door south@3)",
    ]);
  });
});

// ---------------------------------------------------------------- rooms by name (BRA-225)

function twoRoomDungeon(): DungeonSpec {
  return {
    rooms: [
      { ...room(), id: "entry-hall" },
      { name: "Crypt", gridW: 6, gridH: 5, seed: 1, doors: [{ wall: "west", at: 2 }], id: "crypt" },
    ],
    links: [],
  };
}

function twoRoomCtx(overrides: Partial<BuildParseContext> = {}): BuildParseContext {
  const d = twoRoomDungeon();
  return { room: d.rooms[0], rooms: d.rooms, ...overrides };
}

function opOf(result: BuildParseResult | null): BuildOp {
  if (!result || result.kind !== "build") {
    throw new Error(`expected a build parse, got ${JSON.stringify(result)}`);
  }
  return result.op;
}

function opsOf(result: CompoundParseResult | null): BuildOp[] {
  if (!result || result.kind !== "build") {
    throw new Error(`expected a compound build parse, got ${JSON.stringify(result)}`);
  }
  return result.ops;
}

describe("rooms by name (BRA-225)", () => {
  it("widen the Entry Hall targets it, not the active room", () => {
    const op = opOf(parseBuildRequest("widen the Entry Hall 10 units east", twoRoomCtx()));
    expect(op.type).toBe("widen");
    if (op.type === "widen") {
      expect(op.target).toBe("entry-hall");
      expect(op.by).toBe(10);
      expect(op.side).toBe("east");
    }
    // The active room is the Crypt; the widen still lands in the Hall.
    const state: BuildState = { dungeon: twoRoomDungeon(), activeRoom: "crypt" };
    const out = applyOp(state, op);
    expect(out.state.dungeon.rooms[0].gridW).toBe(18);
    expect(out.state.dungeon.rooms[1].gridW).toBe(6);
    // A targeted op makes its room the active one.
    expect(out.state.activeRoom).toBe("entry-hall");
  });

  it("add a door to the Crypt lands in the Crypt only", () => {
    const op = opOf(parseBuildRequest("add a door to the Crypt on the north wall", twoRoomCtx()));
    expect(op.type).toBe("add-door");
    if (op.type === "add-door") expect(op.target).toBe("crypt");
    const state: BuildState = { dungeon: twoRoomDungeon(), activeRoom: "entry-hall" };
    const out = applyOp(state, op);
    expect(out.state.dungeon.rooms[1].doors).toContainEqual({ wall: "north", at: 3 });
    expect(out.state.dungeon.rooms[0].doors).toEqual([{ wall: "south", at: 3 }]);
  });

  it("an unknown room name is a question naming the rooms we have", () => {
    const parsed = parseBuildRequest("widen the Sunken Chapel", twoRoomCtx());
    expect(parsed?.kind).toBe("clarify");
    if (parsed?.kind === "clarify") {
      expect(parsed.question).toContain("Sunken Chapel");
      expect(parsed.question).toContain("Entry Hall");
      expect(parsed.question).toContain("Crypt");
    }
  });

  it("two rooms named in one line is a question", () => {
    const parsed = parseBuildRequest("move the door from the Entry Hall to the Crypt", twoRoomCtx());
    expect(parsed?.kind).toBe("clarify");
    if (parsed?.kind === "clarify") {
      expect(parsed.question).toContain("Entry Hall");
      expect(parsed.question).toContain("Crypt");
    }
  });

  it("no name means the active room, as before", () => {
    const op = opOf(parseBuildRequest("widen the room west by 5", twoRoomCtx()));
    expect(op.type).toBe("widen");
    if (op.type === "widen") expect(op.target).toBeUndefined();
  });

  it("wall phrases are not room names", () => {
    const op = opOf(parseBuildRequest("add a door on the north wall", twoRoomCtx()));
    expect(op.type).toBe("add-door");
    if (op.type === "add-door") expect(op.target).toBeUndefined();
  });

  it("creating a room ignores existing names — the name is the new room's", () => {
    const op = opOf(parseBuildRequest("build a room called the Sunken Chapel", twoRoomCtx()));
    expect(op.type).toBe("create-room");
    if (op.type === "create-room") {
      expect(op.name).toBe("Sunken Chapel");
      expect("target" in op).toBe(false);
    }
  });

  it("a longer name that contains a shorter one wins, not a question", () => {
    const rooms = [
      { name: "Hall", gridW: 5, gridH: 5, seed: 1, id: "hall" },
      { ...room(), id: "entry-hall" },
    ];
    const op = opOf(parseBuildRequest("widen the Entry Hall", { room: rooms[1], rooms }));
    if (op.type === "widen") expect(op.target).toBe("entry-hall");
  });

  it("after a targeted op, the next untargeted edit lands in that room", () => {
    const session = new BuildSession(twoRoomDungeon());
    session.apply(
      opOf(parseBuildRequest("widen the Crypt 2 units east", twoRoomCtx())),
      "widen the Crypt 2 units east",
    );
    expect(session.current().activeRoom).toBe("crypt");
    session.apply(
      opOf(parseBuildRequest("add some bones", twoRoomCtx())),
      "add some bones",
    );
    const cur = session.current();
    // The Crypt was widened 6→8 first, so its south-east corner is (6,3).
    expect(cur.dungeon.rooms[1].dressing).toContainEqual({ tile: "bones", gx: 6, gy: 3 });
    expect(cur.dungeon.rooms[0].dressing ?? []).toHaveLength(0);
  });

  it("a target that isn't in the build throws plainly at apply time", () => {
    const state: BuildState = { dungeon: twoRoomDungeon(), activeRoom: "entry-hall" };
    expect(() =>
      applyOp(state, { type: "widen", side: "east", by: 2, target: "no-such-room" }),
    ).toThrow('No room "no-such-room" in this build.');
  });
});

// ---------------------------------------------------------------- "here" from ping/cursor (BRA-225)

describe("here from the GM's ping/cursor (BRA-225)", () => {
  it("resolveHere: nearest wall, cell along it, doors never in a corner", () => {
    const r = room();
    expect(resolveHere(450, 50, r)).toEqual({ wall: "north", at: 4, gx: 4, gy: 0 });
    expect(resolveHere(50, 350, r)).toEqual({ wall: "west", at: 3, gx: 0, gy: 3 });
    // South and east tie at 50px — south wins the tie-break.
    expect(resolveHere(750, 550, r)).toEqual({ wall: "south", at: 6, gx: 7, gy: 5 });
    // A corner cell clamps into the door range.
    expect(resolveHere(5, 5, r)).toEqual({ wall: "north", at: 1, gx: 0, gy: 0 });
  });

  it("resolveHereRegion: the half the ping sits in", () => {
    const r = room();
    expect(resolveHereRegion(400, 100, r)).toBe("north-half");
    expect(resolveHereRegion(400, 500, r)).toBe("south-half");
    expect(resolveHereRegion(50, 300, r)).toBe("west-half");
    expect(resolveHereRegion(750, 300, r)).toBe("east-half");
  });

  it("add a door here takes the wall + cell from the ping, in the pinged room", () => {
    const op = opOf(
      parseBuildRequest(
        "add a door here",
        twoRoomCtx({ here: { roomId: "entry-hall", x: 450, y: 50 } }),
      ),
    );
    expect(op).toEqual({ type: "add-door", wall: "north", at: 4, target: "entry-hall" });
  });

  it("add a door here with no ping still asks which wall", () => {
    const parsed = parseBuildRequest("add a door here", twoRoomCtx());
    expect(parsed?.kind).toBe("clarify");
  });

  it("add some bones here lands on the pinged cell", () => {
    const op = opOf(
      parseBuildRequest(
        "add some bones here",
        twoRoomCtx({ here: { roomId: "entry-hall", x: 250, y: 250 } }),
      ),
    );
    expect(op.type).toBe("add-dressing");
    if (op.type === "add-dressing") {
      expect(op.where).toEqual({ kind: "cell", gx: 2, gy: 2 });
      expect(op.target).toBe("entry-hall");
    }
    const state: BuildState = { dungeon: twoRoomDungeon(), activeRoom: "entry-hall" };
    const out = applyOp(state, op);
    expect(out.state.dungeon.rooms[0].dressing).toContainEqual({ tile: "bones", gx: 2, gy: 2 });
    expect(out.summary).toContain("where you pinged");
  });

  it("widen here widens the wall nearest the ping", () => {
    const op = opOf(
      parseBuildRequest(
        "widen here",
        twoRoomCtx({ here: { roomId: "entry-hall", x: 750, y: 300 } }),
      ),
    );
    expect(op.type).toBe("widen");
    if (op.type === "widen") expect(op.side).toBe("east");
  });

  it("add a corridor here runs through the wall nearest the ping", () => {
    const op = opOf(
      parseBuildRequest(
        "add a corridor here",
        twoRoomCtx({ here: { roomId: "entry-hall", x: 400, y: 550 } }),
      ),
    );
    expect(op.type).toBe("add-corridor");
    if (op.type === "add-corridor") expect(op.direction).toBe("south");
  });

  it("make this part underwater here takes the pinged half", () => {
    const op = opOf(
      parseBuildRequest(
        "make this part underwater here",
        twoRoomCtx({ here: { roomId: "entry-hall", x: 400, y: 100 } }),
      ),
    );
    expect(op.type).toBe("overlay");
    if (op.type === "overlay") expect(op.region).toBe("north-half");
  });

  it("a ping in one room and a name for another is a question", () => {
    const parsed = parseBuildRequest(
      "add a door here in the Crypt",
      twoRoomCtx({ here: { roomId: "entry-hall", x: 450, y: 50 } }),
    );
    expect(parsed?.kind).toBe("clarify");
    if (parsed?.kind === "clarify") {
      expect(parsed.question).toContain("Entry Hall");
      expect(parsed.question).toContain("Crypt");
    }
  });
});

// ---------------------------------------------------------------- compound requests (BRA-225)

describe("compound requests (BRA-225)", () => {
  it("add a door and widen is two ops, applied in order", () => {
    const ops = opsOf(
      parseBuildRequests("add a door on the north wall and widen the room 10 east", {
        room: room(),
      }),
    );
    expect(ops).toHaveLength(2);
    expect(ops[0].type).toBe("add-door");
    expect(ops[1].type).toBe("widen");
    const session = new BuildSession();
    session.apply({ type: "create-room", name: "Entry Hall", gridW: 8, gridH: 6, doors: [{ wall: "south" }], chest: false, torches: false, fog: false }, "build an 8x6 entry hall");
    for (const op of ops) session.apply(op, "add a door on the north wall and widen the room 10 east");
    const cur = session.current();
    expect(cur.dungeon.rooms[0].gridW).toBe(18);
    expect(cur.dungeon.rooms[0].doors).toContainEqual({ wall: "north", at: 4 });
    expect(session.history()).toHaveLength(3);
  });

  it("add some bones and add torches is two ops", () => {
    const ops = opsOf(parseBuildRequests("add some bones and add torches", { room: room() }));
    expect(ops.map((o) => o.type)).toEqual(["add-dressing", "add-torches"]);
  });

  it("a single-op line is still one op", () => {
    const ops = opsOf(parseBuildRequests("add a door on the north wall", { room: room() }));
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe("add-door");
  });

  it("an unparseable second segment falls back to the whole line as one request", () => {
    const ops = opsOf(
      parseBuildRequests("add a door on the north wall and frobnicate the ceiling", { room: room() }),
    );
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe("add-door");
  });

  it("undo that and add a door is an undo op plus a build op", () => {
    const ops = opsOf(parseBuildRequests("undo that and add a door on the north wall", { room: room() }));
    expect(ops.map((o) => o.type)).toEqual(["undo", "add-door"]);
  });

  it("a compound line classifies as build", () => {
    const ctx = { room: room() };
    expect(
      classifyMessage(
        msg({ content: "add a door on the north wall and widen the room 10 east" }),
        null,
        "Meroki",
        ctx,
      ),
    ).toBe("build");
  });

  it("a compound that starts with a question stays a question", () => {
    const parsed = parseBuildRequests("add a corridor and widen the room", { room: room() });
    expect(parsed?.kind).toBe("clarify");
  });
});

// ---------------------------------------------------------------- session persistence (BRA-225)

describe("build session persistence (BRA-225)", () => {
  it("snapshot / restore round-trips states, entries, index, and focus", () => {
    const session = new BuildSession(twoRoomDungeon());
    session.apply({ type: "widen", side: "east", by: 2 }, "widen the room");
    session.apply({ type: "add-door", wall: "north", at: 3 }, "add a door");
    session.undo();
    const built = new Map([
      ["entry-hall", { sceneId: "scene-1", tileIds: ["t1"], wallIds: ["w1"], lightIds: [] }],
    ]);
    const snap = session.snapshot(built);
    expect(isBuildSessionSnapshot(snap)).toBe(true);
    const restored = new BuildSession();
    expect(restored.restore(snap)).toBe(true);
    expect(restored.current()).toEqual(session.current());
    expect(restored.history()).toEqual(session.history());
    expect(restored.canUndo()).toBe(session.canUndo());
    expect(restored.canRedo()).toBe(session.canRedo());
    // The restored session keeps working: redo re-applies the undone door.
    const redone = restored.redo();
    expect(redone?.op.type).toBe("add-door");
    expect(restored.current().dungeon.rooms[0].doors).toContainEqual({ wall: "north", at: 3 });
  });

  it("restore rejects the wrong shape instead of throwing", () => {
    const session = new BuildSession();
    expect(session.restore({})).toBe(false);
    expect(session.restore(null)).toBe(false);
    expect(session.restore({ version: 2, states: [], entries: [], index: 0, built: {} })).toBe(false);
    expect(session.restore({ version: 1, states: [], entries: [], index: 0, built: {} })).toBe(false);
    expect(session.current().dungeon.rooms).toHaveLength(0);
  });

  it("save / load round-trips a session + built map through a file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "build-state-"));
    try {
      const file = path.join(dir, "state.json");
      const session = new BuildSession(twoRoomDungeon());
      session.apply({ type: "widen", side: "east", by: 2 }, "widen the room");
      const built = new Map([
        ["entry-hall", { sceneId: "scene-1", tileIds: ["t1"], wallIds: [], lightIds: ["l1"] }],
      ]);
      saveBuildState(session, built, file);
      const loaded = loadBuildState(file);
      expect(loaded).not.toBeNull();
      expect(loaded!.session.current()).toEqual(session.current());
      expect(loaded!.session.history()).toEqual(session.history());
      expect(loaded!.built.get("entry-hall")).toEqual({
        sceneId: "scene-1",
        tileIds: ["t1"],
        wallIds: [],
        lightIds: ["l1"],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("load returns null for a missing file and for a corrupt one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "build-state-"));
    try {
      expect(loadBuildState(path.join(dir, "nope.json"))).toBeNull();
      const bad = path.join(dir, "bad.json");
      fs.writeFileSync(bad, "this is not json", "utf-8");
      expect(loadBuildState(bad)).toBeNull();
      fs.writeFileSync(bad, JSON.stringify({ version: 9 }), "utf-8");
      expect(loadBuildState(bad)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- runMonitor dry-run (BRA-225)

const GM_ID = "gm-1";
const OWN_ID = "own-1";

function fakeLive(overrides: Record<string, unknown> = {}) {
  const live = {
    userId: OWN_ID,
    getChatMessages: (_limit: number) => [],
    getUsers: () => [{ _id: GM_ID, name: "Gamemaster", role: 4, active: true }],
    getCombatState: () => null,
    getWorldSummary: () => ({ title: "TestBed", counts: {} }),
    raw: () => ({ getJournals: () => [] }),
    on: (_fn: unknown) => () => {},
    sendChat: async () => "sent-1",
    sendChatIdempotent: async () => ({ id: "idem-1", duplicate: false }),
    rollDice: async (formula: string) => ({
      formula,
      total: 17,
      breakdown: "12 + 5",
      timestamp: new Date().toISOString(),
      source: "local" as const,
    }),
    waitForChat: async () => ({ timedOut: true, newMessages: [], lastSeen: null }),
    lastPointFor: (_id: string) => null,
    ...overrides,
  };
  return live;
}

describe("runMonitor dry-run — compound builds + state restore (BRA-225)", () => {
  it("a compound build line logs one build event with both ops", async () => {
    const logs: Record<string, unknown>[] = [];
    const live = fakeLive({
      waitForChat: async () => ({
        timedOut: false,
        newMessages: [
          msg({
            id: "m1",
            author: "player-1",
            content: "add a door on the north wall and widen the room 10 east",
          }),
        ],
        lastSeen: "m1",
      }),
    });
    const summary = await runMonitor(live as unknown as FoundryLive, {
      dryRun: true,
      once: true,
      onLog: (l) => logs.push(l as unknown as Record<string, unknown>),
      buildStatePath: path.join(os.tmpdir(), "build-state-does-not-exist.json"),
    });
    expect(summary.messagesSeen).toBe(1);
    expect(summary.buildsHandled).toBe(0); // dry-run executes nothing
    const build = logs.find((l) => l.event === "build");
    expect(build).toBeDefined();
    expect((build!.ops as unknown[]).map((o) => (o as { type: string }).type)).toEqual([
      "add-door",
      "widen",
    ]);
    expect(build!.dryRun).toBe(true);
  });

  it("a saved state file restores the session on start", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "build-state-"));
    try {
      const file = path.join(dir, "state.json");
      const session = new BuildSession(twoRoomDungeon());
      session.apply({ type: "widen", side: "east", by: 2 }, "widen the room");
      saveBuildState(
        session,
        new Map([["entry-hall", { sceneId: "scene-1", tileIds: [], wallIds: [], lightIds: [] }]]),
        file,
      );
      const logs: Record<string, unknown>[] = [];
      const live = fakeLive();
      await runMonitor(live as unknown as FoundryLive, {
        dryRun: true,
        once: true,
        onLog: (l) => logs.push(l as unknown as Record<string, unknown>),
        buildStatePath: file,
      });
      const restored = logs.find((l) => l.event === "build-state-restored");
      expect(restored).toBeDefined();
      expect(restored!.rooms).toBe(2);
      expect(restored!.history).toBe(1);
      expect(restored!.built).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
