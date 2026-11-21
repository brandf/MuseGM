/**
 * Quest log (P3) — track quests, objectives, and party-facing summaries
 * between sessions.
 *
 * HONESTY RULE (same as the recap module): the log records only what the
 * party was actually told or did. A quest's title, giver, objectives, and
 * notes come from the GM or from events at the table — never invented.
 * Every note carries a `source` (who told the party, or what happened);
 * a note without a source is rejected, so the log never silently gains
 * facts nobody stated. The party summary only reports what the log
 * contains; an empty log says the party has no active quests.
 *
 * Two layers, kept separate on purpose (same pattern as
 * src/session/recap.ts and src/session/loot.ts):
 * - Pure functions (addQuest / completeObjective / completeQuest /
 *   failQuest / summarizePartyQuests / questToText / questToJournalHtml):
 *   no Foundry, no I/O, unit tested in tests/questlog.test.ts. All ops
 *   are immutable — they return a new log and never mutate the input.
 * - Live functions (*Live): thin wrappers over FoundryLive. The log is
 *   persisted as a JournalEntry named "Quest Log" (created `observer`
 *   so the party can read it in Foundry), one JournalEntryPage per quest.
 *   Each page carries the full quest JSON in
 *   `flags["foundry-live"].quest` — the flags are the source of truth
 *   and the HTML is only the display — so reading the log back never
 *   has to parse HTML. A first page named "Quest Log" is the index.
 *
 * Validation: unknown quest/objective ids are errors (QuestLogError).
 * Completing an already-completed quest, or failing an already-failed
 * one, is a no-op with a clear result (`alreadyCompleted` /
 * `alreadyFailed`) — never an error, never a duplicate announcement.
 * Completing a failed quest (or failing a completed one) is an error:
 * the states are terminal and contradictory.
 */
import type { FoundryLive } from "../live.js";

/** Quest status. Terminal states are `completed` and `failed`. */
export type QuestStatus = "active" | "completed" | "failed";

/** One objective of a quest. */
export interface QuestObjective {
  id: string;
  text: string;
  done: boolean;
}

/** One note on a quest — always with its source (see the module header). */
export interface QuestNote {
  text: string;
  /** Who told the party, or what happened at the table. Required. */
  source: string;
}

/** One quest. */
export interface Quest {
  id: string;
  title: string;
  /** Who gave the quest (an NPC, a faction, a notice board). Optional. */
  giver?: string;
  status: QuestStatus;
  objectives: QuestObjective[];
  notes: QuestNote[];
  /** ISO date the quest was added. */
  createdAt: string;
}

/** The whole log: every quest the party has ever been given. */
export interface QuestLog {
  quests: Quest[];
}

/** Validation / lookup failure. */
export class QuestLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuestLogError";
  }
}

/** An empty log. */
export function emptyQuestLog(): QuestLog {
  return { quests: [] };
}

/** Slugify a title into a stable quest id ("Clear the Cellar" -> "clear-the-cellar"). */
export function questIdFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "quest";
}

function cloneLog(log: QuestLog): QuestLog {
  return {
    quests: log.quests.map((q) => ({
      ...q,
      objectives: q.objectives.map((o) => ({ ...o })),
      notes: q.notes.map((n) => ({ ...n })),
    })),
  };
}

function findQuestOrThrow(log: QuestLog, questId: string): Quest {
  const quest = log.quests.find((q) => q.id === questId);
  if (!quest) throw new QuestLogError(`Unknown quest: ${questId}`);
  return quest;
}

/** Input for adding a quest. Objectives and notes are plain strings + sources. */
export interface AddQuestInput {
  title: string;
  giver?: string;
  /** Objective texts, in order. All start undone. */
  objectives?: string[];
  /** Notes, each with its source. */
  notes?: { text: string; source: string }[];
  /** ISO date; defaults to today. */
  createdAt?: string;
}

/**
 * Add a quest. Throws on an empty title or a duplicate id (two quests
 * with the same title get the same slug — rename one first).
 */
export function addQuest(
  log: QuestLog,
  input: AddQuestInput,
): { log: QuestLog; quest: Quest } {
  const title = input.title.trim();
  if (!title) throw new QuestLogError("A quest needs a title.");
  let id = questIdFromTitle(title);
  if (log.quests.some((q) => q.id === id)) {
    throw new QuestLogError(
      `A quest with id "${id}" already exists — rename the new quest first.`,
    );
  }
  const objectives: QuestObjective[] = (input.objectives ?? []).map((text, i) => {
    if (!text.trim()) throw new QuestLogError("An objective needs text.");
    return { id: `${id}-o${i + 1}`, text: text.trim(), done: false };
  });
  const notes: QuestNote[] = (input.notes ?? []).map((n) => {
    if (!n.text.trim()) throw new QuestLogError("A note needs text.");
    if (!n.source.trim()) {
      throw new QuestLogError("A note needs a source — who told the party, or what happened.");
    }
    return { text: n.text.trim(), source: n.source.trim() };
  });
  const quest: Quest = {
    id,
    title,
    status: "active",
    objectives,
    notes,
    createdAt: input.createdAt ?? new Date().toISOString().slice(0, 10),
  };
  if (input.giver?.trim()) quest.giver = input.giver.trim();
  const next = cloneLog(log);
  next.quests.push(quest);
  return { log: next, quest };
}

/** Append an objective to an active quest. Returns the new objective. */
export function addObjective(
  log: QuestLog,
  questId: string,
  text: string,
): { log: QuestLog; objective: QuestObjective } {
  if (!text.trim()) throw new QuestLogError("An objective needs text.");
  const quest = findQuestOrThrow(log, questId);
  if (quest.status !== "active") {
    throw new QuestLogError(`Cannot add an objective to a ${quest.status} quest: ${quest.title}`);
  }
  const maxN = quest.objectives.reduce((m, o) => {
    const n = Number(/-o(\d+)$/.exec(o.id)?.[1] ?? 0);
    return Math.max(m, n);
  }, 0);
  const objective: QuestObjective = {
    id: `${questId}-o${maxN + 1}`,
    text: text.trim(),
    done: false,
  };
  const next = cloneLog(log);
  next.quests.find((q) => q.id === questId)!.objectives.push(objective);
  return { log: next, objective };
}

/**
 * Mark an objective done. Completing an already-done objective is a
 * no-op: the log is returned unchanged with `alreadyDone: true`.
 */
export function completeObjective(
  log: QuestLog,
  questId: string,
  objectiveId: string,
): { log: QuestLog; quest: Quest; alreadyDone: boolean } {
  const quest = findQuestOrThrow(log, questId);
  const objective = quest.objectives.find((o) => o.id === objectiveId);
  if (!objective) {
    throw new QuestLogError(`Unknown objective: ${objectiveId} (quest ${questId})`);
  }
  if (objective.done) return { log, quest, alreadyDone: true };
  const next = cloneLog(log);
  const q = next.quests.find((x) => x.id === questId)!;
  q.objectives.find((o) => o.id === objectiveId)!.done = true;
  return { log: next, quest: q, alreadyDone: false };
}

/** Append a note to a quest. The source is required (see module header). */
export function addNote(
  log: QuestLog,
  questId: string,
  text: string,
  source: string,
): { log: QuestLog; quest: Quest } {
  if (!text.trim()) throw new QuestLogError("A note needs text.");
  if (!source.trim()) {
    throw new QuestLogError("A note needs a source — who told the party, or what happened.");
  }
  findQuestOrThrow(log, questId);
  const next = cloneLog(log);
  const q = next.quests.find((x) => x.id === questId)!;
  q.notes.push({ text: text.trim(), source: source.trim() });
  return { log: next, quest: q };
}

/**
 * Complete a quest. Completing an already-completed quest is a no-op
 * (`alreadyCompleted: true`). Completing a failed quest is an error.
 */
export function completeQuest(
  log: QuestLog,
  questId: string,
): { log: QuestLog; quest: Quest; alreadyCompleted: boolean } {
  const quest = findQuestOrThrow(log, questId);
  if (quest.status === "completed") return { log, quest, alreadyCompleted: true };
  if (quest.status === "failed") {
    throw new QuestLogError(`Quest "${quest.title}" already failed — it cannot be completed.`);
  }
  const next = cloneLog(log);
  const q = next.quests.find((x) => x.id === questId)!;
  q.status = "completed";
  return { log: next, quest: q, alreadyCompleted: false };
}

/**
 * Fail a quest. Failing an already-failed quest is a no-op
 * (`alreadyFailed: true`). Failing a completed quest is an error.
 */
export function failQuest(
  log: QuestLog,
  questId: string,
): { log: QuestLog; quest: Quest; alreadyFailed: boolean } {
  const quest = findQuestOrThrow(log, questId);
  if (quest.status === "failed") return { log, quest, alreadyFailed: true };
  if (quest.status === "completed") {
    throw new QuestLogError(`Quest "${quest.title}" is already completed — it cannot fail.`);
  }
  const next = cloneLog(log);
  const q = next.quests.find((x) => x.id === questId)!;
  q.status = "failed";
  return { log: next, quest: q, alreadyFailed: false };
}

/** Find a quest by id, or undefined. */
export function getQuest(log: QuestLog, questId: string): Quest | undefined {
  return log.quests.find((q) => q.id === questId);
}

/** Quests filtered by status (all quests when no status is given). */
export function listQuests(log: QuestLog, status?: QuestStatus): Quest[] {
  return status ? log.quests.filter((q) => q.status === status) : [...log.quests];
}

/** Party-facing summary: active quests with their open objectives, plus tallies. */
export function summarizePartyQuests(log: QuestLog): string {
  const active = listQuests(log, "active");
  const done = listQuests(log, "completed");
  const failed = listQuests(log, "failed");
  const lines: string[] = ["📜 **Quest log**"];
  if (active.length === 0) {
    lines.push("No active quests — the party is between jobs.");
  }
  for (const q of active) {
    const open = q.objectives.filter((o) => !o.done);
    const doneCount = q.objectives.length - open.length;
    const giver = q.giver ? ` (from ${q.giver})` : "";
    lines.push(`\n• **${q.title}**${giver}`);
    if (q.objectives.length > 0) {
      lines.push(`  ${doneCount}/${q.objectives.length} objectives done`);
      for (const o of open) lines.push(`  ⬜ ${o.text}`);
    }
  }
  const tally: string[] = [];
  if (done.length > 0) tally.push(`${done.length} completed`);
  if (failed.length > 0) tally.push(`${failed.length} failed`);
  if (tally.length > 0) lines.push(`\n${tally.join(" · ")}.`);
  return lines.join("\n");
}

/** Render one quest as chat text. */
export function questToText(quest: Quest): string {
  const status =
    quest.status === "active" ? "🟢 Active" : quest.status === "completed" ? "🏆 Completed" : "💀 Failed";
  const lines: string[] = [`📜 **${quest.title}** — ${status}`];
  if (quest.giver) lines.push(`Given by: ${quest.giver}`);
  lines.push(`Added: ${quest.createdAt}`);
  if (quest.objectives.length > 0) {
    lines.push("\nObjectives:");
    for (const o of quest.objectives) {
      lines.push(`${o.done ? "✅" : "⬜"} ${o.text}`);
    }
  }
  if (quest.notes.length > 0) {
    lines.push("\nNotes:");
    for (const n of quest.notes) lines.push(`• ${n.text} (— ${n.source})`);
  }
  return lines.join("\n");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Render one quest as HTML for its journal page. */
export function questToJournalHtml(quest: Quest): string {
  const status =
    quest.status === "active" ? "Active" : quest.status === "completed" ? "Completed" : "Failed";
  const objectives =
    quest.objectives.length > 0
      ? `<h2>Objectives</h2><ul>${quest.objectives
          .map((o) => `<li>${o.done ? "☑" : "☐"} ${esc(o.text)}</li>`)
          .join("")}</ul>`
      : "";
  const notes =
    quest.notes.length > 0
      ? `<h2>Notes</h2><ul>${quest.notes
          .map((n) => `<li>${esc(n.text)} <em>(— ${esc(n.source)})</em></li>`)
          .join("")}</ul>`
      : "";
  return (
    `<h1>${esc(quest.title)}</h1>` +
    `<p><b>Status:</b> ${status}${quest.giver ? ` · <b>Given by:</b> ${esc(quest.giver)}` : ""} · <b>Added:</b> ${esc(quest.createdAt)}</p>` +
    objectives +
    notes
  );
}

/** Render the index page: every quest with its status and open objectives. */
export function questLogIndexHtml(log: QuestLog): string {
  const section = (heading: string, quests: Quest[]): string => {
    if (quests.length === 0) return "";
    const lis = quests
      .map((q) => {
        const open = q.objectives.filter((o) => !o.done).length;
        const obj =
          q.objectives.length > 0 ? ` — ${open}/${q.objectives.length} objectives open` : "";
        return `<li><b>${esc(q.title)}</b>${q.giver ? ` (from ${esc(q.giver)})` : ""}${obj}</li>`;
      })
      .join("");
    return `<h2>${heading}</h2><ul>${lis}</ul>`;
  };
  return (
    `<h1>Quest Log</h1>` +
    `<p><em>What the party has been asked to do — and what they have actually done. Each quest has its own page.</em></p>` +
    section("Active", listQuests(log, "active")) +
    section("Completed", listQuests(log, "completed")) +
    section("Failed", listQuests(log, "failed")) +
    (log.quests.length === 0 ? `<p>No quests yet.</p>` : "")
  );
}

// ---------------------------------------------------------------- live layer

/** Name of the JournalEntry that holds the quest log. */
export const QUEST_LOG_NAME = "Quest Log";

/** Title of the index page inside the quest-log entry. */
export const QUEST_LOG_INDEX_PAGE = "Quest Log";

interface RawJournalPage {
  _id: string;
  name: string;
  text?: { content?: string };
  flags?: Record<string, unknown>;
}

interface RawJournal {
  _id: string;
  name: string;
  pages?: RawJournalPage[];
  flags?: Record<string, unknown>;
}

interface RawClient {
  getJournals(): RawJournal[];
  createJournalEntry(
    name: string,
    pages: { name: string; content: string }[],
    folder?: string,
    visibility?: string,
  ): Promise<{ _id: string }>;
}

function rawClient(live: FoundryLive): RawClient {
  return live.raw() as unknown as RawClient;
}

function questFlags(quest: Quest): Record<string, unknown> {
  return { "foundry-live": { questId: quest.id, quest } };
}

function pageQuest(page: RawJournalPage): Quest | null {
  const flags = page.flags?.["foundry-live"] as { quest?: Quest } | undefined;
  const quest = flags?.quest;
  if (!quest || typeof quest.id !== "string" || typeof quest.title !== "string") return null;
  return quest;
}

/** Find the quest-log JournalEntry, if it exists. Flagged entries win over name matches. */
export function findQuestLogEntry(live: FoundryLive): RawJournal | null {
  const journals = rawClient(live).getJournals();
  const flagged = journals.find(
    (j) => (j.flags?.["foundry-live"] as { questLog?: boolean } | undefined)?.questLog === true,
  );
  if (flagged) return flagged;
  return journals.find((j) => j.name === QUEST_LOG_NAME) ?? null;
}

/**
 * Read the quest log from the world. Quests come from page flags (the
 * source of truth); pages without a quest flag — including the index
 * page — are skipped. Returns the entry id (null when no entry exists
 * yet) and the log.
 */
export function readQuestLog(live: FoundryLive): { entryId: string | null; log: QuestLog } {
  const entry = findQuestLogEntry(live);
  if (!entry) return { entryId: null, log: emptyQuestLog() };
  const quests: Quest[] = [];
  for (const page of entry.pages ?? []) {
    const quest = pageQuest(page);
    if (quest) quests.push(quest);
  }
  return { entryId: entry._id, log: { quests } };
}

/** Find a quest's page inside an entry, by quest id flag. */
function findQuestPage(entry: RawJournal, questId: string): RawJournalPage | undefined {
  return (entry.pages ?? []).find(
    (p) => (p.flags?.["foundry-live"] as { questId?: string } | undefined)?.questId === questId,
  );
}

function findIndexPage(entry: RawJournal): RawJournalPage | undefined {
  return (entry.pages ?? []).find((p) => p.name === QUEST_LOG_INDEX_PAGE);
}

/**
 * Create the quest-log entry if it doesn't exist yet (one index page,
 * `observer` so the party can read it), and flag it. Returns the entry id.
 */
export async function ensureQuestLogEntry(live: FoundryLive): Promise<string> {
  const existing = findQuestLogEntry(live);
  if (existing) return existing._id;
  const created = await rawClient(live).createJournalEntry(
    QUEST_LOG_NAME,
    [{ name: QUEST_LOG_INDEX_PAGE, content: questLogIndexHtml(emptyQuestLog()) }],
    undefined,
    "observer",
  );
  await live.modifyDocument("JournalEntry", "update", {
    updates: [{ _id: created._id, flags: { "foundry-live": { questLog: true } } }],
  });
  return created._id;
}

/** Write (create or update) one quest's page, then refresh the index page. */
async function writeQuestPage(
  live: FoundryLive,
  entryId: string,
  quest: Quest,
): Promise<string> {
  const entry = findQuestLogEntry(live);
  const existing = entry ? findQuestPage(entry, quest.id) : undefined;
  const content = questToJournalHtml(quest);
  if (existing) {
    await live.modifyDocument("JournalEntryPage", "update", {
      updates: [{ _id: existing._id, text: { content }, flags: questFlags(quest) }],
      parentUuid: `JournalEntry.${entryId}`,
    });
    return existing._id;
  }
  const created = await live.modifyDocument("JournalEntryPage", "create", {
    data: [
      {
        name: quest.title,
        type: "text",
        text: { content, format: 1 },
        flags: questFlags(quest),
      },
    ],
    parentUuid: `JournalEntry.${entryId}`,
  });
  return String(created[0]._id);
}

/** Refresh the index page to match the current log. */
async function writeIndexPage(
  live: FoundryLive,
  entryId: string,
  log: QuestLog,
): Promise<void> {
  const entry = findQuestLogEntry(live);
  const index = entry ? findIndexPage(entry) : undefined;
  if (!index) return; // The entry was created with one; a missing index is not fatal.
  await live.modifyDocument("JournalEntryPage", "update", {
    updates: [{ _id: index._id, text: { content: questLogIndexHtml(log) } }],
    parentUuid: `JournalEntry.${entryId}`,
  });
}

/** Add a quest: journal page + index refresh + one chat line. */
export async function addQuestLive(
  live: FoundryLive,
  input: AddQuestInput,
): Promise<{ quest: Quest; pageId: string; entryId: string }> {
  const entryId = await ensureQuestLogEntry(live);
  const { log } = readQuestLog(live);
  const { log: next, quest } = addQuest(log, input);
  const pageId = await writeQuestPage(live, entryId, quest);
  await writeIndexPage(live, entryId, next);
  await live.sendChat(
    `📜 New quest: **${quest.title}**${quest.giver ? ` (from ${quest.giver})` : ""}${quest.objectives.length > 0 ? ` — ${quest.objectives.length} objective${quest.objectives.length === 1 ? "" : "s"}` : ""}.`,
  );
  return { quest, pageId, entryId };
}

/** Complete an objective live. A no-op (already done) posts no chat line. */
export async function completeObjectiveLive(
  live: FoundryLive,
  questId: string,
  objectiveId: string,
): Promise<{ quest: Quest; alreadyDone: boolean }> {
  const entryId = await ensureQuestLogEntry(live);
  const { log } = readQuestLog(live);
  const { log: next, quest, alreadyDone } = completeObjective(log, questId, objectiveId);
  if (alreadyDone) return { quest, alreadyDone: true };
  await writeQuestPage(live, entryId, quest);
  await writeIndexPage(live, entryId, next);
  const objective = quest.objectives.find((o) => o.id === objectiveId)!;
  await live.sendChat(`✅ Objective done — **${quest.title}**: ${objective.text}`);
  return { quest, alreadyDone: false };
}

/** Add an objective to an active quest, live. */
export async function addObjectiveLive(
  live: FoundryLive,
  questId: string,
  text: string,
): Promise<{ quest: Quest; objective: QuestObjective }> {
  const entryId = await ensureQuestLogEntry(live);
  const { log } = readQuestLog(live);
  const { log: next, objective } = addObjective(log, questId, text);
  const quest = getQuest(next, questId)!;
  await writeQuestPage(live, entryId, quest);
  await writeIndexPage(live, entryId, next);
  await live.sendChat(`📜 New objective — **${quest.title}**: ${objective.text}`);
  return { quest, objective };
}

/** Add a note to a quest, live. */
export async function addNoteLive(
  live: FoundryLive,
  questId: string,
  text: string,
  source: string,
): Promise<{ quest: Quest }> {
  const entryId = await ensureQuestLogEntry(live);
  const { log } = readQuestLog(live);
  const { log: next, quest } = addNote(log, questId, text, source);
  await writeQuestPage(live, entryId, quest);
  await writeIndexPage(live, entryId, next);
  return { quest };
}

/** Complete a quest live. A no-op (already completed) posts no chat line. */
export async function completeQuestLive(
  live: FoundryLive,
  questId: string,
): Promise<{ quest: Quest; alreadyCompleted: boolean }> {
  const entryId = await ensureQuestLogEntry(live);
  const { log } = readQuestLog(live);
  const { log: next, quest, alreadyCompleted } = completeQuest(log, questId);
  if (alreadyCompleted) return { quest, alreadyCompleted: true };
  await writeQuestPage(live, entryId, quest);
  await writeIndexPage(live, entryId, next);
  await live.sendChat(`🏆 Quest complete: **${quest.title}**`);
  return { quest, alreadyCompleted: false };
}

/** Fail a quest live. A no-op (already failed) posts no chat line. */
export async function failQuestLive(
  live: FoundryLive,
  questId: string,
): Promise<{ quest: Quest; alreadyFailed: boolean }> {
  const entryId = await ensureQuestLogEntry(live);
  const { log } = readQuestLog(live);
  const { log: next, quest, alreadyFailed } = failQuest(log, questId);
  if (alreadyFailed) return { quest, alreadyFailed: true };
  await writeQuestPage(live, entryId, quest);
  await writeIndexPage(live, entryId, next);
  await live.sendChat(`💀 Quest failed: **${quest.title}**`);
  return { quest, alreadyFailed: false };
}

/** Read the log and print the party summary — no writes, no chat. */
export function listQuestsLive(live: FoundryLive): { entryId: string | null; log: QuestLog } {
  return readQuestLog(live);
}
