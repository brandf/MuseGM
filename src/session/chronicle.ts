/**
 * Campaign chronicle store (BRA-232) — persistent memory the generators
 * read, so the world feels continuous.
 *
 * The doc (Act One): "It remembers your campaign. Recaps, journals,
 * names, debts, and old betrayals are not trivia. They are raw material,
 * woven back into new places, puzzles, and people." The spec (FR-11,
 * FR-15) says the same: the encounter generator and the floor planner
 * read the chronicle, and every beat must trace to it. Before this
 * module there was no store: recaps wrote journal entries (BRA-188)
 * and the floor planner took chronicle data as input passed in by hand
 * (BRA-191). This is the store they both read from.
 *
 * HONESTY RULE (same as the recap and quest-log modules): the
 * chronicle records only what actually happened at the table. Every
 * entry carries a `source` (a session recap, a GM statement, a chat
 * message id); an entry without a source is rejected, so the store
 * never silently gains facts nobody stated. A new beat cites the
 * chronicle entry it traces to by entry id (`chronicleFacts` returns
 * each fact with its id; the floor planner cites "chronicle: <text>").
 *
 * APPEND-ONLY: entries are never edited or deleted. A correction is a
 * new entry; resolving a thread appends a `resolution` entry that
 * references the thread — the open-thread list is derived, not stored.
 * All pure ops are immutable (they return a new store).
 *
 * Two layers, kept separate on purpose (same pattern as
 * src/session/questlog.ts and src/session/recap.ts):
 * - Pure functions (appendEntry / resolveThread / queryEntries /
 *   listOpenThreads / toFloorPlannerChronicle / chronicleFacts /
 *   renderRecap / serializeChronicle / parseChronicle / ...): no
 *   Foundry, no I/O, unit tested in tests/chronicle.test.ts.
 * - Live functions (*Live): thin wrappers over FoundryLive. The store
 *   is persisted as a JournalEntry named "Campaign Chronicle" (created
 *   `observer` so the party can read it), one JournalEntryPage per
 *   entry — the same pattern as the quest log. Each page carries its
 *   entry JSON in `flags["foundry-live"].entry` (with
 *   `chronicleEntryId` alongside for lookup) — the flags are the source
 *   of truth and the HTML is only the display — so reading the store
 *   back never has to parse HTML. A first page named "Campaign
 *   Chronicle" is the index (open threads, debts, deaths, names).
 *
 * The floor planner reads the store through `toFloorPlannerChronicle`,
 * which produces the `Chronicle` shape it already takes — no change to
 * the planner. The encounter generator has no chronicle input yet, so
 * it reads the store through `chronicleFacts` (plain facts with entry
 * ids, ready to drop into an encounter spec's story context) once its
 * input accepts them — wiring that input is a follow-up, not part of
 * this store.
 */
import type { FoundryLive } from "../live.js";
import type { Chronicle } from "./floor-plan.js";
import type { Recap } from "./recap.js";
import { recapToText } from "./recap.js";

export type { Recap } from "./recap.js";

/** What the chronicle remembers. */
export type ChronicleKind =
  | "session"
  | "decision"
  | "npc"
  | "debt"
  | "betrayal"
  | "thread"
  | "death"
  | "loot"
  | "quest"
  | "resolution";

export const CHRONICLE_KINDS: readonly ChronicleKind[] = [
  "session",
  "decision",
  "npc",
  "debt",
  "betrayal",
  "thread",
  "death",
  "loot",
  "quest",
  "resolution",
];

/** One entry in the chronicle. Append-only — never edited in place. */
export interface ChronicleEntry {
  /** Stable, human-citable id, e.g. "thread-2". */
  id: string;
  kind: ChronicleKind;
  /** One line: what happened. */
  summary: string;
  /** Longer detail, when one line is not enough. Optional. */
  detail?: string;
  /** Names involved (people, factions, places-as-actors). */
  actors: string[];
  /** Session label, e.g. "2026-11-19" or "Session 3". Optional. */
  session?: string;
  /** ISO date the entry was recorded. */
  date: string;
  /** Where this came from — required. A recap date, a GM statement, a chat message id. */
  source: string;
  /** For `npc` entries: player character or non-player character. */
  role?: "pc" | "npc";
  /** For `resolution` entries: the thread entry id this resolves. */
  refId?: string;
}

/** The whole store: every entry the campaign has ever recorded. */
export interface ChronicleStore {
  version: 1;
  campaign?: string;
  entries: ChronicleEntry[];
}

/** Validation / lookup failure. */
export class ChronicleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChronicleError";
  }
}

/** An empty store. */
export function emptyChronicle(campaign?: string): ChronicleStore {
  return campaign ? { version: 1, campaign, entries: [] } : { version: 1, entries: [] };
}

function cloneStore(store: ChronicleStore): ChronicleStore {
  return {
    ...store,
    entries: store.entries.map((e) => ({ ...e, actors: [...e.actors] })),
  };
}

function cleanActors(actors: string[] | undefined): string[] {
  const out: string[] = [];
  for (const a of actors ?? []) {
    const name = a.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Input for appending an entry. `summary` and `source` are required. */
export interface AddEntryInput {
  kind: ChronicleKind;
  summary: string;
  detail?: string;
  actors?: string[];
  session?: string;
  /** ISO date; defaults to today. */
  date?: string;
  source: string;
  role?: "pc" | "npc";
  refId?: string;
}

/**
 * Append an entry. Throws on an empty summary, a missing source, an
 * unknown kind, a `resolution` without a refId, or a `resolution`
 * whose refId is not a thread entry. Ids are `<kind>-<n>` where n is
 * the per-kind count + 1, so they are stable and citable.
 */
export function appendEntry(
  store: ChronicleStore,
  input: AddEntryInput,
): { store: ChronicleStore; entry: ChronicleEntry } {
  if (!CHRONICLE_KINDS.includes(input.kind)) {
    throw new ChronicleError(
      `Unknown chronicle kind: ${String(input.kind)} (known: ${CHRONICLE_KINDS.join(", ")})`,
    );
  }
  const summary = input.summary.trim();
  if (!summary) throw new ChronicleError("A chronicle entry needs a summary.");
  const source = input.source.trim();
  if (!source) {
    throw new ChronicleError(
      "A chronicle entry needs a source — a recap date, a GM statement, or a chat message id.",
    );
  }
  if (input.kind === "resolution") {
    if (!input.refId?.trim()) {
      throw new ChronicleError("A resolution needs refId — the thread entry it resolves.");
    }
    const target = store.entries.find((e) => e.id === input.refId!.trim());
    if (!target) throw new ChronicleError(`Unknown thread entry: ${input.refId.trim()}`);
    if (target.kind !== "thread") {
      throw new ChronicleError(
        `A resolution must reference a thread entry — ${input.refId.trim()} is a ${target.kind} entry.`,
      );
    }
  }
  if (input.kind === "npc" && input.role !== undefined && input.role !== "pc" && input.role !== "npc") {
    throw new ChronicleError(`An npc entry's role must be "pc" or "npc", got ${String(input.role)}.`);
  }
  const n = store.entries.filter((e) => e.kind === input.kind).length + 1;
  const entry: ChronicleEntry = {
    id: `${input.kind}-${n}`,
    kind: input.kind,
    summary,
    actors: cleanActors(input.actors),
    date: input.date ?? new Date().toISOString().slice(0, 10),
    source,
  };
  if (input.detail?.trim()) entry.detail = input.detail.trim();
  if (input.session?.trim()) entry.session = input.session.trim();
  if (input.role !== undefined) entry.role = input.role;
  if (input.refId?.trim()) entry.refId = input.refId.trim();
  const next = cloneStore(store);
  next.entries.push(entry);
  return { store: next, entry };
}

/**
 * Resolve an open thread: appends a `resolution` entry referencing it.
 * Resolving an already-resolved thread is a no-op (`alreadyResolved:
 * true`, the store returned unchanged) — never a duplicate entry.
 */
export function resolveThread(
  store: ChronicleStore,
  threadId: string,
  summary: string,
  source: string,
  date?: string,
): { store: ChronicleStore; entry: ChronicleEntry | null; alreadyResolved: boolean } {
  const thread = store.entries.find((e) => e.id === threadId);
  if (!thread) throw new ChronicleError(`Unknown thread entry: ${threadId}`);
  if (thread.kind !== "thread") {
    throw new ChronicleError(`Cannot resolve ${threadId} — it is a ${thread.kind} entry, not a thread.`);
  }
  const existing = store.entries.find((e) => e.kind === "resolution" && e.refId === threadId);
  if (existing) return { store, entry: existing, alreadyResolved: true };
  const { store: next, entry } = appendEntry(store, {
    kind: "resolution",
    summary: summary.trim() || `Thread resolved: ${thread.summary}`,
    source,
    refId: threadId,
    session: thread.session,
    date,
  });
  return { store: next, entry, alreadyResolved: false };
}

/** Find an entry by id, or undefined. */
export function getEntry(store: ChronicleStore, entryId: string): ChronicleEntry | undefined {
  return store.entries.find((e) => e.id === entryId);
}

/** Query filters for the store. All filters are ANDed. */
export interface ChronicleQuery {
  kind?: ChronicleKind;
  session?: string;
  actor?: string;
  /** "open" / "resolved" only applies to thread entries. */
  status?: "open" | "resolved";
}

/** Entries matching the query, in chronicle order. */
export function queryEntries(store: ChronicleStore, query: ChronicleQuery = {}): ChronicleEntry[] {
  const resolvedIds = new Set(
    store.entries.filter((e) => e.kind === "resolution" && e.refId).map((e) => e.refId!),
  );
  return store.entries.filter((e) => {
    if (query.kind && e.kind !== query.kind) return false;
    if (query.session && e.session !== query.session) return false;
    if (query.actor && !e.actors.includes(query.actor)) return false;
    if (query.status === "open" && !(e.kind === "thread" && !resolvedIds.has(e.id))) return false;
    if (query.status === "resolved" && !(e.kind === "thread" && resolvedIds.has(e.id))) return false;
    return true;
  });
}

/** Open storyline threads (threads with no resolution entry), in order. */
export function listOpenThreads(store: ChronicleStore): ChronicleEntry[] {
  return queryEntries(store, { kind: "thread", status: "open" });
}

/** Unresolved debts, in order. (Debts resolve the same way as threads: a `resolution` entry with refId.) */
export function listOpenDebts(store: ChronicleStore): ChronicleEntry[] {
  const resolvedIds = new Set(
    store.entries.filter((e) => e.kind === "resolution" && e.refId).map((e) => e.refId!),
  );
  return store.entries.filter(
    (e) => e.kind === "debt" && !resolvedIds.has(e.id),
  );
}

/** Every name the chronicle knows, first-seen order: PCs, NPCs, the dead. */
export function listNames(store: ChronicleStore): string[] {
  const out: string[] = [];
  for (const e of store.entries) {
    for (const a of e.actors) {
      if (!out.includes(a)) out.push(a);
    }
  }
  return out;
}

/**
 * The floor planner's view of the store — the `Chronicle` shape it
 * already takes, derived, never hand-written. Party members are the
 * actors of `npc` entries with role "pc"; key NPCs the actors of
 * `npc` entries with role "npc"; past events are the session /
 * decision / death / loot / quest summaries in order; open threads
 * are the unresolved thread summaries; notable deaths are the actors
 * of death entries. An empty store yields empty arrays — the planner
 * itself throws when it has no names to work with.
 */
export function toFloorPlannerChronicle(store: ChronicleStore): Chronicle {
  const partyMembers: string[] = [];
  const keyNpcs: string[] = [];
  const pastEvents: string[] = [];
  const notableDeaths: string[] = [];
  for (const e of store.entries) {
    if (e.kind === "npc") {
      for (const a of e.actors) {
        const list = e.role === "pc" ? partyMembers : keyNpcs;
        if (!list.includes(a)) list.push(a);
      }
    }
    if (["session", "decision", "death", "loot", "quest"].includes(e.kind)) {
      pastEvents.push(e.summary);
    }
    if (e.kind === "death") {
      for (const a of e.actors) {
        if (!notableDeaths.includes(a)) notableDeaths.push(a);
      }
    }
  }
  const chronicle: Chronicle = {
    partyMembers,
    keyNpcs,
    pastEvents,
    openThreads: listOpenThreads(store).map((t) => t.summary),
    notableDeaths,
  };
  if (store.campaign) chronicle.campaign = store.campaign;
  return chronicle;
}

/** One chronicle fact, ready to cite: the fact string + the entry it traces to. */
export interface ChronicleFact {
  fact: string;
  entryId: string;
  kind: ChronicleKind;
}

/**
 * Plain facts for a generator's story context (the encounter
 * generator's input, once it accepts chronicle facts). Each fact is
 * the entry summary — plus its session label when it has one — with
 * the entry id alongside, so the generated beat can cite it. `kinds`
 * narrows the facts (e.g. only deaths and betrayals for a revenge
 * hook); the default is every kind except `resolution` and `session`
 * entries, whose content lives in the entries they point at.
 */
export function chronicleFacts(
  store: ChronicleStore,
  opts: { kinds?: ChronicleKind[] } = {},
): ChronicleFact[] {
  const kinds = opts.kinds ?? CHRONICLE_KINDS.filter((k) => k !== "resolution" && k !== "session");
  return store.entries
    .filter((e) => kinds.includes(e.kind))
    .map((e) => ({
      fact: e.session ? `${e.summary} (${e.session})` : e.summary,
      entryId: e.id,
      kind: e.kind,
    }));
}

/**
 * The "previously on" summary, from the store only. Groups entries by
 * session (most recent first), then lists what is still open (threads
 * + debts). An empty store says so — it never invents a recap.
 */
export function renderRecap(
  store: ChronicleStore,
  opts: { session?: string; since?: string; limit?: number } = {},
): string {
  let entries = [...store.entries];
  if (opts.session) entries = entries.filter((e) => e.session === opts.session);
  if (opts.since) entries = entries.filter((e) => e.date >= opts.since!);
  const limited =
    opts.limit === undefined ? entries : opts.limit === 0 ? [] : entries.slice(-opts.limit);
  if (limited.length === 0) {
    return "Nothing has been chronicled yet — the chronicle is empty.";
  }
  const sessions = new Map<string, ChronicleEntry[]>();
  const unsessioned: ChronicleEntry[] = [];
  for (const e of limited) {
    if (e.session) {
      const list = sessions.get(e.session) ?? [];
      list.push(e);
      sessions.set(e.session, list);
    } else {
      unsessioned.push(e);
    }
  }
  const lines: string[] = ["📖 **Previously on…**"];
  const sessionNames = [...sessions.keys()].sort().reverse();
  for (const name of sessionNames) {
    lines.push(`\n**${name}**`);
    for (const e of sessions.get(name)!) {
      lines.push(`• ${e.summary}`);
    }
  }
  if (unsessioned.length > 0) {
    lines.push("\n**Undated**");
    for (const e of unsessioned) lines.push(`• ${e.summary}`);
  }
  const openThreads = listOpenThreads(store).filter((t) =>
    opts.session ? t.session === opts.session : true,
  );
  const openDebts = listOpenDebts(store);
  if (openThreads.length > 0 || openDebts.length > 0) {
    lines.push("\n**Still open**");
    for (const t of openThreads) lines.push(`• 🧵 ${t.summary}`);
    for (const d of openDebts) lines.push(`• 💰 ${d.summary}`);
  }
  return lines.join("\n");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Render one entry as HTML for its journal page. */
export function entryToJournalHtml(entry: ChronicleEntry): string {
  const meta: string[] = [`<b>Kind:</b> ${esc(entry.kind)}`, `<b>Date:</b> ${esc(entry.date)}`];
  if (entry.session) meta.push(`<b>Session:</b> ${esc(entry.session)}`);
  if (entry.actors.length > 0) meta.push(`<b>Actors:</b> ${esc(entry.actors.join(", "))}`);
  meta.push(`<b>Source:</b> ${esc(entry.source)}`);
  if (entry.refId) meta.push(`<b>Resolves:</b> ${esc(entry.refId)}`);
  return (
    `<h1>${esc(entry.summary)}</h1>` +
    `<p>${meta.join(" · ")}</p>` +
    (entry.detail ? `<p>${esc(entry.detail)}</p>` : "")
  );
}

/** Render the index page: open threads, debts, deaths, names. */
export function chronicleIndexHtml(store: ChronicleStore): string {
  const section = (heading: string, items: string[]): string =>
    items.length === 0 ? "" : `<h2>${heading}</h2><ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
  return (
    `<h1>Campaign Chronicle</h1>` +
    `<p><em>What actually happened — every entry traces to a source. Each entry has its own page.</em></p>` +
    section(
      "Open threads",
      listOpenThreads(store).map((t) => t.summary),
    ) +
    section(
      "Open debts",
      listOpenDebts(store).map((d) => d.summary),
    ) +
    section(
      "Notable deaths",
      queryEntries(store, { kind: "death" }).map((d) => d.summary),
    ) +
    section("Names", listNames(store)) +
    (store.entries.length === 0 ? `<p>No entries yet.</p>` : "")
  );
}

/** Serialize the store to JSON (the file / flags format). */
export function serializeChronicle(store: ChronicleStore): string {
  return JSON.stringify(store);
}

/**
 * Parse + validate a store from JSON. Unknown fields are dropped (the
 * entries are rebuilt from the whitelisted fields); a bad kind, an
 * empty summary/source, or a duplicate id is an error — a corrupt
 * store is never silently accepted.
 */
export function parseChronicle(json: string): ChronicleStore {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new ChronicleError(
      `Chronicle JSON is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ChronicleError("A chronicle must be a JSON object.");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new ChronicleError(`Unsupported chronicle version: ${String(obj.version)} (expected 1).`);
  }
  if (!Array.isArray(obj.entries)) {
    throw new ChronicleError("A chronicle needs an entries array.");
  }
  const seen = new Set<string>();
  const entries: ChronicleEntry[] = (obj.entries as unknown[]).map((item, i) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new ChronicleError(`Chronicle entry ${i} is not an object.`);
    }
    const e = item as Record<string, unknown>;
    if (typeof e.id !== "string" || !e.id.trim()) {
      throw new ChronicleError(`Chronicle entry ${i} needs an id.`);
    }
    if (seen.has(e.id)) throw new ChronicleError(`Duplicate chronicle entry id: ${e.id}`);
    seen.add(e.id);
    if (!CHRONICLE_KINDS.includes(e.kind as ChronicleKind)) {
      throw new ChronicleError(`Chronicle entry ${e.id} has an unknown kind: ${String(e.kind)}`);
    }
    if (typeof e.summary !== "string" || !e.summary.trim()) {
      throw new ChronicleError(`Chronicle entry ${e.id} needs a summary.`);
    }
    if (typeof e.source !== "string" || !e.source.trim()) {
      throw new ChronicleError(`Chronicle entry ${e.id} needs a source.`);
    }
    if (typeof e.date !== "string" || !e.date.trim()) {
      throw new ChronicleError(`Chronicle entry ${e.id} needs a date.`);
    }
    if (!Array.isArray(e.actors) || e.actors.some((a) => typeof a !== "string")) {
      throw new ChronicleError(`Chronicle entry ${e.id} needs an actors array of strings.`);
    }
    const entry: ChronicleEntry = {
      id: e.id,
      kind: e.kind as ChronicleKind,
      summary: (e.summary as string).trim(),
      actors: cleanActors(e.actors as string[]),
      date: (e.date as string).trim(),
      source: (e.source as string).trim(),
    };
    if (typeof e.detail === "string" && e.detail.trim()) entry.detail = e.detail.trim();
    if (typeof e.session === "string" && e.session.trim()) entry.session = e.session.trim();
    if (e.role === "pc" || e.role === "npc") entry.role = e.role;
    if (typeof e.refId === "string" && e.refId.trim()) entry.refId = e.refId.trim();
    return entry;
  });
  const store: ChronicleStore = { version: 1, entries };
  if (typeof obj.campaign === "string" && obj.campaign.trim()) {
    store.campaign = obj.campaign.trim();
  }
  return store;
}

/**
 * Turn a session recap into chronicle entries: one `session` entry
 * holding the recap text, one `death` entry per kill, one `loot` entry
 * per loot line. Sources cite the recap date and the source message
 * id, so every imported fact traces back to the chat log. Kill actors
 * are parsed best-effort from the recap's own phrasing ("X is down" /
 * "X dies" / "X falls" / "X is defeated") — unparseable kills keep an
 * empty actors list rather than a guessed name.
 */
export function recapToChronicleEntries(recap: Recap): AddEntryInput[] {
  const entries: AddEntryInput[] = [
    {
      kind: "session",
      summary: `${recap.title} — ${recap.date}`,
      detail: recapToText(recap),
      session: recap.date,
      date: recap.date,
      source: `Session recap ${recap.date}`,
    },
  ];
  const killName = (text: string): string | null => {
    const m = /^\s*(.+?)\s+(?:is down|dies|falls|is defeated|is dead)\b/i.exec(text);
    return m ? m[1].trim() : null;
  };
  for (const kill of recap.kills) {
    const name = killName(kill.text);
    entries.push({
      kind: "death",
      summary: kill.text,
      actors: name ? [name] : [],
      session: recap.date,
      date: recap.date,
      source: `Session recap ${recap.date} (message ${kill.messageId})`,
    });
  }
  for (const loot of recap.loot) {
    entries.push({
      kind: "loot",
      summary: loot.text,
      session: recap.date,
      date: recap.date,
      source: `Session recap ${recap.date} (message ${loot.messageId})`,
    });
  }
  return entries;
}

/**
 * A demo store, grounded in the Nov 19 session only: Merisiel fell to
 * Xulgath and Zolgran on the Landing; the party is Ezren, Kyra,
 * Merisiel, Valeros; the campaign is Menace Under Otari / Beginner
 * Box. No decisions or betrayals are invented — the demo has only
 * what the session record states.
 */
export function demoChronicle(): ChronicleStore {
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
    summary: "Kyra joins the party",
    actors: ["Kyra"],
    role: "pc",
    session: "2026-11-19",
    date: "2026-11-19",
    source: "Session recap 2026-11-19",
  });
  add({
    kind: "npc",
    summary: "Merisiel joins the party",
    actors: ["Merisiel"],
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
    summary: "Zolgran — Xulgath raider in the Landing",
    actors: ["Zolgran"],
    role: "npc",
    session: "2026-11-19",
    date: "2026-11-19",
    source: "Session recap 2026-11-19",
  });
  add({
    kind: "npc",
    summary: "Xulgath — raider in the Landing",
    actors: ["Xulgath"],
    role: "npc",
    session: "2026-11-19",
    date: "2026-11-19",
    source: "Session recap 2026-11-19",
  });
  add({
    kind: "session",
    summary: "Session 2026-11-19 — the Landing",
    detail: "Merisiel fell to Xulgath and Zolgran.",
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
    actors: ["Zolgran", "Xulgath"],
    session: "2026-11-19",
    date: "2026-11-19",
    source: "Beginner Box — session 2026-11-19",
  });
  return store;
}

// ---------------------------------------------------------------- live layer

/** Name of the JournalEntry that holds the chronicle. */
export const CHRONICLE_NAME = "Campaign Chronicle";

/** Title of the index page inside the chronicle entry. */
export const CHRONICLE_INDEX_PAGE = "Campaign Chronicle";

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

function entryFlags(entry: ChronicleEntry): Record<string, unknown> {
  return { "foundry-live": { chronicleEntryId: entry.id, entry } };
}

function pageEntry(page: RawJournalPage): ChronicleEntry | null {
  const flags = page.flags?.["foundry-live"] as { entry?: ChronicleEntry } | undefined;
  const entry = flags?.entry;
  if (!entry || typeof entry.id !== "string" || typeof entry.summary !== "string") return null;
  return entry;
}

/** Find the chronicle JournalEntry, if it exists. Flagged entries win over name matches. */
export function findChronicleEntry(live: FoundryLive): RawJournal | null {
  const journals = rawClient(live).getJournals();
  const flagged = journals.find(
    (j) => (j.flags?.["foundry-live"] as { chronicle?: boolean } | undefined)?.chronicle === true,
  );
  if (flagged) return flagged;
  return journals.find((j) => j.name === CHRONICLE_NAME) ?? null;
}

/**
 * Read the chronicle from the world. Entries come from page flags (the
 * source of truth), in page order; pages without an entry flag —
 * including the index page — are skipped. Returns the entry id (null
 * when no entry exists yet) and the store.
 */
export function readChronicle(live: FoundryLive): { entryId: string | null; store: ChronicleStore } {
  const entry = findChronicleEntry(live);
  if (!entry) return { entryId: null, store: emptyChronicle() };
  const entries: ChronicleEntry[] = [];
  for (const page of entry.pages ?? []) {
    const e = pageEntry(page);
    if (e) entries.push(e);
  }
  const campaign = (entry.flags?.["foundry-live"] as { campaign?: string } | undefined)?.campaign;
  return {
    entryId: entry._id,
    store: { version: 1, entries, ...(campaign ? { campaign } : {}) },
  };
}

/** Find an entry's page inside a journal entry, by entry-id flag. */
function findEntryPage(entry: RawJournal, entryId: string): RawJournalPage | undefined {
  return (entry.pages ?? []).find(
    (p) =>
      (p.flags?.["foundry-live"] as { chronicleEntryId?: string } | undefined)?.chronicleEntryId ===
      entryId,
  );
}

function findIndexPage(entry: RawJournal): RawJournalPage | undefined {
  return (entry.pages ?? []).find((p) => p.name === CHRONICLE_INDEX_PAGE);
}

/**
 * Create the chronicle entry if it doesn't exist yet (one index page,
 * `observer` so the party can read it), and flag it. Returns the entry id.
 */
export async function ensureChronicleEntry(live: FoundryLive, campaign?: string): Promise<string> {
  const existing = findChronicleEntry(live);
  if (existing) return existing._id;
  const created = await rawClient(live).createJournalEntry(
    CHRONICLE_NAME,
    [{ name: CHRONICLE_INDEX_PAGE, content: chronicleIndexHtml(emptyChronicle(campaign)) }],
    undefined,
    "observer",
  );
  await live.modifyDocument("JournalEntry", "update", {
    updates: [
      {
        _id: created._id,
        flags: { "foundry-live": { chronicle: true, ...(campaign ? { campaign } : {}) } },
      },
    ],
  });
  return created._id;
}

/** Write (create or update) one entry's page, then refresh the index page. */
async function writeEntryPage(
  live: FoundryLive,
  entryId: string,
  entry: ChronicleEntry,
): Promise<string> {
  const journal = findChronicleEntry(live);
  const existing = journal ? findEntryPage(journal, entry.id) : undefined;
  const content = entryToJournalHtml(entry);
  if (existing) {
    await live.modifyDocument("JournalEntryPage", "update", {
      updates: [{ _id: existing._id, text: { content }, flags: entryFlags(entry) }],
      parentUuid: `JournalEntry.${entryId}`,
    });
    return existing._id;
  }
  const created = await live.modifyDocument("JournalEntryPage", "create", {
    data: [
      {
        name: `${entry.kind}: ${entry.summary}`,
        type: "text",
        text: { content, format: 1 },
        flags: entryFlags(entry),
      },
    ],
    parentUuid: `JournalEntry.${entryId}`,
  });
  return String(created[0]._id);
}

/** Refresh the index page to match the current store. */
async function writeIndexPage(
  live: FoundryLive,
  entryId: string,
  store: ChronicleStore,
): Promise<void> {
  const journal = findChronicleEntry(live);
  const index = journal ? findIndexPage(journal) : undefined;
  if (!index) return; // The entry was created with one; a missing index is not fatal.
  await live.modifyDocument("JournalEntryPage", "update", {
    updates: [{ _id: index._id, text: { content: chronicleIndexHtml(store) } }],
    parentUuid: `JournalEntry.${entryId}`,
  });
}

/** Append an entry live: journal page + index refresh. Posts no chat line (see module header). */
export async function appendEntryLive(
  live: FoundryLive,
  input: AddEntryInput,
): Promise<{ entry: ChronicleEntry; pageId: string; entryId: string }> {
  const entryId = await ensureChronicleEntry(live);
  const { store } = readChronicle(live);
  const { store: next, entry } = appendEntry(store, input);
  const pageId = await writeEntryPage(live, entryId, entry);
  await writeIndexPage(live, entryId, next);
  return { entry, pageId, entryId };
}

/** Resolve a thread live (appends a resolution entry). No chat line. */
export async function resolveThreadLive(
  live: FoundryLive,
  threadId: string,
  summary: string,
  source: string,
): Promise<{ entry: ChronicleEntry | null; pageId: string | null; alreadyResolved: boolean }> {
  const entryId = await ensureChronicleEntry(live);
  const { store } = readChronicle(live);
  const { store: next, entry, alreadyResolved } = resolveThread(store, threadId, summary, source);
  if (alreadyResolved) return { entry, pageId: null, alreadyResolved: true };
  const pageId = await writeEntryPage(live, entryId, entry!);
  await writeIndexPage(live, entryId, next);
  return { entry, pageId, alreadyResolved: false };
}

/**
 * Import a session recap into the chronicle live: one session entry,
 * one death entry per kill, one loot entry per loot line. No chat line
 * — `postRecap` already announces the recap.
 */
export async function importRecapLive(
  live: FoundryLive,
  recap: Recap,
): Promise<{ entries: ChronicleEntry[]; entryId: string }> {
  const entryId = await ensureChronicleEntry(live);
  let { store } = readChronicle(live);
  const entries: ChronicleEntry[] = [];
  for (const input of recapToChronicleEntries(recap)) {
    const result = appendEntry(store, input);
    store = result.store;
    entries.push(result.entry);
    await writeEntryPage(live, entryId, result.entry);
  }
  await writeIndexPage(live, entryId, store);
  return { entries, entryId };
}

/** Read the chronicle and print the recap — no writes, no chat. */
export function readChronicleLive(live: FoundryLive): { entryId: string | null; store: ChronicleStore } {
  return readChronicle(live);
}
