/**
 * Unit tests for the chat-driven building loop (FR-1) + undo (FR-8).
 * Pure — no Foundry connection needed. Run with `bun test`.
 */
import { describe, expect, it } from "bun:test";
import {
  BuildSession,
  applyOp,
  canonical,
  describeDungeon,
  diffSummary,
  formatBuildLine,
  parseBuildRequest,
  planSync,
  type BuildOp,
  type BuildParseResult,
  type BuildState,
} from "../src/session/build-loop.js";
import { classifyMessage } from "../src/session/monitor.js";
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
