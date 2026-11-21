/**
 * Clocks tests (BRA-228) — pure state machine, round advance, parser,
 * rendering, serialization, and the state file. No Foundry
 * connection: the live layer (chat lines, combat polling) is
 * live-tested next session.
 */
import { describe, it, expect } from "bun:test";
import {
  emptyClockStore,
  createClock,
  getClock,
  findClocksByName,
  listClocks,
  resolveClockTarget,
  tickClock,
  fillClock,
  resolveClock,
  resetClock,
  dropClock,
  advanceClocksToRound,
  clockBar,
  renderClock,
  renderClockStore,
  serializeClockStore,
  parseClockStore,
  isClockStore,
  parseClockStart,
  saveClockState,
  loadClockState,
  MAX_CLOCK_SEGMENTS,
  ClockError,
} from "../src/session/clocks.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SRC = "GM chat message m1";

function startClock(
  store: ReturnType<typeof emptyClockStore>,
  name = "the pursuit",
  total = 4,
  consequence?: string,
) {
  return createClock(store, { name, total, consequence, source: SRC });
}

describe("createClock", () => {
  it("creates a running clock with a create history entry", () => {
    const { store, clock } = startClock(emptyClockStore(), "the pursuit", 4, "The guards arrive.");
    expect(clock.id).toBe("the-pursuit");
    expect(clock.status).toBe("running");
    expect(clock.filled).toBe(0);
    expect(clock.total).toBe(4);
    expect(clock.consequence).toBe("The guards arrive.");
    expect(clock.history).toHaveLength(1);
    expect(clock.history[0].kind).toBe("create");
    expect(clock.history[0].source).toBe(SRC);
    expect(getClock(store, "the-pursuit")).toBeDefined();
  });

  it("two clocks with the same name do not collide", () => {
    let store = emptyClockStore();
    const a = createClock(store, { name: "the pursuit", total: 4, source: SRC });
    store = a.store;
    const b = createClock(store, { name: "The Pursuit", total: 6, source: SRC });
    store = b.store;
    expect(a.clock.id).toBe("the-pursuit");
    expect(b.clock.id).toBe("the-pursuit-2");
    expect(findClocksByName(store, "the pursuit")).toHaveLength(2);
    expect(listClocks(store)).toHaveLength(2);
  });

  it("rejects an empty name, a bad segment count, and a missing source", () => {
    const store = emptyClockStore();
    expect(() => createClock(store, { name: "  ", total: 4, source: SRC })).toThrow(ClockError);
    expect(() => createClock(store, { name: "x", total: 0, source: SRC })).toThrow(ClockError);
    expect(() => createClock(store, { name: "x", total: MAX_CLOCK_SEGMENTS + 1, source: SRC })).toThrow(ClockError);
    expect(() => createClock(store, { name: "x", total: 2.5, source: SRC })).toThrow(ClockError);
    expect(() => createClock(store, { name: "x", total: 4, source: "  " })).toThrow(ClockError);
  });
});

describe("tickClock", () => {
  it("advances one segment by default, and by N when asked", () => {
    let store = emptyClockStore();
    const c = startClock(store, "the pursuit", 4);
    store = c.store;
    const t1 = tickClock(store, "the-pursuit", { source: "round 1" });
    expect(t1.clock.filled).toBe(1);
    expect(t1.fired).toBe(false);
    expect(t1.noop).toBe(false);
    const t2 = tickClock(t1.store, "the-pursuit", { by: 2, source: "round 2" });
    expect(t2.clock.filled).toBe(3);
    expect(t2.clock.history.map((h) => h.kind)).toEqual(["create", "tick", "tick"]);
  });

  it("fires exactly once when the last segment fills, and never ticks again", () => {
    let store = emptyClockStore();
    const c = startClock(store, "the pursuit", 2, "The guards arrive.");
    store = c.store;
    const fired = tickClock(store, "the-pursuit", { by: 2, source: "round 1" });
    expect(fired.fired).toBe(true);
    expect(fired.consequence).toBe("The guards arrive.");
    expect(fired.clock.status).toBe("fired");
    expect(fired.clock.filled).toBe(2);
    expect(() => tickClock(fired.store, "the-pursuit", { source: "round 2" })).toThrow(
      /is fired — only a running clock ticks/,
    );
    expect(() => resolveClock(fired.store, "the-pursuit", { source: SRC })).not.toThrow();
  });

  it("rejects a tick of 0 or a negative tick", () => {
    let store = emptyClockStore();
    store = startClock(store).store;
    expect(() => tickClock(store, "the-pursuit", { by: 0, source: SRC })).toThrow(ClockError);
    expect(() => tickClock(store, "the-pursuit", { by: -1, source: SRC })).toThrow(ClockError);
  });

  it("a re-poll of the same round is a no-op; an earlier round is an error", () => {
    let store = emptyClockStore();
    store = startClock(store, "the pursuit", 4).store;
    const t1 = tickClock(store, "the-pursuit", { source: "round 3", round: 3 });
    expect(t1.clock.filled).toBe(1);
    const again = tickClock(t1.store, "the-pursuit", { source: "round 3 again", round: 3 });
    expect(again.noop).toBe(true);
    expect(again.clock.filled).toBe(1);
    expect(again.clock.history).toHaveLength(2);
    expect(() =>
      tickClock(again.store, "the-pursuit", { source: "round 2", round: 2 }),
    ).toThrow(/already ticked on round 3/);
  });

  it("resolves by id, and by name only when the name is unambiguous", () => {
    let store = emptyClockStore();
    store = startClock(store, "the pursuit", 4).store;
    store = startClock(store, "the pursuit", 6).store;
    expect(() => tickClock(store, "the pursuit", { source: SRC })).toThrow(
      /matches more than one clock: the-pursuit, the-pursuit-2/,
    );
    const byId = tickClock(store, "the-pursuit-2", { source: SRC });
    expect(byId.clock.id).toBe("the-pursuit-2");
    expect(byId.clock.filled).toBe(1);
    expect(() => tickClock(store, "the ritual", { source: SRC })).toThrow(
      /No clock named "the ritual"/,
    );
  });
});

describe("fillClock", () => {
  it("fills to an absolute count and fires at the total", () => {
    let store = emptyClockStore();
    store = startClock(store, "the pursuit", 4, "Caught.").store;
    const filled = fillClock(store, "the-pursuit", { to: 4, source: SRC });
    expect(filled.clock.filled).toBe(4);
    expect(filled.fired).toBe(true);
    expect(filled.consequence).toBe("Caught.");
  });

  it("only moves forward, and never past the total", () => {
    let store = emptyClockStore();
    store = startClock(store, "the pursuit", 4).store;
    const f1 = fillClock(store, "the-pursuit", { to: 2, source: SRC });
    expect(() => fillClock(f1.store, "the-pursuit", { to: 2, source: SRC })).toThrow(
      /only moves forward/,
    );
    expect(() => fillClock(f1.store, "the-pursuit", { to: 1, source: SRC })).toThrow(
      /only moves forward/,
    );
    expect(() => fillClock(f1.store, "the-pursuit", { to: 5, source: SRC })).toThrow(
      /has 4 segments/,
    );
  });
});

describe("resolveClock / resetClock / dropClock", () => {
  it("only a fired clock resolves, and only once", () => {
    let store = emptyClockStore();
    store = startClock(store, "the pursuit", 2).store;
    expect(() => resolveClock(store, "the-pursuit", { source: SRC })).toThrow(
      /is running — it still has 2 segments left/,
    );
    const fired = tickClock(store, "the-pursuit", { by: 2, source: SRC });
    const resolved = resolveClock(fired.store, "the-pursuit", { source: "GM delivered it" });
    expect(resolved.clock.status).toBe("resolved");
    expect(() => resolveClock(resolved.store, "the-pursuit", { source: SRC })).toThrow(
      /is resolved — only a fired clock can be resolved/,
    );
  });

  it("reset winds a fired clock back to 0 and running, keeping the history", () => {
    let store = emptyClockStore();
    store = startClock(store, "the pursuit", 2).store;
    const fired = tickClock(store, "the-pursuit", { by: 2, source: SRC });
    const reset = resetClock(fired.store, "the-pursuit", { source: "GM rewinds" });
    expect(reset.clock.status).toBe("running");
    expect(reset.clock.filled).toBe(0);
    expect(reset.clock.firedRound).toBeUndefined();
    expect(reset.clock.history.map((h) => h.kind)).toEqual([
      "create",
      "tick",
      "reset",
    ]);
    const again = tickClock(reset.store, "the-pursuit", { source: SRC });
    expect(again.clock.filled).toBe(1);
  });

  it("drop closes a running or fired clock, and a dropped clock stays dropped", () => {
    let store = emptyClockStore();
    store = startClock(store, "the pursuit", 4).store;
    const dropped = dropClock(store, "the-pursuit", { source: "GM calls it off" });
    expect(dropped.clock.status).toBe("dropped");
    expect(() => dropClock(dropped.store, "the-pursuit", { source: SRC })).toThrow(
      /is already dropped/,
    );
    expect(() => tickClock(dropped.store, "the-pursuit", { source: SRC })).toThrow(
      /is dropped — only a running clock ticks/,
    );
  });
});

describe("advanceClocksToRound", () => {
  it("ticks every running clock once per new round, and fires at zero", () => {
    let store = emptyClockStore();
    store = startClock(store, "the train leaves", 6, "The train pulls out.").store;
    store = startClock(store, "the pursuit", 2, "The guards arrive.").store;
    const r1 = advanceClocksToRound(store, { combatId: "c1", round: 1, source: "round 1" });
    expect(r1.events).toHaveLength(2);
    expect(r1.events.every((e) => e.fired === false)).toBe(true);
    const r2 = advanceClocksToRound(r1.store, { combatId: "c1", round: 2, source: "round 2" });
    const pursuit = r2.events.find((e) => e.clock.id === "the-pursuit");
    expect(pursuit?.fired).toBe(true);
    expect(pursuit?.consequence).toBe("The guards arrive.");
    const train = getClock(r2.store, "the-train-leaves");
    expect(train?.filled).toBe(2);
    expect(train?.status).toBe("running");
  });

  it("re-polling the same round is a no-op, and a skipped round ticks only once", () => {
    let store = emptyClockStore();
    store = startClock(store, "the pursuit", 4).store;
    const r1 = advanceClocksToRound(store, { combatId: "c1", round: 1, source: "round 1" });
    const same = advanceClocksToRound(r1.store, { combatId: "c1", round: 1, source: "round 1 again" });
    expect(same.events).toHaveLength(0);
    expect(getClock(same.store, "the-pursuit")?.filled).toBe(1);
    const jump = advanceClocksToRound(same.store, { combatId: "c1", round: 4, source: "round 4" });
    expect(jump.events).toHaveLength(1);
    expect(getClock(jump.store, "the-pursuit")?.filled).toBe(2);
  });

  it("a new combat resets the round tracking, so round 1 ticks again", () => {
    let store = emptyClockStore();
    store = startClock(store, "the pursuit", 4).store;
    const r1 = advanceClocksToRound(store, { combatId: "c1", round: 3, source: "round 3" });
    expect(getClock(r1.store, "the-pursuit")?.filled).toBe(1);
    const r2 = advanceClocksToRound(r1.store, { combatId: "c2", round: 1, source: "new combat" });
    expect(r2.events).toHaveLength(1);
    expect(getClock(r2.store, "the-pursuit")?.filled).toBe(2);
    expect(r2.store.roundCursor).toEqual({ combatId: "c2", round: 1 });
  });

  it("does not touch fired, resolved, or dropped clocks", () => {
    let store = emptyClockStore();
    store = startClock(store, "the pursuit", 1).store;
    const fired = tickClock(store, "the-pursuit", { source: SRC });
    const advanced = advanceClocksToRound(fired.store, {
      combatId: "c1",
      round: 1,
      source: "round 1",
    });
    expect(advanced.events).toHaveLength(0);
    expect(getClock(advanced.store, "the-pursuit")?.status).toBe("fired");
  });
});

describe("parseClockStart", () => {
  it("parses the issue's phrasings", () => {
    expect(parseClockStart("start a 6-segment clock: the pursuit")).toEqual({
      kind: "create",
      name: "the pursuit",
      total: 6,
    });
    expect(parseClockStart("start a clock: the ritual completes, 4 segments")).toEqual({
      kind: "create",
      name: "the ritual completes",
      total: 4,
    });
    expect(parseClockStart("start a deadline clock for the train escape, 8 segments")).toEqual({
      kind: "create",
      name: "the train escape",
      total: 8,
    });
  });

  it("takes the consequence from an at-zero tail", () => {
    expect(
      parseClockStart("start a 4-segment clock: the guards arrive — at zero: the alarm sounds"),
    ).toEqual({
      kind: "create",
      name: "the guards arrive",
      total: 4,
      consequence: "the alarm sounds",
    });
  });

  it("clarifies instead of guessing, and returns null for non-clock lines", () => {
    expect(parseClockStart("start a clock: the pursuit")).toEqual({
      kind: "clarify",
      question: 'How many segments should the "the pursuit" clock have?',
    });
    expect(parseClockStart("start a 6-segment clock")).toEqual({
      kind: "clarify",
      question: "What is the 6-segment clock called?",
    });
    expect(parseClockStart("start a 20-segment clock: the pursuit")).toEqual({
      kind: "clarify",
      question: "A clock has 1–12 segments — how many for this one?",
    });
    expect(parseClockStart("the ogre is dead")).toBeNull();
    expect(parseClockStart("what is the brief?")).toBeNull();
    expect(parseClockStart("the clock on the wall is broken")).toBeNull();
  });
});

describe("renderClock", () => {
  it("renders the bar, the count, and the rounds left", () => {
    let store = emptyClockStore();
    store = startClock(store, "the pursuit", 4, "The guards arrive.").store;
    const ticked = tickClock(store, "the-pursuit", { source: SRC });
    expect(clockBar(ticked.clock)).toBe("█░░░");
    expect(renderClock(ticked.clock)).toBe(
      "🕐 the pursuit [█░░░] 1/4 — 3 rounds left — at zero: The guards arrive.",
    );
  });

  it("renders fired, resolved, and dropped distinctly", () => {
    let store = emptyClockStore();
    store = startClock(store, "the pursuit", 1, "Caught.").store;
    const fired = tickClock(store, "the-pursuit", { source: SRC });
    expect(renderClock(fired.clock)).toBe("⏰ the pursuit hit zero [█] 1/1 — Caught.");
    const resolved = resolveClock(fired.store, "the-pursuit", { source: SRC });
    expect(renderClock(resolved.clock)).toBe("✅ the pursuit resolved [█] 1/1 — Caught.");
    let store2 = emptyClockStore();
    store2 = startClock(store2, "the ritual", 6).store;
    const dropped = dropClock(store2, "the-ritual", { source: SRC });
    expect(renderClock(dropped.clock)).toBe("🚫 the ritual dropped [░░░░░░] 0/6");
    expect(renderClockStore(emptyClockStore())).toBe("No clocks.");
  });
});

describe("serialize / parse / state file", () => {
  it("round-trips a store with history and a round cursor", () => {
    let store = emptyClockStore();
    store = startClock(store, "the pursuit", 2, "Caught.").store;
    const advanced = advanceClocksToRound(store, { combatId: "c1", round: 1, source: "round 1" });
    const json = serializeClockStore(advanced.store);
    const parsed = parseClockStore(json);
    expect(parsed).not.toBeNull();
    expect(parsed?.clocks[0].history).toHaveLength(2);
    expect(parsed?.roundCursor).toEqual({ combatId: "c1", round: 1 });
    expect(isClockStore(parsed)).toBe(true);
  });

  it("rejects bad shapes instead of guessing", () => {
    expect(parseClockStore("not json")).toBeNull();
    expect(parseClockStore(JSON.stringify({ version: 2, clocks: [] }))).toBeNull();
    expect(parseClockStore(JSON.stringify({ version: 1, clocks: [{ id: "x" }] }))).toBeNull();
    expect(
      parseClockStore(
        JSON.stringify({
          version: 1,
          clocks: [
            {
              id: "x",
              name: "x",
              total: 2,
              filled: 3,
              status: "running",
              source: "s",
              history: [],
            },
          ],
        }),
      ),
    ).toBeNull();
    // A round cursor of 0 is valid: the combat was just seen.
    expect(
      isClockStore({ version: 1, clocks: [], roundCursor: { combatId: "c1", round: 0 } }),
    ).toBe(true);
  });

  it("saves and loads the state file; a corrupt file loads as null", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clocks-"));
    try {
      const file = path.join(dir, "state.json");
      let store = emptyClockStore();
      store = startClock(store, "the pursuit", 4).store;
      saveClockState(store, file);
      const loaded = loadClockState(file);
      expect(loaded?.clocks[0].id).toBe("the-pursuit");
      fs.writeFileSync(file, "{not json", "utf-8");
      expect(loadClockState(file)).toBeNull();
      expect(loadClockState(path.join(dir, "missing.json"))).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
