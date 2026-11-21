/**
 * Unit tests for door verbs (BRA-234) — open/close/lock/unlock/listen
 * at doors. Pure — no Foundry connection needed. Run with `bun test`.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BuildSession,
  applyOp,
  canWalkThroughDoor,
  describeDungeon,
  diffSummary,
  doorKeyOf,
  doorStateOf,
  formatBuildLine,
  listenSummary,
  loadBuildState,
  parseBuildRequest,
  parseKeyOrMethod,
  planSync,
  resolveDoor,
  saveBuildState,
  type BuildOp,
  type BuildParseContext,
  type BuildParseResult,
  type BuildState,
} from "../src/session/build-loop.js";
import { classifyMessage, runMonitor } from "../src/session/monitor.js";
import type { FoundryLive } from "../src/live.js";
import type { DungeonSpec, RoomSpec } from "../src/worldbuilding/tiles-layout.js";
import type { ChatMessage } from "../src/types.js";

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

function stateWithRoom(r?: RoomSpec, links: DungeonSpec["links"] = []): BuildState {
  const rm = r ?? room();
  return {
    dungeon: { rooms: [{ ...rm, id: "entry-hall" }], links },
    activeRoom: "entry-hall",
  };
}

function ctxFor(r?: RoomSpec, links: DungeonSpec["links"] = []): BuildParseContext {
  const st = stateWithRoom(r, links);
  return { room: st.dungeon.rooms[0], rooms: st.dungeon.rooms };
}

function opOf(result: BuildParseResult | null): BuildOp {
  if (!result || result.kind !== "build") {
    throw new Error(`expected a build parse, got ${JSON.stringify(result)}`);
  }
  return result.op;
}

function clarifyOf(result: BuildParseResult | null): string {
  if (!result || result.kind !== "clarify") {
    throw new Error(`expected a clarify parse, got ${JSON.stringify(result)}`);
  }
  return result.question;
}

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return { id: "m1", author: "author-1", content: "hello", style: 1, timestamp: 0, ...partial };
}

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

function cryptRoom(overrides: Partial<RoomSpec> = {}): RoomSpec {
  return {
    name: "Crypt",
    gridW: 6,
    gridH: 5,
    seed: 1,
    doors: [{ wall: "north", at: 2 }],
    ...overrides,
  };
}

function linkedDungeon(): DungeonSpec {
  return {
    rooms: [
      { ...room(), id: "entry-hall" },
      { ...cryptRoom(), id: "crypt" },
    ],
    links: [{ from: { room: "entry-hall", wall: "south", at: 3 }, to: { room: "crypt", wall: "north", at: 2 } }],
  };
}

// ---------------------------------------------------------------- parser

describe("parseBuildRequest — door verbs", () => {
  it("open/close/lock/unlock/listen parse to door ops on the named wall", () => {
    const ctx = ctxFor();
    expect(opOf(parseBuildRequest("open the south door", ctx))).toEqual({
      type: "open-door", wall: "south", at: 3,
    });
    expect(opOf(parseBuildRequest("close the door", ctx))).toEqual({
      type: "close-door", wall: "south", at: 3,
    });
    expect(opOf(parseBuildRequest("lock the south door", ctx))).toEqual({
      type: "lock-door", wall: "south", at: 3,
    });
    expect(opOf(parseBuildRequest("unlock the door", ctx))).toEqual({
      type: "unlock-door", wall: "south", at: 3,
    });
    expect(opOf(parseBuildRequest("listen at the south door", ctx))).toEqual({
      type: "listen-door", wall: "south", at: 3,
    });
  });

  it("synonyms: shut/bar/unbar and put your ear to the door", () => {
    const ctx = ctxFor();
    expect(opOf(parseBuildRequest("shut the door", ctx)).type).toBe("close-door");
    expect(opOf(parseBuildRequest("bar the door", ctx)).type).toBe("lock-door");
    expect(opOf(parseBuildRequest("unbar the door", ctx)).type).toBe("unlock-door");
    expect(opOf(parseBuildRequest("put your ear to the south door", ctx)).type).toBe("listen-door");
    expect(opOf(parseBuildRequest("press my ear against the door", ctx)).type).toBe("listen-door");
  });

  it("a key is recorded on lock/unlock; a method on unlock", () => {
    const ctx = ctxFor();
    expect(opOf(parseBuildRequest("lock the door with the brass key", ctx))).toEqual({
      type: "lock-door", wall: "south", at: 3, key: "brass key",
    });
    expect(opOf(parseBuildRequest("unlock the door using the iron key", ctx))).toEqual({
      type: "unlock-door", wall: "south", at: 3, key: "iron key",
    });
    expect(opOf(parseBuildRequest("unlock the door by picking the lock", ctx))).toEqual({
      type: "unlock-door", wall: "south", at: 3, key: "pick the lock",
    });
    expect(parseKeyOrMethod("lock the door")).toEqual({});
    expect(parseKeyOrMethod("unlock the door by picking the lock")).toEqual({ method: "pick the lock" });
  });

  it("a capitalized key is not misread as a room name", () => {
    const d = linkedDungeon();
    const ctx: BuildParseContext = { room: d.rooms[0], rooms: d.rooms };
    expect(opOf(parseBuildRequest("Lock the South Door with the Brass Key", ctx))).toEqual({
      type: "lock-door", wall: "south", at: 3, key: "Brass Key",
    });
  });

  it("a secret door is addressed as the secret door", () => {
    const ctx = ctxFor(room({ doors: [{ wall: "south", at: 3 }, { wall: "north", at: 4, secret: true }] }));
    expect(opOf(parseBuildRequest("open the secret door", ctx))).toEqual({
      type: "open-door", wall: "north", at: 4,
    });
    expect(opOf(parseBuildRequest("lock the hidden door with the rusted key", ctx))).toEqual({
      type: "lock-door", wall: "north", at: 4, key: "rusted key",
    });
  });

  it("ambiguity is a question listing the doors that exist", () => {
    const two = room({ doors: [{ wall: "south", at: 3 }, { wall: "north", at: 4 }] });
    const ctx = ctxFor(two);
    expect(clarifyOf(parseBuildRequest("open the door", ctx))).toBe(
      "Which door — south door at cell 3, north door at cell 4?",
    );
    expect(clarifyOf(parseBuildRequest("open the east door", ctx))).toBe(
      "There's no door on the east wall yet — which door did you mean?",
    );
    expect(clarifyOf(parseBuildRequest("open the door at cell 5", ctx))).toBe(
      "There's no door at cell 5 in this room — which door did you mean?",
    );
    expect(clarifyOf(parseBuildRequest("open the secret door", ctx))).toBe(
      "There's no secret door in this room yet — add one first, or name a plain door.",
    );
  });

  it("an opening is not a door — the question says look through", () => {
    const ctx = ctxFor(room({
      doors: [{ wall: "south", at: 3 }],
      openings: [{ wall: "east", at: 2 }],
    }));
    expect(clarifyOf(parseBuildRequest("open the east door", ctx))).toBe(
      "There's no door on the east wall — it's an open archway, you can just look through.",
    );
  });

  it("no door at all is a question, not a build", () => {
    const ctx = ctxFor(room({ doors: [] }));
    expect(clarifyOf(parseBuildRequest("open the door", ctx))).toBe(
      "There's no door in this room yet — build a room with a door first, or add one.",
    );
    expect(clarifyOf(parseBuildRequest("lock the door", undefined))).toBe(
      "There's no door in this room yet — build a room first, or add one.",
    );
  });

  it("non-door lines are not door verbs", () => {
    const ctx = ctxFor();
    expect(parseBuildRequest("open the chest", ctx)).toBeNull();
    expect(parseBuildRequest("lock it", ctx)).toBeNull();
    expect(parseBuildRequest("listen!", ctx)).toBeNull();
    expect(parseBuildRequest("open the door to the crypt", ctxFor(room(), []))).not.toBeNull();
  });

  it("the verb must lead — narrative unlocks are not commands", () => {
    const ctx = ctxFor();
    // The FR-15 floor brief (modes.test.ts): "three pressure-plate
    // puzzles ... to unlock a door" is a brief, not a lock command —
    // an anywhere-match stole it from the co-design brief detector.
    const brief =
      "Here's an entire floor of a dungeon, roughly: three pressure-plate puzzles in three different rooms to unlock a door. " +
      "A riddle type thing over here. Two minor encounters, one of which is an ambush. Then the big boss battle. Some intrigue.";
    expect(parseBuildRequest(brief, ctx)).toBeNull();
    expect(parseBuildRequest("three puzzles to unlock a door", ctx)).toBeNull();
    expect(parseBuildRequest("the door unlocks when the plates are solved", ctx)).toBeNull();
  });

  it("fluff leads are stripped — please / can you / Meroki", () => {
    const ctx = ctxFor();
    expect(opOf(parseBuildRequest("please lock the south door", ctx))).toEqual({
      type: "lock-door", wall: "south", at: 3,
    });
    expect(opOf(parseBuildRequest("Meroki, open the south door", ctx))).toEqual({
      type: "open-door", wall: "south", at: 3,
    });
    expect(opOf(parseBuildRequest("can you unlock the door", ctx))).toEqual({
      type: "unlock-door", wall: "south", at: 3,
    });
  });
});

describe("resolveDoor", () => {
  it("a cell narrows across walls; here resolves from the ping", () => {
    const two = room({ doors: [{ wall: "south", at: 3 }, { wall: "north", at: 3 }] });
    expect(resolveDoor("open the door at cell 3", two)).toEqual({
      clarify: "Which door — south door at cell 3, north door at cell 3?",
    });
    const one = room({ doors: [{ wall: "south", at: 3 }, { wall: "north", at: 4 }] });
    expect(resolveDoor("open the door at cell 4", one)).toEqual({
      door: { wall: "north", at: 4 },
    });
    // Ping at the south edge of an 8x6 room (y near 600) → south wall.
    const here = resolveDoor("lock the door here", one, { here: { roomId: "entry-hall", x: 350, y: 580 } });
    expect(here).toEqual({ door: { wall: "south", at: 3 } });
  });
});

// ---------------------------------------------------------------- applyOp: state machine

describe("applyOp — door verbs", () => {
  it("open/close round-trip; already-open/closed are no-ops", () => {
    const session = new BuildSession(linkedDungeon());
    let r = session.apply({ type: "open-door", wall: "south", at: 3 }, "open the south door");
    expect(r).toEqual({ summary: "Opened the south door.", changed: true });
    expect(doorStateOf(session.current().dungeon.rooms[0].doors![0])).toBe("open");
    r = session.apply({ type: "open-door", wall: "south", at: 3 }, "open the south door");
    expect(r).toEqual({ summary: "The south door is already open.", changed: false });
    r = session.apply({ type: "close-door", wall: "south", at: 3 }, "close the south door");
    expect(r).toEqual({ summary: "Closed the south door.", changed: true });
    r = session.apply({ type: "close-door", wall: "south", at: 3 }, "close the south door");
    expect(r).toEqual({ summary: "The south door is already closed.", changed: false });
  });

  it("lock records the key; unlock checks it; bare unlock is GM fiat", () => {
    const session = new BuildSession(linkedDungeon());
    let r = session.apply({ type: "lock-door", wall: "south", at: 3, key: "brass key" }, "lock it");
    expect(r).toEqual({ summary: "Locked the south door with the brass key.", changed: true });
    const door = session.current().dungeon.rooms[0].doors![0];
    expect(doorStateOf(door)).toBe("locked");
    expect(doorKeyOf(door)).toBe("brass key");
    r = session.apply({ type: "lock-door", wall: "south", at: 3 }, "lock it");
    expect(r).toEqual({ summary: "The south door is already locked (with the brass key).", changed: false });
    expect(() =>
      session.apply({ type: "unlock-door", wall: "south", at: 3, key: "iron key" }, "unlock it"),
    ).toThrow("is locked with the brass key, not the iron key");
    r = session.apply({ type: "unlock-door", wall: "south", at: 3 }, "unlock it");
    expect(r).toEqual({ summary: "Unlocked the south door (the brass key).", changed: true });
    // The key stays on the door — re-locking without a key re-uses it.
    r = session.apply({ type: "lock-door", wall: "south", at: 3 }, "lock it");
    expect(r.summary).toBe("Locked the south door with the brass key.");
    r = session.apply({ type: "unlock-door", wall: "south", at: 3, key: "pick the lock" }, "pick it");
    expect(r).toEqual({ summary: "Picked the lock on the south door.", changed: true });
  });

  it("locking an open door and opening a locked door are errors", () => {
    const session = new BuildSession(linkedDungeon());
    session.apply({ type: "open-door", wall: "south", at: 3 }, "open it");
    expect(() =>
      session.apply({ type: "lock-door", wall: "south", at: 3 }, "lock it"),
    ).toThrow("Close the south door first — you can't lock an open door.");
    session.apply({ type: "close-door", wall: "south", at: 3 }, "close it");
    session.apply({ type: "lock-door", wall: "south", at: 3, key: "brass key" }, "lock it");
    expect(() =>
      session.apply({ type: "open-door", wall: "south", at: 3 }, "open it"),
    ).toThrow("The south door is locked — unlock it first (with the brass key).");
  });

  it("unlocking a door that isn't locked is a no-op that says so", () => {
    const session = new BuildSession(linkedDungeon());
    let r = session.apply({ type: "unlock-door", wall: "south", at: 3 }, "unlock it");
    expect(r).toEqual({ summary: "The south door isn't locked.", changed: false });
    session.apply({ type: "open-door", wall: "south", at: 3 }, "open it");
    r = session.apply({ type: "unlock-door", wall: "south", at: 3 }, "unlock it");
    expect(r).toEqual({ summary: "The south door isn't locked — it's open.", changed: false });
  });

  it("a missing door is an error naming the room", () => {
    const session = new BuildSession(linkedDungeon());
    expect(() =>
      session.apply({ type: "open-door", wall: "east", at: 2 }, "open it"),
    ).toThrow("There's no door on the east wall at cell 2 in the Entry Hall.");
  });

  it("undo restores the prior door state", () => {
    const session = new BuildSession(linkedDungeon());
    session.apply({ type: "lock-door", wall: "south", at: 3, key: "brass key" }, "lock it");
    expect(doorStateOf(session.current().dungeon.rooms[0].doors![0])).toBe("locked");
    session.undo();
    expect(doorStateOf(session.current().dungeon.rooms[0].doors![0])).toBe("closed");
    session.redo();
    expect(doorStateOf(session.current().dungeon.rooms[0].doors![0])).toBe("locked");
  });

  it("door state survives a snapshot round-trip", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "door-state-"));
    try {
      const file = path.join(dir, "state.json");
      const session = new BuildSession(linkedDungeon());
      session.apply({ type: "lock-door", wall: "south", at: 3, key: "brass key" }, "lock it");
      saveBuildState(session, new Map(), file);
      const restored = loadBuildState(file);
      expect(restored).not.toBeNull();
      const door = restored!.session.current().dungeon.rooms[0].doors![0];
      expect(doorStateOf(door)).toBe("locked");
      expect(doorKeyOf(door)).toBe("brass key");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a verb with no state change leaves the spec byte-identical", () => {
    const before = stateWithRoom();
    const after = applyOp(before, { type: "close-door", wall: "south", at: 3 });
    expect(after.changed).toBe(false);
    expect(JSON.stringify(after.state.dungeon)).toBe(JSON.stringify(before.dungeon));
  });
});

// ---------------------------------------------------------------- listen

describe("listen at a door", () => {
  it("an unlinked door has no far side to hear", () => {
    const d = linkedDungeon();
    d.links = [];
    const summary = listenSummary(d, d.rooms[0], d.rooms[0].doors![0]);
    expect(summary).toBe(
      "You press your ear to the south door and hear nothing — the door doesn't lead anywhere yet.",
    );
  });

  it("a linked door reports atmosphere, never the far room's name", () => {
    const d = linkedDungeon();
    const summary = listenSummary(d, d.rooms[0], d.rooms[0].doors![0]);
    expect(summary).toBe("You press your ear to the south door — cold stone air.");
    expect(summary).not.toContain("Crypt");
  });

  it("fog and torchlight on the far side leak under the door", () => {
    const d = linkedDungeon();
    d.rooms[1].fog = [{ tile: "fog-pool", gx: 1, gy: 1 }];
    d.rooms[1].torches = [{ gx: 1, gy: 1 }];
    const summary = listenSummary(d, d.rooms[0], d.rooms[0].doors![0]);
    expect(summary).toBe(
      "You press your ear to the south door — a faint warm glow leaks under the door; damp air curls under the door; cold stone air.",
    );
    expect(summary).not.toContain("Crypt");
  });

  it("a locked door muffles the report; a western room smells of dust", () => {
    const d = linkedDungeon();
    d.rooms[1].theme = "western";
    const locked = { ...d.rooms[0].doors![0], state: "locked" as const, key: "brass key" };
    d.rooms[0].doors = [locked];
    const summary = listenSummary(d, d.rooms[0], locked);
    expect(summary).toBe(
      "You press your ear to the south door — Through the locked door, muffled: dry dust on the air.",
    );
  });

  it("listen is a read — no state change, no history entry", () => {
    const session = new BuildSession(linkedDungeon());
    const r = session.apply({ type: "listen-door", wall: "south", at: 3 }, "listen at the door");
    expect(r.changed).toBe(false);
    expect(r.summary).toBe("You press your ear to the south door — cold stone air.");
    expect(session.history()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- movement gate

describe("canWalkThroughDoor", () => {
  it("a locked door blocks movement until unlocked", () => {
    const session = new BuildSession(linkedDungeon());
    session.apply({ type: "lock-door", wall: "south", at: 3, key: "brass key" }, "lock it");
    const d = session.current().dungeon;
    expect(canWalkThroughDoor(d, "entry-hall", "south", 3)).toEqual({
      ok: false,
      reason: "The south door is locked (with the brass key) — unlock it first.",
    });
    session.apply({ type: "unlock-door", wall: "south", at: 3 }, "unlock it");
    expect(canWalkThroughDoor(session.current().dungeon, "entry-hall", "south", 3)).toEqual({ ok: true });
  });

  it("closed and open doors don't block; an unlinked door has nowhere to go", () => {
    const d = linkedDungeon();
    expect(canWalkThroughDoor(d, "entry-hall", "south", 3)).toEqual({ ok: true });
    d.links = [];
    expect(canWalkThroughDoor(d, "entry-hall", "south", 3)).toEqual({
      ok: false,
      reason: "The south door isn't linked to another room yet.",
    });
  });

  it("an opening never blocks; a missing door or room blocks with a reason", () => {
    const d = linkedDungeon();
    d.rooms[0].openings = [{ wall: "east", at: 2 }];
    expect(canWalkThroughDoor(d, "entry-hall", "east", 2)).toEqual({ ok: true });
    expect(canWalkThroughDoor(d, "entry-hall", "east", 3)).toEqual({
      ok: false,
      reason: "There's no door on the east wall at cell 3 in the Entry Hall.",
    });
    expect(canWalkThroughDoor(d, "no-such-room", "south", 3)).toEqual({
      ok: false,
      reason: 'No room "no-such-room" in this build.',
    });
  });
});

// ---------------------------------------------------------------- sync planning + formatting

describe("planSync + formatting for door verbs", () => {
  it("a lock plans a rebuild; a listen plans nothing", () => {
    const before = linkedDungeon();
    const built = new Map([
      ["entry-hall", { sceneId: "scene-1", tileIds: [], wallIds: [], lightIds: [] }],
      ["crypt", { sceneId: "scene-2", tileIds: [], wallIds: [], lightIds: [] }],
    ]);
    const locked = applyOp(
      { dungeon: before, activeRoom: "entry-hall" },
      { type: "lock-door", wall: "south", at: 3, key: "brass key" },
    );
    const plan = planSync(before, locked.state.dungeon, built);
    expect(plan.rebuild).toHaveLength(1);
    expect(plan.rebuild[0].room.id).toBe("entry-hall");
    const listened = applyOp(
      { dungeon: before, activeRoom: "entry-hall" },
      { type: "listen-door", wall: "south", at: 3 },
    );
    expect(planSync(before, listened.state.dungeon, built).rebuild).toHaveLength(0);
  });

  it("describeDungeon and diffSummary show door state", () => {
    const session = new BuildSession(linkedDungeon());
    session.apply({ type: "lock-door", wall: "south", at: 3, key: "brass key" }, "lock it");
    expect(describeDungeon(session.current().dungeon)).toEqual([
      "Entry Hall (8×6, door south@3 (locked))",
      "Crypt (6×5, door north@2)",
    ]);
    const diff = diffSummary(linkedDungeon(), session.current().dungeon);
    expect(diff).toContain("- door south@3 in Entry Hall");
    expect(diff).toContain("+ door south@3 (locked, brass key) in Entry Hall");
  });

  it("formatBuildLine uses the door icon for verbs and an ear for listen", () => {
    expect(formatBuildLine("Locked the south door.", { type: "lock-door", wall: "south", at: 3 })).toBe(
      "🚪 Locked the south door.",
    );
    expect(formatBuildLine("You press your ear to the south door — cold stone air.", { type: "listen-door", wall: "south", at: 3 })).toBe(
      "👂 You press your ear to the south door — cold stone air.",
    );
  });
});

// ---------------------------------------------------------------- monitor routing

describe("classifyMessage — door verbs route to build", () => {
  const ctx = ctxFor();
  it("a door verb is a build; a non-door open is chat", () => {
    expect(classifyMessage(msg({ content: "lock the south door" }), OWN_ID, "Meroki", ctx)).toBe("build");
    expect(classifyMessage(msg({ content: "listen at the door" }), OWN_ID, "Meroki", ctx)).toBe("build");
    expect(classifyMessage(msg({ content: "open the chest" }), OWN_ID, "Meroki", ctx)).toBe("chat");
  });

  it("an ambiguous door verb is a clarify", () => {
    const two = ctxFor(room({ doors: [{ wall: "south", at: 3 }, { wall: "north", at: 4 }] }));
    expect(classifyMessage(msg({ content: "open the door" }), OWN_ID, "Meroki", two)).toBe("clarify");
  });
});

describe("runMonitor dry-run — door verbs", () => {
  it("a lock line logs one build event with the lock-door op", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "door-monitor-"));
    try {
      const file = path.join(dir, "state.json");
      const session = new BuildSession(linkedDungeon());
      saveBuildState(session, new Map(), file);
      const logs: Record<string, unknown>[] = [];
      const live = fakeLive({
        waitForChat: async () => ({
          timedOut: false,
          newMessages: [
            msg({ id: "m1", author: "player-1", content: "lock the south door with the brass key" }),
          ],
          lastSeen: "m1",
        }),
      });
      const summary = await runMonitor(live as unknown as FoundryLive, {
        dryRun: true,
        once: true,
        onLog: (l) => logs.push(l as unknown as Record<string, unknown>),
        buildStatePath: file,
      });
      expect(summary.messagesSeen).toBe(1);
      const build = logs.find((l) => l.event === "build");
      expect(build).toBeDefined();
      expect((build!.ops as unknown[]).map((o) => (o as { type: string }).type)).toEqual(["lock-door"]);
      expect((build!.ops as unknown[])[0]).toEqual({
        type: "lock-door", wall: "south", at: 3, key: "brass key",
      });
      expect(build!.dryRun).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an ambiguous door verb logs a build-clarify naming the doors", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "door-monitor-"));
    try {
      const file = path.join(dir, "state.json");
      const two = linkedDungeon();
      two.rooms[0].doors = [{ wall: "south", at: 3 }, { wall: "north", at: 4 }];
      const session = new BuildSession(two);
      saveBuildState(session, new Map(), file);
      const logs: Record<string, unknown>[] = [];
      const live = fakeLive({
        waitForChat: async () => ({
          timedOut: false,
          newMessages: [msg({ id: "m1", author: "player-1", content: "open the door" })],
          lastSeen: "m1",
        }),
      });
      await runMonitor(live as unknown as FoundryLive, {
        dryRun: true,
        once: true,
        onLog: (l) => logs.push(l as unknown as Record<string, unknown>),
        buildStatePath: file,
      });
      const clarify = logs.find((l) => l.event === "build-clarify");
      expect(clarify).toBeDefined();
      expect(clarify!.question).toBe("Which door — south door at cell 3, north door at cell 4?");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
