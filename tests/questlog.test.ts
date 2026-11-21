/**
 * Unit tests for the quest log pure functions (src/session/questlog.ts).
 * No Foundry connection needed — run with `bun test`.
 *
 * The fixture quests are demo data (a caravan escort and a cellar of
 * rats), clearly labeled as such — the honesty rule is tested, not
 * violated, by them: notes without sources are rejected, and the
 * summary only reports what the log contains.
 */
import { describe, expect, it } from "bun:test";
import {
  addNote,
  addObjective,
  addQuest,
  completeObjective,
  completeQuest,
  emptyQuestLog,
  failQuest,
  getQuest,
  listQuests,
  QuestLogError,
  questIdFromTitle,
  questLogIndexHtml,
  questToJournalHtml,
  questToText,
  summarizePartyQuests,
  type QuestLog,
} from "../src/session/questlog.js";

function demoLog(): QuestLog {
  let log = emptyQuestLog();
  log = addQuest(log, {
    title: "Escort the merchant caravan",
    giver: "Merchant Guild",
    objectives: ["Meet the caravan at the east gate", "Reach Otari by nightfall"],
    notes: [{ text: "Bandits on the east road.", source: "Guild notice board" }],
    createdAt: "2026-11-20",
  }).log;
  log = addQuest(log, {
    title: "Clear the rats from the cellar",
    giver: "Innkeeper",
    objectives: ["Find the nest"],
    createdAt: "2026-11-20",
  }).log;
  return log;
}

describe("questIdFromTitle", () => {
  it("slugifies a title", () => {
    expect(questIdFromTitle("Escort the merchant caravan")).toBe("escort-the-merchant-caravan");
    expect(questIdFromTitle("Clear the rats!")).toBe("clear-the-rats");
  });
  it("falls back to 'quest' for a punctuation-only title", () => {
    expect(questIdFromTitle("!!!")).toBe("quest");
  });
});

describe("addQuest", () => {
  it("creates an active quest with slugged id and numbered objectives", () => {
    const { log, quest } = addQuest(emptyQuestLog(), {
      title: "Find the lost amulet",
      giver: "Old Mara",
      objectives: ["Search the ruins", "Return the amulet"],
      createdAt: "2026-11-20",
    });
    expect(quest.id).toBe("find-the-lost-amulet");
    expect(quest.status).toBe("active");
    expect(quest.giver).toBe("Old Mara");
    expect(quest.objectives).toHaveLength(2);
    expect(quest.objectives[0]).toEqual({ id: "find-the-lost-amulet-o1", text: "Search the ruins", done: false });
    expect(log.quests).toHaveLength(1);
  });
  it("rejects an empty title", () => {
    expect(() => addQuest(emptyQuestLog(), { title: "   " })).toThrow(QuestLogError);
  });
  it("rejects a duplicate title (same slug)", () => {
    const log = demoLog();
    expect(() => addQuest(log, { title: "Escort the merchant caravan" })).toThrow(QuestLogError);
  });
  it("rejects a note without a source", () => {
    expect(() =>
      addQuest(emptyQuestLog(), {
        title: "A quest",
        notes: [{ text: "Something happened.", source: "  " }],
      }),
    ).toThrow(QuestLogError);
  });
  it("does not mutate the input log", () => {
    const before = emptyQuestLog();
    addQuest(before, { title: "A quest" });
    expect(before.quests).toHaveLength(0);
  });
});

describe("completeObjective", () => {
  it("marks the objective done", () => {
    const log = demoLog();
    const { log: next, quest, alreadyDone } = completeObjective(log, "escort-the-merchant-caravan", "escort-the-merchant-caravan-o1");
    expect(alreadyDone).toBe(false);
    expect(quest.objectives[0].done).toBe(true);
    expect(quest.objectives[1].done).toBe(false);
    expect(next.quests[0].objectives[0].done).toBe(true);
    expect(log.quests[0].objectives[0].done).toBe(false); // input untouched
  });
  it("completing an already-done objective is a no-op with alreadyDone true", () => {
    const log = demoLog();
    const once = completeObjective(log, "escort-the-merchant-caravan", "escort-the-merchant-caravan-o1");
    const twice = completeObjective(once.log, "escort-the-merchant-caravan", "escort-the-merchant-caravan-o1");
    expect(twice.alreadyDone).toBe(true);
    expect(twice.log).toBe(once.log); // same object back, nothing changed
  });
  it("throws on an unknown quest id", () => {
    expect(() => completeObjective(demoLog(), "no-such-quest", "x-o1")).toThrow(QuestLogError);
  });
  it("throws on an unknown objective id", () => {
    expect(() =>
      completeObjective(demoLog(), "escort-the-merchant-caravan", "escort-the-merchant-caravan-o99"),
    ).toThrow(QuestLogError);
  });
});

describe("addObjective", () => {
  it("appends with the next numbered id", () => {
    const { log, objective } = addObjective(demoLog(), "clear-the-rats-from-the-cellar", "Burn the nest");
    expect(objective.id).toBe("clear-the-rats-from-the-cellar-o2");
    expect(getQuest(log, "clear-the-rats-from-the-cellar")!.objectives).toHaveLength(2);
  });
  it("throws on a completed quest", () => {
    const done = completeQuest(demoLog(), "clear-the-rats-from-the-cellar").log;
    expect(() => addObjective(done, "clear-the-rats-from-the-cellar", "More rats")).toThrow(QuestLogError);
  });
});

describe("completeQuest / failQuest", () => {
  it("completes an active quest", () => {
    const { log, quest, alreadyCompleted } = completeQuest(demoLog(), "clear-the-rats-from-the-cellar");
    expect(alreadyCompleted).toBe(false);
    expect(quest.status).toBe("completed");
    expect(listQuests(log, "completed")).toHaveLength(1);
  });
  it("completing an already-completed quest is a no-op", () => {
    const once = completeQuest(demoLog(), "clear-the-rats-from-the-cellar");
    const twice = completeQuest(once.log, "clear-the-rats-from-the-cellar");
    expect(twice.alreadyCompleted).toBe(true);
    expect(twice.log).toBe(once.log);
  });
  it("completing a failed quest is an error", () => {
    const failed = failQuest(demoLog(), "clear-the-rats-from-the-cellar").log;
    expect(() => completeQuest(failed, "clear-the-rats-from-the-cellar")).toThrow(QuestLogError);
  });
  it("fails an active quest", () => {
    const { quest, alreadyFailed } = failQuest(demoLog(), "escort-the-merchant-caravan");
    expect(alreadyFailed).toBe(false);
    expect(quest.status).toBe("failed");
  });
  it("failing an already-failed quest is a no-op", () => {
    const once = failQuest(demoLog(), "escort-the-merchant-caravan");
    const twice = failQuest(once.log, "escort-the-merchant-caravan");
    expect(twice.alreadyFailed).toBe(true);
  });
  it("failing a completed quest is an error", () => {
    const done = completeQuest(demoLog(), "clear-the-rats-from-the-cellar").log;
    expect(() => failQuest(done, "clear-the-rats-from-the-cellar")).toThrow(QuestLogError);
  });
  it("throws on unknown quest ids", () => {
    expect(() => completeQuest(demoLog(), "nope")).toThrow(QuestLogError);
    expect(() => failQuest(demoLog(), "nope")).toThrow(QuestLogError);
  });
});

describe("addNote", () => {
  it("records the note with its source", () => {
    const { log, quest } = addNote(demoLog(), "escort-the-merchant-caravan", "The guildmaster is nervous.", "The guildmaster, at the gate");
    expect(quest.notes).toHaveLength(2);
    expect(quest.notes[1]).toEqual({ text: "The guildmaster is nervous.", source: "The guildmaster, at the gate" });
    expect(log.quests[0].notes).toHaveLength(2);
  });
  it("rejects a note without a source", () => {
    expect(() => addNote(demoLog(), "escort-the-merchant-caravan", "Something.", "")).toThrow(QuestLogError);
  });
});

describe("summarizePartyQuests", () => {
  it("lists active quests with open objectives only", () => {
    const log = completeObjective(demoLog(), "escort-the-merchant-caravan", "escort-the-merchant-caravan-o1").log;
    const text = summarizePartyQuests(log);
    expect(text).toContain("Escort the merchant caravan");
    expect(text).toContain("Reach Otari by nightfall");
    expect(text).not.toContain("Meet the caravan at the east gate"); // done, not open
    expect(text).toContain("1/2 objectives done");
  });
  it("an empty log says the party has no active quests", () => {
    expect(summarizePartyQuests(emptyQuestLog())).toContain("No active quests");
  });
  it("tallies completed and failed quests", () => {
    let log = completeQuest(demoLog(), "clear-the-rats-from-the-cellar").log;
    log = failQuest(log, "escort-the-merchant-caravan").log;
    const text = summarizePartyQuests(log);
    expect(text).toContain("1 completed");
    expect(text).toContain("1 failed");
  });
});

describe("rendering", () => {
  it("questToText shows status, giver, objectives, and sourced notes", () => {
    const quest = getQuest(demoLog(), "escort-the-merchant-caravan")!;
    const text = questToText(quest);
    expect(text).toContain("Escort the merchant caravan");
    expect(text).toContain("Merchant Guild");
    expect(text).toContain("⬜ Meet the caravan at the east gate");
    expect(text).toContain("Bandits on the east road. (— Guild notice board)");
  });
  it("questToJournalHtml escapes HTML and marks done objectives", () => {
    const log = completeObjective(demoLog(), "escort-the-merchant-caravan", "escort-the-merchant-caravan-o1").log;
    const html = questToJournalHtml(getQuest(log, "escort-the-merchant-caravan")!);
    expect(html).toContain("☑ Meet the caravan");
    expect(html).toContain("☐ Reach Otari");
    expect(html).not.toContain("<script>");
  });
  it("questLogIndexHtml sections by status and counts open objectives", () => {
    let log = completeObjective(demoLog(), "escort-the-merchant-caravan", "escort-the-merchant-caravan-o1").log;
    log = completeQuest(log, "clear-the-rats-from-the-cellar").log;
    const html = questLogIndexHtml(log);
    expect(html).toContain("Active");
    expect(html).toContain("Completed");
    expect(html).toContain("Escort the merchant caravan");
    expect(html).toContain("1/2 objectives open");
    expect(html).toContain("Clear the rats from the cellar");
  });
  it("questLogIndexHtml on an empty log says so", () => {
    expect(questLogIndexHtml(emptyQuestLog())).toContain("No quests yet.");
  });
});
