/**
 * Living village tests (BRA-227) — pure core: schedule resolution,
 * round walking, stepping off and returning, background-event
 * progression, memory changing a later reaction, relationship-gated
 * responses, validation, serialization. No Foundry connection: the
 * live layer (token movement, chat, JournalEntry) is live-tested
 * next session.
 *
 * The villagers below are FIXTURES written for these tests — Mara
 * the baker and Old Fen the miller, with backstories authored here.
 * They are not campaign canon; a real village's backstories come
 * from the GM or Muse at the table, and the core quotes whatever
 * was stored, never invents.
 */
import { describe, it, expect } from "bun:test";
import {
  createVillage,
  addVillager,
  addBackgroundEvent,
  positionAtHour,
  positionsAtHour,
  advanceVillageToHour,
  engageVillager,
  disengageVillager,
  remember,
  adjustRelationship,
  relationshipWith,
  respondTo,
  bandFor,
  eventStageAt,
  renderVillage,
  serializeVillage,
  parseVillage,
  VillageError,
  type VillageStore,
  type Villager,
} from "../src/session/village.js";

const SRC = "test-fixture";

/** Mara: market in the morning, bakery in the afternoon, home at night. */
function mara(): Omit<Villager, "relationships" | "memories" | "engagement"> {
  return {
    id: "mara-baker",
    name: "Mara",
    role: "baker",
    backstory:
      "Bakes for the village since her mother died. Her brother Tomas left for Otari three years ago and never wrote back.",
    schedule: [
      {
        name: "morning market",
        activity: "selling bread at the market stall",
        startHour: 8,
        endHour: 12,
        waypoints: [
          { x: 2, y: 2 },
          { x: 5, y: 2 },
          { x: 8, y: 2 },
          { x: 8, y: 5 },
        ],
      },
      {
        name: "afternoon bakery",
        activity: "baking at the ovens",
        startHour: 13,
        endHour: 18,
        waypoints: [
          { x: 8, y: 5 },
          { x: 6, y: 7 },
          { x: 4, y: 7 },
        ],
      },
      {
        name: "evening home",
        activity: "resting at home",
        startHour: 18,
        endHour: 22,
        waypoints: [
          { x: 4, y: 7 },
          { x: 2, y: 8 },
        ],
      },
    ],
  };
}

/** Old Fen: the mill, all day, with a midday walk to the well. */
function fen(): Omit<Villager, "relationships" | "memories" | "engagement"> {
  return {
    id: "fen-miller",
    name: "Old Fen",
    role: "miller",
    backstory:
      "Has run the mill for forty years. He still blames himself for the mill fire that took his wife's loom, and he does not talk about it.",
    schedule: [
      {
        name: "mill work",
        activity: "grinding grain at the mill",
        startHour: 6,
        endHour: 20,
        waypoints: [
          { x: 10, y: 10 },
          { x: 12, y: 10 },
          { x: 12, y: 12 },
        ],
      },
    ],
  };
}

function millFireEvent() {
  return {
    id: "mill-fire",
    name: "the mill fire",
    description: "A spark catches in the old mill's grain store.",
    stages: [
      { atHour: 30, text: "Smoke curls from the mill's grain store." },
      { atHour: 32, text: "Flames take the mill's roof.", announce: "Flames take the mill's roof — smoke is visible across the village." },
      { atHour: 36, text: "The mill is a blackened shell. The village gathers in the square." },
    ],
  };
}

function villageWithMara(): VillageStore {
  return addVillager(createVillage("Oatfield", { source: SRC }), mara(), SRC);
}

describe("createVillage / addVillager", () => {
  it("starts empty at hour 0 with a create-village history entry", () => {
    const store = createVillage("Oatfield", { source: SRC });
    expect(store.villageName).toBe("Oatfield");
    expect(store.hourCursor).toBe(0);
    expect(store.villagers).toEqual([]);
    expect(store.history).toHaveLength(1);
    expect(store.history[0].kind).toBe("create-village");
  });

  it("adds a villager and records it, input untouched", () => {
    const store = villageWithMara();
    expect(store.villagers).toHaveLength(1);
    expect(store.villagers[0].engagement).toBeNull();
    expect(store.villagers[0].memories).toEqual([]);
    expect(store.history.at(-1)?.kind).toBe("add-villager");
  });

  it("rejects an empty backstory — the core never generates one", () => {
    const store = createVillage("Oatfield", { source: SRC });
    expect(() =>
      addVillager(store, { ...mara(), backstory: "   " }, SRC),
    ).toThrow(VillageError);
  });

  it("rejects a duplicate villager id", () => {
    const store = villageWithMara();
    expect(() => addVillager(store, mara(), SRC)).toThrow(/already exists/);
  });

  it("rejects a schedule with no legs, overlapping legs, or a leg crossing midnight", () => {
    const store = createVillage("Oatfield", { source: SRC });
    expect(() => addVillager(store, { ...mara(), schedule: [] }, SRC)).toThrow(/at least one schedule leg/);
    expect(() =>
      addVillager(store, {
        ...mara(),
        schedule: [
          { name: "a", activity: "x", startHour: 8, endHour: 12, waypoints: [{ x: 0, y: 0 }, { x: 1, y: 0 }] },
          { name: "b", activity: "y", startHour: 11, endHour: 14, waypoints: [{ x: 0, y: 0 }, { x: 1, y: 0 }] },
        ],
      }, SRC),
    ).toThrow(/overlap/);
    expect(() =>
      addVillager(store, {
        ...mara(),
        schedule: [
          { name: "night", activity: "x", startHour: 22, endHour: 2, waypoints: [{ x: 0, y: 0 }, { x: 1, y: 0 }] },
        ],
      }, SRC),
    ).toThrow(/never crosses midnight/);
  });

  it("rejects a leg with one waypoint or two identical consecutive waypoints", () => {
    const store = createVillage("Oatfield", { source: SRC });
    expect(() =>
      addVillager(store, {
        ...mara(),
        schedule: [{ name: "a", activity: "x", startHour: 8, endHour: 12, waypoints: [{ x: 0, y: 0 }] }],
      }, SRC),
    ).toThrow(/at least 2 waypoints/);
    expect(() =>
      addVillager(store, {
        ...mara(),
        schedule: [{ name: "a", activity: "x", startHour: 8, endHour: 12, waypoints: [{ x: 0, y: 0 }, { x: 0, y: 0 }] }],
      }, SRC),
    ).toThrow(/same cell/);
  });
});

describe("positionAtHour — round walking", () => {
  it("walks one waypoint per equal slice of the leg", () => {
    const store = villageWithMara();
    const v = store.villagers[0];
    // Morning market: 8..12, four waypoints — one per hour.
    expect(positionAtHour(v, 8)).toMatchObject({ x: 2, y: 2, legName: "morning market" });
    expect(positionAtHour(v, 9)).toMatchObject({ x: 5, y: 2 });
    expect(positionAtHour(v, 10)).toMatchObject({ x: 8, y: 2 });
    expect(positionAtHour(v, 11)).toMatchObject({ x: 8, y: 5 });
  });

  it("waits at the first waypoint before the day's first leg", () => {
    const store = villageWithMara();
    const v = store.villagers[0];
    expect(positionAtHour(v, 5)).toMatchObject({ x: 2, y: 2 });
  });

  it("rests at the last waypoint after the day's last leg", () => {
    const store = villageWithMara();
    const v = store.villagers[0];
    expect(positionAtHour(v, 23)).toMatchObject({ x: 2, y: 8 });
  });

  it("stays at the previous leg's last waypoint in a gap between legs", () => {
    const store = villageWithMara();
    const v = store.villagers[0];
    // Gap 12..13: morning market ended at (8,5); bakery starts at 13.
    expect(positionAtHour(v, 12)).toMatchObject({ x: 8, y: 5 });
  });

  it("resolves the same hour the same way every time, on any day", () => {
    const store = villageWithMara();
    const v = store.villagers[0];
    // Day 1 hour 9 == day 3 hour 9: absolute hour 33 == 81.
    expect(positionAtHour(v, 9)).toEqual(positionAtHour(v, 33));
    expect(positionAtHour(v, 33)).toEqual(positionAtHour(v, 81));
  });

  it("positionsAtHour reports every villager at once", () => {
    let store = villageWithMara();
    store = addVillager(store, fen(), SRC);
    const at9 = positionsAtHour(store, 9);
    expect(at9).toHaveLength(2);
    expect(at9.find((p) => p.villagerId === "mara-baker")).toMatchObject({ x: 5, y: 2 });
    // Fen's mill leg is 6..20 with 3 waypoints — one per equal slice
    // (~4.7h each), so at hour 9 he is still on the first waypoint.
    expect(at9.find((p) => p.villagerId === "fen-miller")).toMatchObject({ x: 10, y: 10 });
  });
});

describe("advanceVillageToHour — the tick", () => {
  it("advancing to the same hour is a no-op", () => {
    const store = villageWithMara();
    const { store: next, events } = advanceVillageToHour(store, 0, SRC);
    expect(next).toBe(store);
    expect(events).toEqual([]);
  });

  it("rejects going backwards in time", () => {
    const { store } = advanceVillageToHour(villageWithMara(), 10, SRC);
    expect(() => advanceVillageToHour(store, 9, SRC)).toThrow(/does not go backwards/);
  });

  it("reports moves as start-vs-end positions only", () => {
    const store = villageWithMara();
    const { store: next, events } = advanceVillageToHour(store, 10, SRC);
    expect(next.hourCursor).toBe(10);
    const moved = events.filter((e) => e.kind === "moved");
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ villagerId: "mara-baker", hour: 10 });
    expect(moved[0].detail).toMatch(/\(2, 2\) to \(8, 2\)/);
  });

  it("a week unobserved lands exactly: positions and event stage are pure functions of the hour", () => {
    let store = villageWithMara();
    store = addBackgroundEvent(store, millFireEvent(), SRC);
    // Hour 177 = day 7, 09:00 — Mara is mid-round (not midnight, where
    // start and end positions would coincide and no move is reported).
    const { store: next, events } = advanceVillageToHour(store, 177, SRC);
    expect(next.hourCursor).toBe(177);
    const maraPos = positionAtHour(next.villagers[0], 177);
    expect(maraPos).toMatchObject({ x: 5, y: 2 });
    // The mill fire ran all three stages while nobody watched.
    const stage = eventStageAt(next.events[0], 177);
    expect(stage?.text).toMatch(/blackened shell/);
    const stageEvents = events.filter((e) => e.kind === "event-stage");
    expect(stageEvents).toHaveLength(3);
    expect(stageEvents.map((e) => e.hour)).toEqual([30, 32, 36]);
    // Moves: one per villager, not one per hour per villager.
    expect(events.filter((e) => e.kind === "moved")).toHaveLength(1);
  });

  it("requires a source", () => {
    expect(() => advanceVillageToHour(villageWithMara(), 5, "  ")).toThrow(/needs a source/);
  });
});

describe("background events", () => {
  it("stage is a pure function of the hour; null before the first stage", () => {
    const store = addBackgroundEvent(villageWithMara(), millFireEvent(), SRC);
    const event = store.events[0];
    expect(eventStageAt(event, 29)).toBeNull();
    expect(eventStageAt(event, 30)?.text).toMatch(/Smoke curls/);
    expect(eventStageAt(event, 33)?.text).toMatch(/Flames take/);
    expect(eventStageAt(event, 100)?.text).toMatch(/blackened shell/);
  });

  it("rejects stages out of order or an event with no stages", () => {
    const store = villageWithMara();
    expect(() =>
      addBackgroundEvent(store, { id: "x", name: "x", description: "x", stages: [] }, SRC),
    ).toThrow(/at least one stage/);
    expect(() =>
      addBackgroundEvent(store, {
        id: "x",
        name: "x",
        description: "x",
        stages: [
          { atHour: 10, text: "a" },
          { atHour: 10, text: "b" },
        ],
      }, SRC),
    ).toThrow(/strictly increasing/);
  });

  it("rejects a duplicate event id", () => {
    const store = addBackgroundEvent(villageWithMara(), millFireEvent(), SRC);
    expect(() => addBackgroundEvent(store, millFireEvent(), SRC)).toThrow(/already exists/);
  });
});

describe("engagement — stepping off the path", () => {
  it("an engaged villager stands where the conversation caught them, not on the schedule", () => {
    let store = villageWithMara();
    store = advanceVillageToHour(store, 9, SRC).store;
    store = engageVillager(store, "mara-baker", "valeros", "chat:msg-1");
    // At hour 10 the schedule says (8,2); the engaged Mara stays at (5,2).
    const pos = positionAtHour(store.villagers[0], 10);
    expect(pos).toMatchObject({ x: 5, y: 2, engaged: true, activity: "talking", legName: null });
  });

  it("disengaging returns the villager to the schedule position for the current hour", () => {
    let store = villageWithMara();
    store = advanceVillageToHour(store, 9, SRC).store;
    store = engageVillager(store, "mara-baker", "valeros", "chat:msg-1");
    store = advanceVillageToHour(store, 10, SRC).store;
    store = disengageVillager(store, "mara-baker", "valeros", "chat:msg-2");
    const pos = positionAtHour(store.villagers[0], 10);
    expect(pos).toMatchObject({ x: 8, y: 2, engaged: false, legName: "morning market" });
  });

  it("a second PC joins the same conversation; the last one out ends it", () => {
    let store = villageWithMara();
    store = engageVillager(store, "mara-baker", "valeros", "chat:msg-1");
    store = engageVillager(store, "mara-baker", "merisiel", "chat:msg-2");
    const eng = store.villagers[0].engagement!;
    expect(eng.by).toBe("valeros");
    expect(eng.participants).toEqual(["valeros", "merisiel"]);
    store = disengageVillager(store, "mara-baker", "valeros", "chat:msg-3");
    expect(store.villagers[0].engagement).not.toBeNull();
    expect(store.villagers[0].engagement!.participants).toEqual(["merisiel"]);
    store = disengageVillager(store, "mara-baker", "merisiel", "chat:msg-4");
    expect(store.villagers[0].engagement).toBeNull();
  });

  it("an engagement past its hour limit expires on the tick and the villager returns", () => {
    let store = villageWithMara();
    store = engageVillager(store, "mara-baker", "valeros", "chat:msg-1");
    // Default maxHours is 1: engaged at hour 0, expired by hour 1.
    const { store: next, events } = advanceVillageToHour(store, 2, SRC);
    expect(next.villagers[0].engagement).toBeNull();
    const returns = events.filter((e) => e.kind === "return");
    expect(returns).toHaveLength(1);
    expect(returns[0]).toMatchObject({ villagerId: "mara-baker", hour: 1 });
  });

  it("a longer maxHours holds the villager until its limit", () => {
    let store = villageWithMara();
    store = engageVillager(store, "mara-baker", "valeros", "chat:msg-1", { maxHours: 3 });
    const { store: next } = advanceVillageToHour(store, 2, SRC);
    expect(next.villagers[0].engagement).not.toBeNull();
    const later = advanceVillageToHour(next, 3, SRC);
    expect(later.store.villagers[0].engagement).toBeNull();
  });

  it("engaging an unknown villager throws, naming the village's villagers", () => {
    expect(() => engageVillager(villageWithMara(), "nobody", "valeros", SRC)).toThrow(/No villager "nobody"/);
  });

  it("disengaging when not engaged is a no-op", () => {
    const store = villageWithMara();
    expect(disengageVillager(store, "mara-baker", "valeros", SRC)).toBe(store);
  });
});

describe("memory + relationship — reactions that change", () => {
  it("a stranger is neutral; the response quotes the stored backstory verbatim", () => {
    const store = villageWithMara();
    const r = respondTo(store, "mara-baker", "valeros");
    expect(r.relationship).toBe(0);
    expect(r.disposition).toBe(0);
    expect(r.band).toBe("neutral");
    expect(r.backstory).toBe(
      "Bakes for the village since her mother died. Her brother Tomas left for Otari three years ago and never wrote back.",
    );
    expect(r.memories).toEqual([]);
  });

  it("a kind memory warms a later reaction; a cruel one chills it", () => {
    let store = villageWithMara();
    store = remember(
      store,
      "mara-baker",
      { subject: "valeros", text: "Valeros helped rebuild the bakery ovens after the storm.", sentiment: 2, topic: "ovens" },
      "chat:msg-9",
    );
    const warm = respondTo(store, "mara-baker", "valeros");
    expect(warm.disposition).toBe(2);
    expect(warm.band).toBe("warm");
    expect(warm.memories).toHaveLength(1);
    expect(warm.memories[0].text).toMatch(/helped rebuild the bakery ovens/);

    store = remember(
      store,
      "mara-baker",
      { subject: "merisiel", text: "Merisiel insulted Mara's bread in front of the market.", sentiment: -2 },
      "chat:msg-10",
    );
    const cold = respondTo(store, "mara-baker", "merisiel");
    expect(cold.disposition).toBe(-2);
    expect(cold.band).toBe("wary");
    // Valeros is unaffected by what Merisiel did.
    expect(respondTo(store, "mara-baker", "valeros").disposition).toBe(2);
  });

  it("memory sentiment is capped: three +2 memories move a response by +3, not +6", () => {
    let store = villageWithMara();
    for (let i = 0; i < 3; i++) {
      store = remember(
        store,
        "mara-baker",
        { subject: "valeros", text: `Kind deed ${i + 1}.`, sentiment: 2 },
        `chat:msg-${i}`,
      );
    }
    expect(respondTo(store, "mara-baker", "valeros").disposition).toBe(3);
  });

  it("relationship changes are gated: reason and source required, scores clamp", () => {
    let store = villageWithMara();
    store = adjustRelationship(store, "mara-baker", "valeros", 4, "Valeros saved Mara's brother's letter from the fire.", "chat:msg-5");
    expect(relationshipWith(store.villagers[0], "valeros")).toBe(4);
    expect(respondTo(store, "mara-baker", "valeros").band).toBe("friendly");
    expect(() => adjustRelationship(store, "mara-baker", "valeros", 1, "", SRC)).toThrow(/needs a reason/);
    expect(() => adjustRelationship(store, "mara-baker", "valeros", 1, "r", " ")).toThrow(/needs a source/);
    expect(() => adjustRelationship(store, "mara-baker", "valeros", 0, "r", SRC)).toThrow(/non-zero/);
    store = adjustRelationship(store, "mara-baker", "valeros", 5, "More kindness.", SRC);
    expect(relationshipWith(store.villagers[0], "valeros")).toBe(5); // clamped, not 9
  });

  it("charisma moves the band: a charming stranger reads warmer than a gruff one", () => {
    const store = villageWithMara();
    expect(respondTo(store, "mara-baker", "valeros", { pcCharismaMod: 2 }).band).toBe("warm");
    expect(respondTo(store, "mara-baker", "valeros", { pcCharismaMod: -2 }).band).toBe("wary");
  });

  it("a topic-scoped memory only counts when the topic is asked about", () => {
    let store = villageWithMara();
    store = addVillager(store, fen(), SRC);
    store = remember(
      store,
      "fen-miller",
      { subject: "mill-fire", text: "Fen watched the mill burn and said nothing.", sentiment: -2, topic: "mill-fire" },
      "chat:msg-7",
    );
    // Fen has no memories about Valeros, and the mill-fire memory is
    // about the event, not the PC — it does not count unprompted.
    expect(respondTo(store, "fen-miller", "valeros").disposition).toBe(0);
    // Asked about the mill fire, it counts.
    const asked = respondTo(store, "fen-miller", "valeros", { topic: "mill-fire" });
    expect(asked.disposition).toBe(-2);
    expect(asked.memories).toHaveLength(1);
  });

  it("remember without a source throws — a memory nobody stated never enters the store", () => {
    expect(() =>
      remember(villageWithMara(), "mara-baker", { subject: "valeros", text: "Something.", sentiment: 1 }, " "),
    ).toThrow(/needs a source/);
  });

  it("band edges: -5 hostile, -1 wary, 1 neutral, 3 warm, 5 friendly", () => {
    expect(bandFor(-5)).toBe("hostile");
    expect(bandFor(-4)).toBe("hostile");
    expect(bandFor(-1)).toBe("wary");
    expect(bandFor(1)).toBe("neutral");
    expect(bandFor(3)).toBe("warm");
    expect(bandFor(5)).toBe("friendly");
  });
});

describe("history — append-only audit", () => {
  it("every mutation appends history with hour and source; nothing edits it", () => {
    let store = villageWithMara();
    const before = store.history.length;
    store = remember(store, "mara-baker", { subject: "valeros", text: "Helped.", sentiment: 1 }, "chat:msg-1");
    store = adjustRelationship(store, "mara-baker", "valeros", 1, "Helped.", "chat:msg-1");
    expect(store.history.length).toBe(before + 2);
    expect(store.history.at(-2)?.kind).toBe("remember");
    expect(store.history.at(-1)?.kind).toBe("relationship");
    for (const h of store.history) {
      expect(typeof h.source).toBe("string");
      expect(h.source.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("render + serialize", () => {
  it("renderVillage names positions, engagements, and event stages", () => {
    let store = villageWithMara();
    store = addBackgroundEvent(store, millFireEvent(), SRC);
    const text = renderVillage(store, 9);
    expect(text).toMatch(/Oatfield — in-game hour 9/);
    expect(text).toMatch(/Mara \(baker\): selling bread at the market stall at \(5, 2\)/);
    expect(text).toMatch(/the mill fire: not yet begun/);
    const later = renderVillage(store, 33);
    expect(later).toMatch(/Flames take the mill's roof/);
  });

  it("serialize/parse round-trips the whole store, including history and engagement", () => {
    let store = villageWithMara();
    store = addVillager(store, fen(), SRC);
    store = addBackgroundEvent(store, millFireEvent(), SRC);
    store = remember(store, "mara-baker", { subject: "valeros", text: "Helped.", sentiment: 2 }, "chat:msg-1");
    store = advanceVillageToHour(store, 5, SRC).store;
    // Engage AFTER the advance: an engagement started at hour 0 would
    // have expired by hour 5 (default maxHours 1).
    store = engageVillager(store, "fen-miller", "merisiel", "chat:msg-2");
    const parsed = parseVillage(serializeVillage(store));
    expect(parsed.villageName).toBe(store.villageName);
    expect(parsed.hourCursor).toBe(5);
    expect(parsed.villagers).toHaveLength(2);
    expect(parsed.villagers[0].memories).toHaveLength(1);
    expect(parsed.villagers[1].engagement?.by).toBe("merisiel");
    expect(parsed.villagers[1].engagement?.sinceHour).toBe(5);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.history).toHaveLength(store.history.length);
    // Positions resolve identically after the round-trip.
    expect(positionAtHour(parsed.villagers[0], 9)).toEqual(positionAtHour(store.villagers[0], 9));
  });

  it("parseVillage rejects bad JSON, a missing backstory, and a memory without a source", () => {
    expect(() => parseVillage("not json")).toThrow(VillageError);
    const store = villageWithMara();
    const noBackstory = JSON.parse(serializeVillage(store)) as Record<string, unknown>;
    (noBackstory.villagers as Record<string, unknown>[])[0].backstory = "";
    expect(() => parseVillage(JSON.stringify(noBackstory))).toThrow(/backstory/);
    const noSource = JSON.parse(serializeVillage(store)) as Record<string, unknown>;
    const withMemory = remember(store, "mara-baker", { subject: "valeros", text: "Helped.", sentiment: 1 }, "chat:msg-1");
    const hacked = JSON.parse(serializeVillage(withMemory)) as Record<string, unknown>;
    ((hacked.villagers as Record<string, unknown>[])[0].memories as Record<string, unknown>[])[0].source = "";
    expect(() => parseVillage(JSON.stringify(hacked))).toThrow(/without a source/);
    void noSource;
  });

  it("all ops are immutable — the input store is never mutated", () => {
    const store = villageWithMara();
    const snapshot = serializeVillage(store);
    engageVillager(store, "mara-baker", "valeros", SRC);
    remember(store, "mara-baker", { subject: "valeros", text: "x", sentiment: 1 }, SRC);
    adjustRelationship(store, "mara-baker", "valeros", 1, "r", SRC);
    advanceVillageToHour(store, 5, SRC);
    expect(serializeVillage(store)).toBe(snapshot);
  });
});
