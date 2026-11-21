/**
 * Chronicle store tests (BRA-232) — pure ops, serialization, recap
 * rendering, and the recap import. No Foundry connection: the live
 * layer (journal pages) is live-tested next session.
 */
import { describe, it, expect } from "bun:test";
import {
  appendEntry,
  resolveThread,
  getEntry,
  queryEntries,
  listOpenThreads,
  listOpenDebts,
  listNames,
  toFloorPlannerChronicle,
  chronicleFacts,
  renderRecap,
  entryToJournalHtml,
  chronicleIndexHtml,
  serializeChronicle,
  parseChronicle,
  recapToChronicleEntries,
  demoChronicle,
  emptyChronicle,
  ChronicleError,
  type ChronicleStore,
  type AddEntryInput,
} from "../src/session/chronicle.js";
import type { Recap } from "../src/session/recap.js";

function seeded(): ChronicleStore {
  let store = emptyChronicle("Menace Under Otari");
  const add = (input: AddEntryInput): void => {
    store = appendEntry(store, input).store;
  };
  add({
    kind: "npc",
    summary: "Ezren joins the party",
    actors: ["Ezren"],
    role: "pc",
    session: "2026-11-19",
    date: "2026-11-19",
    source: "Session recap 2026-11-19",
  });
  add({
    kind: "npc",
    summary: "Valeros joins the party",
    actors: ["Valeros"],
    role: "pc",
    session: "2026-11-19",
    date: "2026-11-19",
    source: "Session recap 2026-11-19",
  });
  add({
    kind: "npc",
    summary: "Zolgran — Xulgath raider",
    actors: ["Zolgran"],
    role: "npc",
    session: "2026-11-19",
    date: "2026-11-19",
    source: "Session recap 2026-11-19",
  });
  add({
    kind: "death",
    summary: "Merisiel fell to Xulgath and Zolgran on the Landing",
    actors: ["Merisiel", "Xulgath", "Zolgran"],
    session: "2026-11-19",
    date: "2026-11-19",
    source: "Session recap 2026-11-19",
  });
  add({
    kind: "thread",
    summary: "The Menace Under Otari — what stirs beneath Otari?",
    actors: ["Zolgran"],
    session: "2026-11-19",
    date: "2026-11-19",
    source: "Beginner Box — session 2026-11-19",
  });
  add({
    kind: "debt",
    summary: "The party owes the Merchant Guild 50 gp for the caravan escort",
    actors: ["Merchant Guild"],
    session: "2026-11-19",
    date: "2026-11-19",
    source: "GM statement 2026-11-19",
  });
  add({
    kind: "decision",
    summary: "The party chose the east gate over the river road",
    actors: ["Ezren", "Valeros"],
    session: "2026-11-19",
    date: "2026-11-19",
    source: "Session recap 2026-11-19",
  });
  return store;
}

describe("appendEntry", () => {
  it("appends with a stable per-kind id and keeps the input store unchanged", () => {
    const before = emptyChronicle();
    const { store, entry } = appendEntry(before, {
      kind: "thread",
      summary: "Who left the mark on the door?",
      source: "GM statement",
    });
    expect(entry.id).toBe("thread-1");
    expect(entry.actors).toEqual([]);
    expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(before.entries).toEqual([]);
    expect(store.entries).toHaveLength(1);
    const second = appendEntry(store, {
      kind: "thread",
      summary: "A second thread",
      source: "GM statement",
    });
    expect(second.entry.id).toBe("thread-2");
  });

  it("trims and dedupes actors", () => {
    const { entry } = appendEntry(emptyChronicle(), {
      kind: "npc",
      summary: "Zolgran returns",
      actors: [" Zolgran ", "Zolgran", "Xulgath"],
      source: "GM statement",
    });
    expect(entry.actors).toEqual(["Zolgran", "Xulgath"]);
  });

  it("rejects an empty summary, a missing source, and an unknown kind", () => {
    expect(() =>
      appendEntry(emptyChronicle(), { kind: "thread", summary: "  ", source: "GM" }),
    ).toThrow(ChronicleError);
    expect(() =>
      appendEntry(emptyChronicle(), { kind: "thread", summary: "A thread", source: "  " }),
    ).toThrow(ChronicleError);
    expect(() =>
      appendEntry(emptyChronicle(), {
        kind: "omen" as never,
        summary: "An omen",
        source: "GM",
      }),
    ).toThrow(ChronicleError);
  });

  it("rejects a resolution without a refId, to a non-thread, or to an unknown id", () => {
    const store = seeded();
    expect(() =>
      appendEntry(store, { kind: "resolution", summary: "Done", source: "GM" }),
    ).toThrow(ChronicleError);
    expect(() =>
      appendEntry(store, {
        kind: "resolution",
        summary: "Done",
        source: "GM",
        refId: "death-1",
      }),
    ).toThrow(ChronicleError);
    expect(() =>
      appendEntry(store, {
        kind: "resolution",
        summary: "Done",
        source: "GM",
        refId: "thread-99",
      }),
    ).toThrow(ChronicleError);
  });

  it("rejects a bad npc role", () => {
    expect(() =>
      appendEntry(emptyChronicle(), {
        kind: "npc",
        summary: "Someone",
        source: "GM",
        role: "dm" as never,
      }),
    ).toThrow(ChronicleError);
  });
});

describe("resolveThread", () => {
  it("appends a resolution and removes the thread from the open list", () => {
    const store = seeded();
    expect(listOpenThreads(store)).toHaveLength(1);
    const { store: next, entry, alreadyResolved } = resolveThread(
      store,
      "thread-1",
      "The menace was a Xulgath warren — cleared.",
      "Session recap 2026-11-20",
    );
    expect(alreadyResolved).toBe(false);
    expect(entry!.kind).toBe("resolution");
    expect(entry!.refId).toBe("thread-1");
    expect(listOpenThreads(next)).toHaveLength(0);
    expect(queryEntries(next, { kind: "thread", status: "resolved" })).toHaveLength(1);
    expect(store.entries).toHaveLength(7); // input untouched
  });

  it("resolving an already-resolved thread is a no-op", () => {
    const store = seeded();
    const first = resolveThread(store, "thread-1", "Cleared.", "GM");
    const second = resolveThread(first.store, "thread-1", "Cleared again.", "GM");
    expect(second.alreadyResolved).toBe(true);
    expect(second.store.entries).toHaveLength(first.store.entries.length);
  });

  it("rejects an unknown id and a non-thread id", () => {
    const store = seeded();
    expect(() => resolveThread(store, "thread-99", "Done.", "GM")).toThrow(ChronicleError);
    expect(() => resolveThread(store, "death-1", "Done.", "GM")).toThrow(ChronicleError);
  });
});

describe("queries", () => {
  it("filters by kind, session, and actor", () => {
    const store = seeded();
    expect(queryEntries(store, { kind: "npc" })).toHaveLength(3);
    expect(queryEntries(store, { session: "2026-11-19" })).toHaveLength(7);
    expect(queryEntries(store, { actor: "Zolgran" })).toHaveLength(3);
    expect(queryEntries(store, { actor: "Ezren" })).toHaveLength(2);
    expect(queryEntries(store, { kind: "death", actor: "Merisiel" })).toHaveLength(1);
  });

  it("lists open debts and names in first-seen order", () => {
    const store = seeded();
    expect(listOpenDebts(store).map((d) => d.id)).toEqual(["debt-1"]);
    expect(listNames(store)).toEqual([
      "Ezren",
      "Valeros",
      "Zolgran",
      "Merisiel",
      "Xulgath",
      "Merchant Guild",
    ]);
  });

  it("getEntry finds by id and returns undefined for unknown ids", () => {
    const store = seeded();
    expect(getEntry(store, "death-1")?.summary).toContain("Merisiel fell");
    expect(getEntry(store, "death-9")).toBeUndefined();
  });
});

describe("toFloorPlannerChronicle", () => {
  it("derives the planner's Chronicle shape from the store", () => {
    const fp = toFloorPlannerChronicle(seeded());
    expect(fp.campaign).toBe("Menace Under Otari");
    expect(fp.partyMembers).toEqual(["Ezren", "Valeros"]);
    expect(fp.keyNpcs).toEqual(["Zolgran"]);
    expect(fp.notableDeaths).toEqual(["Merisiel", "Xulgath", "Zolgran"]);
    expect(fp.openThreads).toEqual(["The Menace Under Otari — what stirs beneath Otari?"]);
    expect(fp.pastEvents).toContain("Merisiel fell to Xulgath and Zolgran on the Landing");
    expect(fp.pastEvents).toContain("The party chose the east gate over the river road");
    // Threads and debts are not past events.
    expect(fp.pastEvents).not.toContain("The Menace Under Otari — what stirs beneath Otari?");
  });

  it("an empty store yields empty arrays", () => {
    const fp = toFloorPlannerChronicle(emptyChronicle());
    expect(fp).toEqual({
      partyMembers: [],
      keyNpcs: [],
      pastEvents: [],
      openThreads: [],
      notableDeaths: [],
    });
  });
});

describe("chronicleFacts", () => {
  it("returns each fact with the entry id it traces to", () => {
    const facts = chronicleFacts(seeded());
    const death = facts.find((f) => f.entryId === "death-1");
    expect(death?.fact).toContain("Merisiel fell");
    expect(death?.fact).toContain("2026-11-19");
    expect(death?.kind).toBe("death");
    // Session and resolution entries are excluded by default.
    expect(facts.some((f) => f.kind === "session")).toBe(false);
  });

  it("kinds narrows the facts", () => {
    const facts = chronicleFacts(seeded(), { kinds: ["death", "betrayal"] });
    expect(facts).toHaveLength(1);
    expect(facts[0].entryId).toBe("death-1");
  });
});

describe("renderRecap", () => {
  it("groups by session and lists what is still open", () => {
    const text = renderRecap(seeded());
    expect(text).toContain("Previously on");
    expect(text).toContain("**2026-11-19**");
    expect(text).toContain("Merisiel fell to Xulgath and Zolgran");
    expect(text).toContain("Still open");
    expect(text).toContain("🧵 The Menace Under Otari");
    expect(text).toContain("💰 The party owes the Merchant Guild");
  });

  it("an empty store says so instead of inventing a recap", () => {
    expect(renderRecap(emptyChronicle())).toContain("Nothing has been chronicled yet");
  });

  it("session filter and limit narrow the recap", () => {
    const store = seeded();
    expect(renderRecap(store, { session: "2026-11-20" })).toContain("Nothing has been chronicled");
    expect(renderRecap(store, { limit: 0 })).toContain("Nothing has been chronicled");
    const limited = renderRecap(store, { limit: 1 });
    expect(limited).toContain("The party chose the east gate");
    expect(limited).not.toContain("Merisiel fell");
  });
});

describe("recap import", () => {
  const recap: Recap = {
    title: "Session recap",
    date: "2026-11-19",
    events: [],
    kills: [{ kind: "kill", text: "Merisiel is down", messageId: "msg-1" }],
    loot: [{ kind: "loot", text: "Found 50 gp in the chest", messageId: "msg-2" }],
    combat: [],
    notableRolls: [],
    rooms: [],
    messageCount: 12,
  };

  it("maps a recap to a session entry plus one death and one loot entry, all sourced", () => {
    const entries = recapToChronicleEntries(recap);
    expect(entries).toHaveLength(3);
    expect(entries[0].kind).toBe("session");
    expect(entries[0].source).toBe("Session recap 2026-11-19");
    expect(entries[1].kind).toBe("death");
    expect(entries[1].actors).toEqual(["Merisiel"]);
    expect(entries[1].source).toContain("message msg-1");
    expect(entries[2].kind).toBe("loot");
    expect(entries[2].source).toContain("message msg-2");
  });

  it("unparseable kill phrasing keeps an empty actors list rather than guessing", () => {
    const weird: Recap = {
      ...recap,
      kills: [{ kind: "kill", text: "Something terrible happened", messageId: "msg-9" }],
    };
    const entries = recapToChronicleEntries(weird);
    expect(entries[1].actors).toEqual([]);
  });
});

describe("serialization", () => {
  it("round-trips through JSON", () => {
    const store = seeded();
    const parsed = parseChronicle(serializeChronicle(store));
    expect(parsed).toEqual(store);
  });

  it("rejects bad JSON, a wrong version, a bad kind, a missing source, and duplicate ids", () => {
    expect(() => parseChronicle("{nope")).toThrow(ChronicleError);
    expect(() => parseChronicle(JSON.stringify({ version: 2, entries: [] }))).toThrow(
      ChronicleError,
    );
    expect(() =>
      parseChronicle(
        JSON.stringify({
          version: 1,
          entries: [{ id: "x-1", kind: "omen", summary: "s", source: "g", date: "2026-11-20", actors: [] }],
        }),
      ),
    ).toThrow(ChronicleError);
    expect(() =>
      parseChronicle(
        JSON.stringify({
          version: 1,
          entries: [{ id: "x-1", kind: "thread", summary: "s", source: " ", date: "2026-11-20", actors: [] }],
        }),
      ),
    ).toThrow(ChronicleError);
    const dup = seeded();
    const json = JSON.stringify({ ...dup, entries: [...dup.entries, dup.entries[0]] });
    expect(() => parseChronicle(json)).toThrow(ChronicleError);
  });
});

describe("journal HTML", () => {
  it("escapes entry content and cites the source", () => {
    const { entry } = appendEntry(emptyChronicle(), {
      kind: "betrayal",
      summary: "Zolgran <sold> the party out",
      detail: "For 50 gp & a promise.",
      actors: ["Zolgran"],
      source: "GM statement",
    });
    const html = entryToJournalHtml(entry);
    expect(html).toContain("Zolgran &lt;sold&gt; the party out");
    expect(html).toContain("50 gp &amp; a promise");
    expect(html).toContain("GM statement");
  });

  it("the index lists open threads, debts, deaths, and names", () => {
    const html = chronicleIndexHtml(seeded());
    expect(html).toContain("Open threads");
    expect(html).toContain("The Menace Under Otari");
    expect(html).toContain("Open debts");
    expect(html).toContain("Merchant Guild");
    expect(html).toContain("Notable deaths");
    expect(html).toContain("Merisiel fell");
  });
});

describe("demoChronicle", () => {
  it("is grounded in the Nov 19 session and feeds the planner", () => {
    const store = demoChronicle();
    expect(store.campaign).toBe("Menace Under Otari");
    expect(store.entries).toHaveLength(9);
    const fp = toFloorPlannerChronicle(store);
    expect(fp.partyMembers).toEqual(["Ezren", "Kyra", "Merisiel", "Valeros"]);
    expect(fp.notableDeaths).toContain("Merisiel");
    expect(fp.openThreads).toHaveLength(1);
    expect(renderRecap(store)).toContain("Merisiel fell");
  });
});
