/**
 * Downtime (BRA-204, P3) — between-session downtime handled in chat:
 * shopping, crafting, healing, training, and research, driven by
 * conversation with Muse instead of Foundry UI work.
 *
 * The module models downtime as data. It does not run the game:
 * - A downtime activity (shopping / crafting / healing / training /
 *   research) records its cost (gold), its time (days), and its outcome
 *   shape. Every activity carries a `source` (who asked for it, or
 *   what was said in chat); an activity without a source is rejected,
 *   so the ledger never silently gains plans nobody stated.
 * - A per-character ledger: each character's activities, what they
 *   spent, what they gained, what is still in progress. The party
 *   totals are derived, never stored separately.
 * - A chat-facing summary renderer: what happened, what it cost, what
 *   is ready next session.
 *
 * CRAFTING PERSISTS: a crafting / training / research activity tracks
 * `progressDays` against the days it needs. Partial progress is kept
 * in the activity and survives serialization and the live journal
 * round-trip — it never resets between sessions. When progress
 * reaches the required days the activity becomes `ready` (the thing
 * is done and waiting for next session); `completeActivity` then
 * records it as collected / finished.
 *
 * HEALING IS PROPOSED, NEVER APPLIED: the module carries the game's
 * rest rules as data (`REST_RULES`) and `proposeHealing` builds a
 * healing activity whose proposed outcome quotes the rule — but no HP
 * is ever computed or changed here. The GM confirms the proposal
 * (`confirmActivity`: proposed -> in-progress) and states the outcome
 * when it completes (`completeActivity` records the GM's words with
 * their source). Completing a still-proposed activity is an error:
 * the GM gate cannot be skipped. The GM's ruling always overrides
 * the recorded rule.
 *
 * LIFECYCLE: proposed -> in-progress -> ready -> complete, with
 * `cancelled` as the other terminal state. Shopping and healing
 * usually go proposed -> in-progress -> complete (no ready step);
 * crafting / training / research go through `ready` when the work
 * is done but the result has not been picked up yet. Completing an
 * already-completed activity is a no-op (`alreadyCompleted`); cancelling
 * an already-cancelled one is a no-op (`alreadyCancelled`). Completing
 * or cancelling across terminal states is an error.
 *
 * MONEY: `spentGp` counts only confirmed activities (in-progress,
 * ready, complete). A proposed activity costs nothing yet; a cancelled
 * one costs nothing. The ledger never claims gold was spent on a plan
 * the GM has not confirmed.
 *
 * Two layers, kept separate on purpose (same pattern as
 * src/session/questlog.ts and src/session/chronicle.ts):
 * - Pure functions (startActivity / confirmActivity / advanceActivity /
 *   completeActivity / cancelActivity / proposeHealing / spentGp /
 *   characterLedger / summarizeDowntime / serializeLedger /
 *   parseLedger / ...): no Foundry, no I/O, unit tested in
 *   tests/downtime.test.ts. All ops are immutable — they return a new
 *   ledger and never mutate the input.
 * - Live functions (*Live): thin wrappers over FoundryLive. The ledger
 *   is persisted as a JournalEntry named "Downtime Ledger" (created
 *   `observer` so the party can read it), one JournalEntryPage per
 *   character. Each page carries that character's activities JSON in
 *   `flags["foundry-live"].downtime` — the flags are the source of
 *   truth and the HTML is only the display — so reading the ledger
 *   back never has to parse HTML. A first page named "Downtime Ledger"
 *   is the index.
 */
import type { FoundryLive } from "../live.js";

/** What a character can do between sessions. */
export type DowntimeKind = "shopping" | "crafting" | "healing" | "training" | "research";

export const DOWNTIME_KINDS: readonly DowntimeKind[] = [
  "shopping",
  "crafting",
  "healing",
  "training",
  "research",
];

/** Lifecycle states. `ready` means the work is done and waiting for next session. */
export type DowntimeStatus = "proposed" | "in-progress" | "ready" | "complete" | "cancelled";

export const DOWNTIME_STATUSES: readonly DowntimeStatus[] = [
  "proposed",
  "in-progress",
  "ready",
  "complete",
  "cancelled",
];

/** Kinds whose work is measured in days and can be `ready`. */
const PROGRESS_KINDS: readonly DowntimeKind[] = ["crafting", "training", "research"];

/** One downtime activity. */
export interface DowntimeActivity {
  id: string;
  kind: DowntimeKind;
  /** Whose downtime this is (a PC name). */
  character: string;
  /** One line: what the character is doing ("Buy a healing potion"). */
  title: string;
  /** Longer detail, when one line is not enough. Optional. */
  detail?: string;
  status: DowntimeStatus;
  /** Gold the activity costs. 0 / absent means free. Only counts once confirmed. */
  costGp?: number;
  /** Downtime days the activity needs (0 for instant shopping). */
  days: number;
  /** Days of work done so far. Persists across sessions; never resets. */
  progressDays: number;
  /** What Muse proposes the outcome will be — the GM confirms it. For healing: the rest rule. */
  proposedOutcome?: string;
  /** What actually happened — recorded at completion, in the GM's words. */
  outcome?: string;
  /** Who confirmed the completion, or what was said when it completed. Set at completion; the original `source` is kept. */
  completedSource?: string;
  /** Who asked for this, or what was said in chat. Required. */
  source: string;
  /** ISO date the activity was proposed. */
  createdAt: string;
  /** ISO date the activity completed, once it has. */
  completedAt?: string;
}

/** The whole ledger: every downtime activity the party has ever proposed. */
export interface DowntimeLedger {
  version: 1;
  campaign?: string;
  activities: DowntimeActivity[];
}

/** Validation / lookup failure. */
export class DowntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DowntimeError";
  }
}

/** An empty ledger. */
export function emptyLedger(campaign?: string): DowntimeLedger {
  return campaign ? { version: 1, campaign, activities: [] } : { version: 1, activities: [] };
}

function cloneLedger(ledger: DowntimeLedger): DowntimeLedger {
  return {
    ...ledger,
    activities: ledger.activities.map((a) => ({ ...a })),
  };
}

/** Slugify a string into a stable id fragment ("Valeros" -> "valeros"). */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "item";
}

function activityId(character: string, title: string): string {
  return `${slugify(character)}-${slugify(title)}`;
}

function findActivityOrThrow(ledger: DowntimeLedger, activityId: string): DowntimeActivity {
  const activity = ledger.activities.find((a) => a.id === activityId);
  if (!activity) throw new DowntimeError(`Unknown downtime activity: ${activityId}`);
  return activity;
}

function requireSource(source: string | undefined): string {
  if (!source?.trim()) {
    throw new DowntimeError(
      "Downtime needs a source — who asked for this, or what was said in chat.",
    );
  }
  return source.trim();
}

/** Input for proposing an activity. `character`, `title`, and `source` are required. */
export interface StartActivityInput {
  kind: DowntimeKind;
  character: string;
  title: string;
  detail?: string;
  /** Gold cost; defaults to 0 (free). Must be >= 0. */
  costGp?: number;
  /** Days the activity needs; defaults to 0. Must be a whole number >= 0. */
  days?: number;
  /** What Muse proposes the outcome will be — the GM confirms it. */
  proposedOutcome?: string;
  source: string;
  /** ISO date; defaults to today. */
  createdAt?: string;
}

/**
 * Propose a downtime activity. The new activity starts `proposed` —
 * nothing takes effect until the GM confirms it. Throws on an unknown
 * kind, an empty character/title, a missing source, a negative cost,
 * a non-whole or negative day count, a progress kind (crafting /
 * training / research) with 0 days, or a duplicate id (same character
 * + same title — rename one first).
 */
export function startActivity(
  ledger: DowntimeLedger,
  input: StartActivityInput,
): { ledger: DowntimeLedger; activity: DowntimeActivity } {
  if (!DOWNTIME_KINDS.includes(input.kind)) {
    throw new DowntimeError(
      `Unknown downtime kind: ${String(input.kind)} (known: ${DOWNTIME_KINDS.join(", ")})`,
    );
  }
  const character = input.character.trim();
  if (!character) throw new DowntimeError("A downtime activity needs a character.");
  const title = input.title.trim();
  if (!title) throw new DowntimeError("A downtime activity needs a title.");
  const source = requireSource(input.source);
  const costGp = input.costGp ?? 0;
  if (!Number.isFinite(costGp) || costGp < 0) {
    throw new DowntimeError(`A downtime activity's cost must be 0 or more gp, got ${String(input.costGp)}.`);
  }
  const days = input.days ?? 0;
  if (!Number.isInteger(days) || days < 0) {
    throw new DowntimeError(`A downtime activity's days must be a whole number >= 0, got ${String(input.days)}.`);
  }
  if (PROGRESS_KINDS.includes(input.kind) && days < 1) {
    throw new DowntimeError(
      `A ${input.kind} activity needs at least 1 day — it is measured in days of work.`,
    );
  }
  const id = activityId(character, title);
  if (ledger.activities.some((a) => a.id === id)) {
    throw new DowntimeError(
      `A downtime activity with id "${id}" already exists — rename the new activity first.`,
    );
  }
  const activity: DowntimeActivity = {
    id,
    kind: input.kind,
    character,
    title,
    status: "proposed",
    days,
    progressDays: 0,
    source,
    createdAt: input.createdAt ?? new Date().toISOString().slice(0, 10),
  };
  if (input.detail?.trim()) activity.detail = input.detail.trim();
  if (costGp > 0) activity.costGp = costGp;
  if (input.proposedOutcome?.trim()) activity.proposedOutcome = input.proposedOutcome.trim();
  const next = cloneLedger(ledger);
  next.activities.push(activity);
  return { ledger: next, activity };
}

/**
 * The GM confirms a proposed activity: proposed -> in-progress. This
 * is the gate — nothing is spent, worked on, or healed until the GM
 * says so. Throws unless the activity is still proposed.
 */
export function confirmActivity(
  ledger: DowntimeLedger,
  id: string,
): { ledger: DowntimeLedger; activity: DowntimeActivity } {
  const activity = findActivityOrThrow(ledger, id);
  if (activity.status !== "proposed") {
    throw new DowntimeError(
      `Cannot confirm "${activity.title}" — it is ${activity.status}, not proposed.`,
    );
  }
  const next = cloneLedger(ledger);
  const a = next.activities.find((x) => x.id === id)!;
  a.status = "in-progress";
  return { ledger: next, activity: a };
}

/**
 * Advance a crafting / training / research activity by `days` of work.
 * Partial progress persists — calling this twice adds up, it never
 * resets. When progress reaches the days the activity needs, the
 * activity becomes `ready` (the thing is done, waiting for next
 * session). Returns the activity and whether it just became ready.
 * Throws unless the activity is in-progress, is a progress kind, and
 * `days` is a whole number >= 1.
 */
export function advanceActivity(
  ledger: DowntimeLedger,
  id: string,
  days: number,
  source: string,
): { ledger: DowntimeLedger; activity: DowntimeActivity; becameReady: boolean } {
  const activity = findActivityOrThrow(ledger, id);
  if (activity.status !== "in-progress") {
    throw new DowntimeError(
      `Cannot advance "${activity.title}" — it is ${activity.status}, not in-progress.`,
    );
  }
  if (!PROGRESS_KINDS.includes(activity.kind)) {
    throw new DowntimeError(
      `Cannot advance a ${activity.kind} activity — only crafting, training, and research track progress in days.`,
    );
  }
  if (!Number.isInteger(days) || days < 1) {
    throw new DowntimeError(`Advance by a whole number of days >= 1, got ${String(days)}.`);
  }
  requireSource(source);
  const next = cloneLedger(ledger);
  const a = next.activities.find((x) => x.id === id)!;
  a.progressDays = Math.min(a.progressDays + days, a.days);
  const becameReady = a.progressDays >= a.days;
  if (becameReady) a.status = "ready";
  return { ledger: next, activity: a, becameReady };
}

/**
 * Complete an activity. The outcome is recorded in the GM's (or
 * player's) words, with its source — the module never computes an
 * outcome itself. For healing this is where the rest result is
 * stated ("Long rest: back to full HP, regained 2 Hit Dice").
 * Completing an already-completed activity is a no-op
 * (`alreadyCompleted: true`). Completing a proposed activity is an
 * error — confirm it first. Completing a cancelled activity is an
 * error. `completedAt` defaults to today.
 */
export function completeActivity(
  ledger: DowntimeLedger,
  id: string,
  outcome: string,
  source: string,
  completedAt?: string,
): { ledger: DowntimeLedger; activity: DowntimeActivity; alreadyCompleted: boolean } {
  const activity = findActivityOrThrow(ledger, id);
  if (activity.status === "complete") {
    return { ledger, activity, alreadyCompleted: true };
  }
  if (activity.status === "proposed") {
    throw new DowntimeError(
      `Cannot complete "${activity.title}" — it is still proposed. The GM must confirm it first.`,
    );
  }
  if (activity.status === "cancelled") {
    throw new DowntimeError(`Cannot complete "${activity.title}" — it was cancelled.`);
  }
  if (!outcome.trim()) {
    throw new DowntimeError("Completing a downtime activity needs an outcome — what actually happened.");
  }
  const src = requireSource(source);
  const next = cloneLedger(ledger);
  const a = next.activities.find((x) => x.id === id)!;
  a.status = "complete";
  a.outcome = outcome.trim();
  // The completion source is recorded separately — the original
  // `source` (who asked for it) is provenance and must survive.
  a.completedSource = src;
  a.completedAt = completedAt ?? new Date().toISOString().slice(0, 10);
  return { ledger: next, activity: a, alreadyCompleted: false };
}

/**
 * Cancel an activity. Cancelling an already-cancelled activity is a
 * no-op (`alreadyCancelled: true`). Cancelling a completed activity
 * is an error — completed work stays completed.
 */
export function cancelActivity(
  ledger: DowntimeLedger,
  id: string,
  source: string,
): { ledger: DowntimeLedger; activity: DowntimeActivity; alreadyCancelled: boolean } {
  const activity = findActivityOrThrow(ledger, id);
  if (activity.status === "cancelled") {
    return { ledger, activity, alreadyCancelled: true };
  }
  if (activity.status === "complete") {
    throw new DowntimeError(`Cannot cancel "${activity.title}" — it is already complete.`);
  }
  requireSource(source);
  const next = cloneLedger(ledger);
  const a = next.activities.find((x) => x.id === id)!;
  a.status = "cancelled";
  return { ledger: next, activity: a, alreadyCancelled: false };
}

/** Find an activity by id, or undefined. */
export function getActivity(ledger: DowntimeLedger, id: string): DowntimeActivity | undefined {
  return ledger.activities.find((a) => a.id === id);
}

/** Filter for listing activities. All filters are ANDed. */
export interface ActivityQuery {
  character?: string;
  kind?: DowntimeKind;
  status?: DowntimeStatus;
}

/** Activities matching the query, in ledger order. */
export function listActivities(ledger: DowntimeLedger, query: ActivityQuery = {}): DowntimeActivity[] {
  return ledger.activities.filter((a) => {
    if (query.character && a.character !== query.character) return false;
    if (query.kind && a.kind !== query.kind) return false;
    if (query.status && a.status !== query.status) return false;
    return true;
  });
}

/** Every character with at least one activity, first-seen order. */
export function listCharacters(ledger: DowntimeLedger): string[] {
  const out: string[] = [];
  for (const a of ledger.activities) {
    if (!out.includes(a.character)) out.push(a.character);
  }
  return out;
}

/** One character's slice of the ledger: their activities, what they spent, what they gained. */
export interface CharacterLedger {
  character: string;
  activities: DowntimeActivity[];
  /** Gold spent: cost of confirmed activities only (in-progress / ready / complete). */
  spentGp: number;
  /** What the character gained: the recorded outcomes of completed activities. */
  gained: string[];
  /** Days of work still owed on in-progress activities (days - progressDays, summed). */
  daysRemaining: number;
}

/**
 * Gold spent — the cost of confirmed activities only (in-progress,
 * ready, complete). A proposed activity costs nothing yet; a
 * cancelled one costs nothing. Pass a character to total for one
 * character, or omit it for the whole party.
 */
export function spentGp(ledger: DowntimeLedger, character?: string): number {
  return ledger.activities
    .filter((a) => a.status !== "proposed" && a.status !== "cancelled")
    .filter((a) => !character || a.character === character)
    .reduce((sum, a) => sum + (a.costGp ?? 0), 0);
}

/** One character's ledger view, derived from the whole ledger. */
export function characterLedger(ledger: DowntimeLedger, character: string): CharacterLedger {
  const activities = listActivities(ledger, { character });
  return {
    character,
    activities,
    spentGp: spentGp(ledger, character),
    gained: activities
      .filter((a) => a.status === "complete" && a.outcome)
      .map((a) => a.outcome!),
    daysRemaining: activities
      .filter((a) => a.status === "in-progress" && PROGRESS_KINDS.includes(a.kind))
      .reduce((sum, a) => sum + (a.days - a.progressDays), 0),
  };
}

// ---------------------------------------------------------------- rest rules (data, not automation)

/**
 * The game's rest rules, as data the GM confirms — not as automation.
 * PF2e (the campaign's system) has no short/long rest split: recovery
 * comes from resting 8 hours, or from Treat Wounds / magic. The
 * numbers below are the recorded rule text; the GM's ruling always
 * overrides them, and this module never applies HP itself — it only
 * proposes, and records what the GM says happened.
 */
export interface RestRule {
  /** Key for the CLI / chat ("rest8h", "treatWounds"). */
  key: string;
  /** Display name. */
  name: string;
  /** The rule, as recorded here. */
  rule: string;
  system: string;
}

export const REST_RULES: readonly RestRule[] = [
  {
    key: "rest8h",
    name: "Rest (8 hours)",
    rule: "Recover HP equal to your level × your Constitution modifier (minimum 1 HP). You can rest this way only once per day.",
    system: "PF2e",
  },
  {
    key: "treatWounds",
    name: "Treat Wounds",
    rule: "Medicine check (DC 15): on a success restore 2d8 HP, on a critical success 2d8+10 HP; once per hour per creature. Requires healer's tools.",
    system: "PF2e",
  },
];

/** Find a rest rule by key, or undefined. */
export function getRestRule(key: string): RestRule | undefined {
  return REST_RULES.find((r) => r.key === key);
}

/**
 * Propose a healing activity: a `proposed` activity whose
 * proposedOutcome quotes the rest rule it rests on, so the GM can
 * confirm (or overrule) it. The activity still needs `confirmActivity`
 * and then `completeActivity` with the GM's stated outcome — nothing
 * is healed by proposing it.
 */
export function proposeHealing(
  ledger: DowntimeLedger,
  input: {
    character: string;
    rest: string;
    title?: string;
    detail?: string;
    costGp?: number;
    source: string;
    createdAt?: string;
  },
): { ledger: DowntimeLedger; activity: DowntimeActivity } {
  const rule = getRestRule(input.rest);
  if (!rule) {
    throw new DowntimeError(
      `Unknown rest rule: ${input.rest} (known: ${REST_RULES.map((r) => r.key).join(", ")}).`,
    );
  }
  const title = input.title?.trim() || rule.name;
  return startActivity(ledger, {
    kind: "healing",
    character: input.character,
    title,
    detail: input.detail,
    costGp: input.costGp,
    days: 0,
    proposedOutcome: `${rule.system} — ${rule.name}: ${rule.rule} (GM confirms; the GM's ruling overrides this.)`,
    source: input.source,
    createdAt: input.createdAt,
  });
}

// ---------------------------------------------------------------- rendering

/** Render one activity as chat text. */
export function activityToText(activity: DowntimeActivity): string {
  const status =
    activity.status === "proposed"
      ? "❓ Proposed (needs GM confirmation)"
      : activity.status === "in-progress"
        ? "🔨 In progress"
        : activity.status === "ready"
          ? "✅ Ready for next session"
          : activity.status === "complete"
            ? "🏁 Complete"
            : "🚫 Cancelled";
  const lines: string[] = [`**${activity.title}** — ${activity.character} (${activity.kind}) — ${status}`];
  if (activity.detail) lines.push(activity.detail);
  const cost: string[] = [];
  if ((activity.costGp ?? 0) > 0) cost.push(`${activity.costGp} gp`);
  if (activity.days > 0) {
    cost.push(
      activity.progressDays > 0
        ? `${activity.progressDays}/${activity.days} days`
        : `${activity.days} day${activity.days === 1 ? "" : "s"}`,
    );
  }
  if (cost.length > 0) lines.push(`Cost: ${cost.join(" · ")}`);
  if (activity.proposedOutcome && activity.status === "proposed") {
    lines.push(`Proposed outcome: ${activity.proposedOutcome}`);
  }
  if (activity.outcome) lines.push(`Outcome: ${activity.outcome}`);
  lines.push(`Source: ${activity.source}`);
  return lines.join("\n");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Render one activity as HTML for its character's journal page. */
export function activityToJournalHtml(activity: DowntimeActivity): string {
  const rows: string[] = [
    `<b>Kind:</b> ${esc(activity.kind)}`,
    `<b>Status:</b> ${esc(activity.status)}`,
    `<b>Added:</b> ${esc(activity.createdAt)}`,
  ];
  if ((activity.costGp ?? 0) > 0) rows.push(`<b>Cost:</b> ${esc(String(activity.costGp))} gp`);
  if (activity.days > 0) {
    rows.push(`<b>Time:</b> ${activity.progressDays}/${activity.days} days`);
  }
  if (activity.completedAt) rows.push(`<b>Completed:</b> ${esc(activity.completedAt)}`);
  if (activity.completedSource) {
    rows.push(`<b>Completion source:</b> ${esc(activity.completedSource)}`);
  }
  rows.push(`<b>Source:</b> ${esc(activity.source)}`);
  return (
    `<h2>${esc(activity.title)}</h2>` +
    `<p>${rows.join(" · ")}</p>` +
    (activity.detail ? `<p>${esc(activity.detail)}</p>` : "") +
    (activity.proposedOutcome ? `<p><b>Proposed outcome:</b> ${esc(activity.proposedOutcome)}</p>` : "") +
    (activity.outcome ? `<p><b>Outcome:</b> ${esc(activity.outcome)}</p>` : "")
  );
}

/** Render one character's page: their activities, spent, gained, still owed. */
export function characterLedgerHtml(ledger: DowntimeLedger, character: string): string {
  const view = characterLedger(ledger, character);
  const activityList =
    view.activities.length > 0
      ? view.activities.map((a) => activityToJournalHtml(a)).join("")
      : `<p>No downtime yet.</p>`;
  return (
    `<h1>${esc(character)} — Downtime</h1>` +
    `<p><b>Spent:</b> ${view.spentGp} gp · <b>Days of work still owed:</b> ${view.daysRemaining}</p>` +
    (view.gained.length > 0
      ? `<h2>Gained</h2><ul>${view.gained.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>`
      : "") +
    activityList
  );
}

/** Render the index page: every character with their spent total and what is ready / proposed. */
export function downtimeIndexHtml(ledger: DowntimeLedger): string {
  const chars = listCharacters(ledger);
  const rows = chars
    .map((c) => {
      const view = characterLedger(ledger, c);
      const ready = view.activities.filter((a) => a.status === "ready").length;
      const proposed = view.activities.filter((a) => a.status === "proposed").length;
      const extra: string[] = [];
      if (ready > 0) extra.push(`${ready} ready`);
      if (proposed > 0) extra.push(`${proposed} awaiting GM confirmation`);
      return `<li><b>${esc(c)}</b> — spent ${view.spentGp} gp${extra.length > 0 ? ` · ${extra.join(" · ")}` : ""}</li>`;
    })
    .join("");
  return (
    `<h1>Downtime Ledger</h1>` +
    `<p><em>What the party did between sessions — shopping, crafting, healing, training, research. Proposed work costs nothing until the GM confirms it; healing is proposed from the rest rules and confirmed by the GM, never applied silently.</em></p>` +
    (chars.length === 0 ? `<p>No downtime yet.</p>` : `<ul>${rows}</ul>`)
  );
}

/**
 * The chat-facing summary: what happened, what it cost, what is ready
 * next session. Sections appear only when they have content; an empty
 * ledger says so. Proposed work is listed separately as awaiting GM
 * confirmation — it is not presented as done or spent.
 */
export function summarizeDowntime(ledger: DowntimeLedger): string {
  const lines: string[] = ["🌙 **Downtime**"];
  if (ledger.activities.length === 0) {
    lines.push("No downtime yet — nothing proposed, spent, or finished between sessions.");
    return lines.join("\n");
  }
  const done = listActivities(ledger, { status: "complete" });
  if (done.length > 0) {
    lines.push("\n**What happened**");
    for (const a of done) {
      lines.push(`• ${a.character} — ${a.title}${a.outcome ? `: ${a.outcome}` : ""}`);
    }
  }
  const totalSpent = spentGp(ledger);
  if (totalSpent > 0) {
    lines.push("\n**What it cost**");
    for (const c of listCharacters(ledger)) {
      const spent = spentGp(ledger, c);
      if (spent > 0) lines.push(`• ${c}: ${spent} gp`);
    }
    if (listCharacters(ledger).length > 1) lines.push(`Total: ${totalSpent} gp`);
  }
  const ready = listActivities(ledger, { status: "ready" });
  if (ready.length > 0) {
    lines.push("\n**Ready next session**");
    for (const a of ready) lines.push(`• ${a.character} — ${a.title}`);
  }
  const inProgress = listActivities(ledger, { status: "in-progress" });
  if (inProgress.length > 0) {
    lines.push("\n**Still in progress**");
    for (const a of inProgress) {
      const progress =
        PROGRESS_KINDS.includes(a.kind) && a.days > 0
          ? ` (${a.progressDays}/${a.days} days)`
          : "";
      lines.push(`• ${a.character} — ${a.title}${progress}`);
    }
  }
  const proposed = listActivities(ledger, { status: "proposed" });
  if (proposed.length > 0) {
    lines.push("\n**Awaiting GM confirmation**");
    for (const a of proposed) {
      lines.push(`• ${a.character} — ${a.title} (${a.kind})`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- serialization

/** Serialize the ledger to JSON (the file / flags format). */
export function serializeLedger(ledger: DowntimeLedger): string {
  return JSON.stringify(ledger);
}

/**
 * Parse + validate a ledger from JSON. Unknown fields are dropped (the
 * activities are rebuilt from the whitelisted fields); a bad kind or
 * status, an empty character/title/source, a negative cost, a bad day
 * count, or a duplicate id is an error — a corrupt ledger is never
 * silently accepted. Progress days survive the round-trip.
 */
export function parseLedger(json: string): DowntimeLedger {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new DowntimeError(
      `Downtime ledger JSON is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new DowntimeError("A downtime ledger must be a JSON object.");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new DowntimeError(`Unsupported downtime ledger version: ${String(obj.version)} (expected 1).`);
  }
  if (!Array.isArray(obj.activities)) {
    throw new DowntimeError("A downtime ledger needs an activities array.");
  }
  const seen = new Set<string>();
  const activities: DowntimeActivity[] = (obj.activities as unknown[]).map((item, i) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new DowntimeError(`Downtime activity ${i} is not an object.`);
    }
    const e = item as Record<string, unknown>;
    if (typeof e.id !== "string" || !e.id.trim()) {
      throw new DowntimeError(`Downtime activity ${i} needs an id.`);
    }
    if (seen.has(e.id)) throw new DowntimeError(`Duplicate downtime activity id: ${e.id}`);
    seen.add(e.id);
    if (!DOWNTIME_KINDS.includes(e.kind as DowntimeKind)) {
      throw new DowntimeError(`Downtime activity ${e.id} has an unknown kind: ${String(e.kind)}`);
    }
    if (!DOWNTIME_STATUSES.includes(e.status as DowntimeStatus)) {
      throw new DowntimeError(`Downtime activity ${e.id} has an unknown status: ${String(e.status)}`);
    }
    if (typeof e.character !== "string" || !e.character.trim()) {
      throw new DowntimeError(`Downtime activity ${e.id} needs a character.`);
    }
    if (typeof e.title !== "string" || !e.title.trim()) {
      throw new DowntimeError(`Downtime activity ${e.id} needs a title.`);
    }
    if (typeof e.source !== "string" || !e.source.trim()) {
      throw new DowntimeError(`Downtime activity ${e.id} needs a source.`);
    }
    if (typeof e.createdAt !== "string" || !e.createdAt.trim()) {
      throw new DowntimeError(`Downtime activity ${e.id} needs a createdAt date.`);
    }
    const days = e.days;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 0) {
      throw new DowntimeError(`Downtime activity ${e.id} needs a whole number of days >= 0.`);
    }
    const progressDays = e.progressDays;
    if (typeof progressDays !== "number" || !Number.isInteger(progressDays) || progressDays < 0) {
      throw new DowntimeError(`Downtime activity ${e.id} needs a whole number of progress days >= 0.`);
    }
    if (progressDays > days) {
      throw new DowntimeError(
        `Downtime activity ${e.id} has more progress days (${progressDays}) than days needed (${days}).`,
      );
    }
    if (e.costGp !== undefined && (typeof e.costGp !== "number" || e.costGp < 0)) {
      throw new DowntimeError(`Downtime activity ${e.id} needs a cost of 0 or more gp.`);
    }
    const activity: DowntimeActivity = {
      id: e.id,
      kind: e.kind as DowntimeKind,
      character: (e.character as string).trim(),
      title: (e.title as string).trim(),
      status: e.status as DowntimeStatus,
      days,
      progressDays,
      source: (e.source as string).trim(),
      createdAt: (e.createdAt as string).trim(),
    };
    if (typeof e.detail === "string" && e.detail.trim()) activity.detail = e.detail.trim();
    if (typeof e.costGp === "number" && e.costGp > 0) activity.costGp = e.costGp;
    if (typeof e.proposedOutcome === "string" && e.proposedOutcome.trim()) {
      activity.proposedOutcome = e.proposedOutcome.trim();
    }
    if (typeof e.outcome === "string" && e.outcome.trim()) activity.outcome = e.outcome.trim();
    if (typeof e.completedSource === "string" && e.completedSource.trim()) {
      activity.completedSource = e.completedSource.trim();
    }
    if (typeof e.completedAt === "string" && e.completedAt.trim()) {
      activity.completedAt = e.completedAt.trim();
    }
    return activity;
  });
  const ledger: DowntimeLedger = { version: 1, activities };
  if (typeof obj.campaign === "string" && obj.campaign.trim()) {
    ledger.campaign = obj.campaign.trim();
  }
  return ledger;
}

/**
 * A demo ledger, clearly labeled as demo data: Valeros shops, Ezren
 * crafts a sword across two sessions of partial progress, Kyra trains,
 * and Merisiel's rest is proposed but not yet confirmed — the healing
 * gate, shown on purpose. No real session facts are claimed.
 */
export function demoLedger(): DowntimeLedger {
  let ledger = emptyLedger("Menace Under Otari");
  const start = (input: StartActivityInput): void => {
    ledger = startActivity(ledger, input).ledger;
  };
  start({
    kind: "shopping",
    character: "Valeros",
    title: "Buy a healing potion",
    costGp: 4,
    source: "Demo — Valeros asked in chat between sessions",
    createdAt: "2026-11-20",
  });
  ledger = confirmActivity(ledger, "valeros-buy-a-healing-potion").ledger;
  ledger = completeActivity(
    ledger,
    "valeros-buy-a-healing-potion",
    "Bought a minor healing potion from the Otari market (4 gp).",
    "Demo — GM confirmed the purchase in chat",
    "2026-11-20",
  ).ledger;
  start({
    kind: "crafting",
    character: "Ezren",
    title: "Craft a +1 longsword",
    detail: "At the Otari smithy, using the party's salvaged steel.",
    costGp: 35,
    days: 4,
    source: "Demo — Ezren asked in chat between sessions",
    createdAt: "2026-11-20",
  });
  ledger = confirmActivity(ledger, "ezren-craft-a-1-longsword").ledger;
  // Two sessions of partial progress: 1 day, then 2 more — progress
  // adds up (3/4) and does not reset between sessions.
  ledger = advanceActivity(ledger, "ezren-craft-a-1-longsword", 1, "Demo — session 1 downtime").ledger;
  ledger = advanceActivity(ledger, "ezren-craft-a-1-longsword", 2, "Demo — session 2 downtime").ledger;
  start({
    kind: "training",
    character: "Kyra",
    title: "Train with the town guard",
    days: 3,
    source: "Demo — Kyra asked in chat between sessions",
    createdAt: "2026-11-20",
  });
  ledger = confirmActivity(ledger, "kyra-train-with-the-town-guard").ledger;
  ledger = advanceActivity(ledger, "kyra-train-with-the-town-guard", 1, "Demo — session 1 downtime").ledger;
  const healing = proposeHealing(ledger, {
    character: "Merisiel",
    rest: "rest8h",
    source: "Demo — Merisiel asked to rest between sessions",
    createdAt: "2026-11-20",
  });
  ledger = healing.ledger;
  return ledger;
}

// ---------------------------------------------------------------- live layer

/** Name of the JournalEntry that holds the downtime ledger. */
export const DOWNTIME_NAME = "Downtime Ledger";

/** Title of the index page inside the downtime entry. */
export const DOWNTIME_INDEX_PAGE = "Downtime Ledger";

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

function characterFlags(character: string, activities: DowntimeActivity[]): Record<string, unknown> {
  return { "foundry-live": { downtimeCharacter: character, downtime: activities } };
}

function pageActivities(page: RawJournalPage): { character: string; activities: DowntimeActivity[] } | null {
  const flags = page.flags?.["foundry-live"] as
    | { downtimeCharacter?: string; downtime?: DowntimeActivity[] }
    | undefined;
  const character = flags?.downtimeCharacter;
  const activities = flags?.downtime;
  if (!character || !Array.isArray(activities)) return null;
  return { character, activities };
}

/** Find the downtime JournalEntry, if it exists. Flagged entries win over name matches. */
export function findDowntimeEntry(live: FoundryLive): RawJournal | null {
  const journals = rawClient(live).getJournals();
  const flagged = journals.find(
    (j) => (j.flags?.["foundry-live"] as { downtime?: boolean } | undefined)?.downtime === true,
  );
  if (flagged) return flagged;
  return journals.find((j) => j.name === DOWNTIME_NAME) ?? null;
}

/**
 * Read the downtime ledger from the world. Activities come from page
 * flags (the source of truth); pages without a downtime flag —
 * including the index page — are skipped. Returns the entry id (null
 * when no entry exists yet) and the ledger.
 */
export function readDowntime(live: FoundryLive): { entryId: string | null; ledger: DowntimeLedger } {
  const entry = findDowntimeEntry(live);
  if (!entry) return { entryId: null, ledger: emptyLedger() };
  const activities: DowntimeActivity[] = [];
  for (const page of entry.pages ?? []) {
    const parsed = pageActivities(page);
    if (parsed) activities.push(...parsed.activities);
  }
  const campaign = (entry.flags?.["foundry-live"] as { campaign?: string } | undefined)?.campaign;
  return {
    entryId: entry._id,
    ledger: { version: 1, activities, ...(campaign ? { campaign } : {}) },
  };
}

/** Find a character's page inside an entry, by character flag. */
function findCharacterPage(entry: RawJournal, character: string): RawJournalPage | undefined {
  return (entry.pages ?? []).find(
    (p) =>
      (p.flags?.["foundry-live"] as { downtimeCharacter?: string } | undefined)
        ?.downtimeCharacter === character,
  );
}

function findIndexPage(entry: RawJournal): RawJournalPage | undefined {
  return (entry.pages ?? []).find((p) => p.name === DOWNTIME_INDEX_PAGE);
}

/**
 * Create the downtime entry if it doesn't exist yet (one index page,
 * `observer` so the party can read it), and flag it. Returns the entry id.
 */
export async function ensureDowntimeEntry(live: FoundryLive, campaign?: string): Promise<string> {
  const existing = findDowntimeEntry(live);
  if (existing) return existing._id;
  const created = await rawClient(live).createJournalEntry(
    DOWNTIME_NAME,
    [{ name: DOWNTIME_INDEX_PAGE, content: downtimeIndexHtml(emptyLedger(campaign)) }],
    undefined,
    "observer",
  );
  await live.modifyDocument("JournalEntry", "update", {
    updates: [
      {
        _id: created._id,
        flags: { "foundry-live": { downtime: true, ...(campaign ? { campaign } : {}) } },
      },
    ],
  });
  return created._id;
}

/** Write (create or update) one character's page, then refresh the index page. */
async function writeCharacterPage(
  live: FoundryLive,
  entryId: string,
  ledger: DowntimeLedger,
  character: string,
): Promise<string> {
  const entry = findDowntimeEntry(live);
  const existing = entry ? findCharacterPage(entry, character) : undefined;
  const activities = listActivities(ledger, { character });
  const content = characterLedgerHtml(ledger, character);
  if (existing) {
    await live.modifyDocument("JournalEntryPage", "update", {
      updates: [
        { _id: existing._id, text: { content }, flags: characterFlags(character, activities) },
      ],
      parentUuid: `JournalEntry.${entryId}`,
    });
    return existing._id;
  }
  const created = await live.modifyDocument("JournalEntryPage", "create", {
    data: [
      {
        name: `${character} — Downtime`,
        type: "text",
        text: { content, format: 1 },
        flags: characterFlags(character, activities),
      },
    ],
    parentUuid: `JournalEntry.${entryId}`,
  });
  return String(created[0]._id);
}

/** Refresh the index page to match the current ledger. */
async function writeIndexPage(
  live: FoundryLive,
  entryId: string,
  ledger: DowntimeLedger,
): Promise<void> {
  const entry = findDowntimeEntry(live);
  const index = entry ? findIndexPage(entry) : undefined;
  if (!index) return; // The entry was created with one; a missing index is not fatal.
  await live.modifyDocument("JournalEntryPage", "update", {
    updates: [{ _id: index._id, text: { content: downtimeIndexHtml(ledger) } }],
    parentUuid: `JournalEntry.${entryId}`,
  });
}

/** Propose an activity live: character page + index refresh + one chat line. */
export async function startActivityLive(
  live: FoundryLive,
  input: StartActivityInput,
): Promise<{ activity: DowntimeActivity; pageId: string; entryId: string }> {
  const entryId = await ensureDowntimeEntry(live);
  const { ledger } = readDowntime(live);
  const { ledger: next, activity } = startActivity(ledger, input);
  const pageId = await writeCharacterPage(live, entryId, next, activity.character);
  await writeIndexPage(live, entryId, next);
  await live.sendChat(
    `🌙 Downtime proposed — **${activity.character}**: ${activity.title} (${activity.kind}). Needs GM confirmation.`,
  );
  return { activity, pageId, entryId };
}

/** Confirm a proposed activity live (the GM gate). */
export async function confirmActivityLive(
  live: FoundryLive,
  id: string,
): Promise<{ activity: DowntimeActivity }> {
  const entryId = await ensureDowntimeEntry(live);
  const { ledger } = readDowntime(live);
  const { ledger: next, activity } = confirmActivity(ledger, id);
  await writeCharacterPage(live, entryId, next, activity.character);
  await writeIndexPage(live, entryId, next);
  await live.sendChat(`✅ GM confirmed downtime — **${activity.character}**: ${activity.title}.`);
  return { activity };
}

/** Advance a crafting / training / research activity live. */
export async function advanceActivityLive(
  live: FoundryLive,
  id: string,
  days: number,
  source: string,
): Promise<{ activity: DowntimeActivity; becameReady: boolean }> {
  const entryId = await ensureDowntimeEntry(live);
  const { ledger } = readDowntime(live);
  const { ledger: next, activity, becameReady } = advanceActivity(ledger, id, days, source);
  await writeCharacterPage(live, entryId, next, activity.character);
  await writeIndexPage(live, entryId, next);
  if (becameReady) {
    await live.sendChat(
      `✅ Downtime ready — **${activity.character}**: ${activity.title} is done, ready next session.`,
    );
  }
  return { activity, becameReady };
}

/** Complete an activity live. */
export async function completeActivityLive(
  live: FoundryLive,
  id: string,
  outcome: string,
  source: string,
): Promise<{ activity: DowntimeActivity; alreadyCompleted: boolean }> {
  const entryId = await ensureDowntimeEntry(live);
  const { ledger } = readDowntime(live);
  const { ledger: next, activity, alreadyCompleted } = completeActivity(ledger, id, outcome, source);
  if (alreadyCompleted) return { activity, alreadyCompleted: true };
  await writeCharacterPage(live, entryId, next, activity.character);
  await writeIndexPage(live, entryId, next);
  await live.sendChat(`🌙 Downtime done — **${activity.character}**: ${activity.title} — ${outcome}`);
  return { activity, alreadyCompleted: false };
}

/** Cancel an activity live. A no-op (already cancelled) posts no chat line. */
export async function cancelActivityLive(
  live: FoundryLive,
  id: string,
  source: string,
): Promise<{ activity: DowntimeActivity; alreadyCancelled: boolean }> {
  const entryId = await ensureDowntimeEntry(live);
  const { ledger } = readDowntime(live);
  const { ledger: next, activity, alreadyCancelled } = cancelActivity(ledger, id, source);
  if (alreadyCancelled) return { activity, alreadyCancelled: true };
  await writeCharacterPage(live, entryId, next, activity.character);
  await writeIndexPage(live, entryId, next);
  return { activity, alreadyCancelled: false };
}

/** Propose a healing activity live (rest-rule proposal; the GM still confirms it). */
export async function proposeHealingLive(
  live: FoundryLive,
  input: {
    character: string;
    rest: string;
    title?: string;
    detail?: string;
    costGp?: number;
    source: string;
  },
): Promise<{ activity: DowntimeActivity; pageId: string; entryId: string }> {
  const entryId = await ensureDowntimeEntry(live);
  const { ledger } = readDowntime(live);
  const { ledger: next, activity } = proposeHealing(ledger, input);
  const pageId = await writeCharacterPage(live, entryId, next, activity.character);
  await writeIndexPage(live, entryId, next);
  await live.sendChat(
    `🌙 Healing proposed — **${activity.character}**: ${activity.title}. ${activity.proposedOutcome ?? ""} Needs GM confirmation.`,
  );
  return { activity, pageId, entryId };
}

/** Read the ledger and print the summary — no writes, no chat. */
export function listDowntimeLive(live: FoundryLive): { entryId: string | null; ledger: DowntimeLedger } {
  return readDowntime(live);
}
