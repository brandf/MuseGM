/**
 * Clocks (BRA-228) — visible countdown/progress clocks on the table.
 *
 * The doc, Act Three (Great Train Robbery): two clocks on the table,
 * ticking in the open — a deadline and a pursuit — turn a getaway
 * into the tensest minutes of the session. "One sentence to start,
 * zero upkeep, all tension."
 *
 * A clock is N segments that fill as combat rounds pass. The table
 * reads it as time left: a 6-segment clock with 4 filled has 2
 * rounds to go. When the last segment fills, the clock FIRES — its
 * consequence goes off exactly once, and the clock waits to be
 * resolved (the caller acknowledging the consequence was delivered)
 * or reset.
 *
 * HONESTY RULE (same as the quest log and chronicle): every state
 * change carries a `source` — a chat message id, a GM statement, a
 * combat round. A change without a source is rejected, so the store
 * never silently gains ticks nobody called for. History is
 * append-only: ticks, fills, resolves, resets and drops are all
 * recorded with their source, so the table can always ask what moved
 * a clock and when.
 *
 * The clock is combat rounds, not wall-clock seconds (same rule as
 * the cutscene round clock, FR-18): a clock only advances when a new
 * combat round starts. Re-polling the same round is a no-op, so a
 * watcher polling every 2s can never double-tick.
 *
 * Two layers, kept separate on purpose (same pattern as
 * src/session/chronicle.ts and src/session/questlog.ts):
 * - Pure functions (createClock / tickClock / fillClock /
 *   resolveClock / resetClock / dropClock / advanceClocksToRound /
 *   parseClockStart / renderClock / serializeClockStore /
 *   parseClockStore / ...): no Foundry, no I/O, unit tested in
 *   tests/clocks.test.ts.
 * - Live functions (*Live): thin wrappers over FoundryLive —
 *   announceClockLive posts a clock line to chat; readCombatRound
 *   reads the combat state the round clock already uses. The store
 *   itself lives in a state file (same convention as the build/mode
 *   state files) while the watcher runs; persisting it as a
 *   JournalEntry the table can open is a follow-up, not part of
 *   this item.
 *
 * What this module deliberately does NOT do:
 * - It does not route chat messages — the monitor owns that. The
 *   one-sentence start is `parseClockStart` here; wiring it into
 *   the monitor (start a clock from a GM chat message, whisper the
 *   preview, fire on the GM's nod) is a follow-up.
 * - It does not execute the consequence. A fired clock hands its
 *   consequence text back to the caller; the caller decides what
 *   "the guards arrive" means — a chat line, a staged cutscene, an
 *   encounter. A consequence is data, not code, so a clock can
 *   never silently run something the GM did not ask for.
 * - It does not pause. A clock only ticks on combat rounds, so
 *   ending combat pauses it for free; a clock that should tick
 *   outside combat is a follow-up.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { FoundryLive } from "../live.js";

/** Validation / lookup failure. */
export class ClockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClockError";
  }
}

/** A clock's lifecycle. Running clocks tick; a fired clock has hit
 *  zero and is waiting for its consequence to be acknowledged
 *  (resolve) or for the GM to wind it back up (reset). */
export type ClockStatus = "running" | "fired" | "resolved" | "dropped";

export const CLOCK_STATUSES: readonly ClockStatus[] = [
  "running",
  "fired",
  "resolved",
  "dropped",
];

/** The longest bar that still reads at a glance in chat. */
export const MAX_CLOCK_SEGMENTS = 12;

/** One recorded change to a clock. Append-only. */
export interface ClockTick {
  kind: "create" | "tick" | "fill" | "resolve" | "reset" | "drop";
  /** Segments added (tick) or set to (fill); 0 for resolve/reset/drop. */
  by: number;
  /** Segments filled after this change. */
  filledAfter: number;
  /** Combat round this happened on, when the caller knows it. */
  round?: number;
  /** Where this came from — required. A chat message id, a GM statement, a combat round. */
  source: string;
}

/** One clock on the table. */
export interface Clock {
  /** Stable id, e.g. "pursuit" or "pursuit-2" — two clocks with the
   *  same name never collide. */
  id: string;
  /** What the table calls it, e.g. "the pursuit". */
  name: string;
  /** Segments in total. */
  total: number;
  /** Segments filled so far. `total - filled` is the rounds left. */
  filled: number;
  status: ClockStatus;
  /** What fires at zero — the table hears this when the clock hits
   *  zero. Optional: a clock without one is just a visible timer. */
  consequence?: string;
  /** Who/what started this clock — required. */
  source: string;
  /** Combat round the clock was created on, when known. */
  createdRound?: number;
  /** Last combat round this clock ticked on — re-polling the same
   *  round is a no-op, so the watcher can never double-tick. */
  lastTickRound?: number;
  /** Combat round the clock fired on, when it has fired. */
  firedRound?: number;
  /** Every change, in order, with its source. */
  history: ClockTick[];
}

/** The whole store: every clock the session has started. */
export interface ClockStore {
  version: 1;
  clocks: Clock[];
  /** Last combat the watcher advanced to. A new combat id resets
   *  the round tracking (combat rounds restart at 1). */
  roundCursor?: { combatId: string; round: number };
}

/** The empty store. */
export function emptyClockStore(): ClockStore {
  return { version: 1, clocks: [] };
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "clock"
  );
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function requireSource(source: string | undefined): string {
  if (source === undefined || source.trim() === "") {
    throw new ClockError(
      "A clock change needs a source — who or what moved it (a chat message id, a GM statement, a combat round).",
    );
  }
  return source.trim();
}

function requireTotal(total: unknown): number {
  if (typeof total !== "number" || !Number.isInteger(total)) {
    throw new ClockError(
      `A clock needs a whole number of segments — got ${JSON.stringify(total)}.`,
    );
  }
  if (total < 1 || total > MAX_CLOCK_SEGMENTS) {
    throw new ClockError(
      `A clock has 1–${MAX_CLOCK_SEGMENTS} segments — got ${total}. More than ${MAX_CLOCK_SEGMENTS} does not read at a glance in chat.`,
    );
  }
  return total;
}

function requireRound(round: unknown, field: string): number {
  if (typeof round !== "number" || !Number.isInteger(round) || round < 1) {
    throw new ClockError(
      `${field} must be a combat round (a whole number, 1 or more) — got ${JSON.stringify(round)}.`,
    );
  }
  return round;
}

/** The id for a new clock: the name slug, with -2, -3, ... when the
 *  name is already taken — two clocks with the same name never
 *  collide. */
function nextClockId(store: ClockStore, name: string): string {
  const base = slugify(name);
  const taken = new Set(store.clocks.map((c) => c.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function withClock(store: ClockStore, clock: Clock): ClockStore {
  return {
    ...store,
    clocks: store.clocks.map((c) => (c.id === clock.id ? clock : c)),
  };
}

function appendHistory(clock: Clock, tick: ClockTick): Clock {
  return { ...clock, history: [...clock.history, tick] };
}

/** Create a clock. The source is required — the store never gains a
 *  clock nobody started. */
export function createClock(
  store: ClockStore,
  input: {
    name: string;
    total: number;
    consequence?: string;
    source: string;
    round?: number;
  },
): { store: ClockStore; clock: Clock } {
  const name = input.name.trim();
  if (name === "") throw new ClockError("A clock needs a name — what is the table watching?");
  const total = requireTotal(input.total);
  const source = requireSource(input.source);
  const consequence =
    input.consequence !== undefined && input.consequence.trim() !== ""
      ? input.consequence.trim()
      : undefined;
  const round =
    input.round === undefined ? undefined : requireRound(input.round, "round");
  const clock: Clock = {
    id: nextClockId(store, name),
    name,
    total,
    filled: 0,
    status: "running",
    ...(consequence !== undefined ? { consequence } : {}),
    source,
    ...(round !== undefined ? { createdRound: round } : {}),
    history: [{ kind: "create", by: 0, filledAfter: 0, ...(round !== undefined ? { round } : {}), source }],
  };
  return { store: { ...store, clocks: [...store.clocks, clock] }, clock };
}

/** Find a clock by id. */
export function getClock(store: ClockStore, id: string): Clock | undefined {
  return store.clocks.find((c) => c.id === id);
}

/** Every clock with this name (normalized). Names are not unique —
 *  ids are. */
export function findClocksByName(store: ClockStore, name: string): Clock[] {
  const key = normalizeName(name);
  return store.clocks.filter((c) => normalizeName(c.name) === key);
}

/** List clocks, optionally filtered by status. Running first, then
 *  fired, then resolved, then dropped. */
export function listClocks(store: ClockStore, status?: ClockStatus): Clock[] {
  const order: Record<ClockStatus, number> = {
    running: 0,
    fired: 1,
    resolved: 2,
    dropped: 3,
  };
  return store.clocks
    .filter((c) => status === undefined || c.status === status)
    .slice()
    .sort((a, b) => order[a.status] - order[b.status]);
}

/**
 * Resolve a target — an id, or a name — to one clock. A name must
 * match exactly one clock; zero matches list the clocks that exist,
 * several list the matches. Never guesses.
 */
export function resolveClockTarget(store: ClockStore, target: string): Clock {
  const byId = getClock(store, target);
  if (byId) return byId;
  const matches = findClocksByName(store, target);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    const known =
      store.clocks.length === 0
        ? "there are no clocks yet"
        : `clocks here: ${store.clocks.map((c) => `"${c.name}" (${c.id})`).join(", ")}`;
    throw new ClockError(`No clock named "${target}" — ${known}.`);
  }
  throw new ClockError(
    `"${target}" matches more than one clock: ${matches.map((c) => c.id).join(", ")} — name one by id.`,
  );
}

export interface TickResult {
  store: ClockStore;
  clock: Clock;
  /** True when this tick filled the clock and fired its consequence. */
  fired: boolean;
  /** The consequence, when fired. */
  consequence?: string;
  /** True when nothing changed — a re-poll of an already-ticked round. */
  noop: boolean;
}

function fire(clock: Clock, round: number | undefined): Clock {
  return {
    ...clock,
    status: "fired",
    ...(round !== undefined ? { firedRound: round, lastTickRound: round } : {}),
  };
}

/**
 * Tick a clock forward by `by` segments (default 1). Filling the
 * last segment fires the clock: status becomes "fired" and the
 * consequence comes back with the result for the caller to deliver.
 * A fired clock fires exactly once — ticking it again is an error,
 * not a second firing. A tick with a `round` equal to the clock's
 * last ticked round is a no-op (the watcher re-polling); a round
 * before it is an error.
 */
export function tickClock(
  store: ClockStore,
  target: string,
  opts: { by?: number; source: string; round?: number } = { source: "" },
): TickResult {
  const source = requireSource(opts.source);
  const by = opts.by ?? 1;
  if (!Number.isInteger(by) || by < 1) {
    throw new ClockError(`A tick advances a clock by 1 or more segments — got ${JSON.stringify(by)}.`);
  }
  const round =
    opts.round === undefined ? undefined : requireRound(opts.round, "round");
  const clock = resolveClockTarget(store, target);
  if (clock.status !== "running") {
    throw new ClockError(
      `Clock "${clock.name}" is ${clock.status} — only a running clock ticks.`,
    );
  }
  if (round !== undefined && clock.lastTickRound !== undefined) {
    if (round === clock.lastTickRound) {
      return { store, clock, fired: false, noop: true };
    }
    if (round < clock.lastTickRound) {
      throw new ClockError(
        `Clock "${clock.name}" already ticked on round ${clock.lastTickRound} — round ${round} is before that. A new combat resets the round tracking (see advanceClocksToRound).`,
      );
    }
  }
  const filled = Math.min(clock.total, clock.filled + by);
  let next: Clock = appendHistory(
    { ...clock, filled, ...(round !== undefined ? { lastTickRound: round } : {}) },
    { kind: "tick", by: filled - clock.filled, filledAfter: filled, ...(round !== undefined ? { round } : {}), source },
  );
  let fired = false;
  if (filled >= clock.total) {
    next = fire(next, round);
    fired = true;
  }
  return {
    store: withClock(store, next),
    clock: next,
    fired,
    ...(fired && next.consequence !== undefined ? { consequence: next.consequence } : {}),
    noop: false,
  };
}

/**
 * Fill a clock to an absolute segment count. Only forward, and only
 * up to the total — moving a clock backward is a reset, not a fill.
 * Filling to the total fires the clock, same as ticking there.
 */
export function fillClock(
  store: ClockStore,
  target: string,
  opts: { to: number; source: string; round?: number },
): TickResult {
  const source = requireSource(opts.source);
  const to = opts.to;
  if (!Number.isInteger(to) || to < 0 || to > MAX_CLOCK_SEGMENTS) {
    throw new ClockError(
      `A fill sets a clock to a whole number of segments, 0–${MAX_CLOCK_SEGMENTS} — got ${JSON.stringify(to)}.`,
    );
  }
  const round =
    opts.round === undefined ? undefined : requireRound(opts.round, "round");
  const clock = resolveClockTarget(store, target);
  if (clock.status !== "running") {
    throw new ClockError(
      `Clock "${clock.name}" is ${clock.status} — only a running clock fills.`,
    );
  }
  if (to > clock.total) {
    throw new ClockError(
      `Clock "${clock.name}" has ${clock.total} segments — cannot fill to ${to}.`,
    );
  }
  if (to <= clock.filled) {
    throw new ClockError(
      `Clock "${clock.name}" is already at ${clock.filled}/${clock.total} — a fill only moves forward (reset to wind it back).`,
    );
  }
  let next: Clock = appendHistory(
    { ...clock, filled: to, ...(round !== undefined ? { lastTickRound: round } : {}) },
    { kind: "fill", by: to - clock.filled, filledAfter: to, ...(round !== undefined ? { round } : {}), source },
  );
  let fired = false;
  if (to >= clock.total) {
    next = fire(next, round);
    fired = true;
  }
  return {
    store: withClock(store, next),
    clock: next,
    fired,
    ...(fired && next.consequence !== undefined ? { consequence: next.consequence } : {}),
    noop: false,
  };
}

/**
 * Resolve a fired clock: the caller acknowledges the consequence
 * was delivered, and the clock closes. Only a fired clock resolves —
 * a running clock still has segments left, and a resolved or
 * dropped clock is already closed.
 */
export function resolveClock(
  store: ClockStore,
  target: string,
  opts: { source: string; round?: number },
): { store: ClockStore; clock: Clock } {
  const source = requireSource(opts.source);
  const round =
    opts.round === undefined ? undefined : requireRound(opts.round, "round");
  const clock = resolveClockTarget(store, target);
  if (clock.status !== "fired") {
    const left =
      clock.status === "running"
        ? ` — it still has ${clock.total - clock.filled} segment${clock.total - clock.filled === 1 ? "" : "s"} left`
        : "";
    throw new ClockError(
      `Clock "${clock.name}" is ${clock.status}${left} — only a fired clock can be resolved.`,
    );
  }
  const next = appendHistory(
    { ...clock, status: "resolved" },
    { kind: "resolve", by: 0, filledAfter: clock.filled, ...(round !== undefined ? { round } : {}), source },
  );
  return { store: withClock(store, next), clock: next };
}

/**
 * Reset a clock to a fresh running clock: 0 filled, round tracking
 * cleared. The history keeps the reset, so the table can see the
 * clock was wound back.
 */
export function resetClock(
  store: ClockStore,
  target: string,
  opts: { source: string },
): { store: ClockStore; clock: Clock } {
  const source = requireSource(opts.source);
  const clock = resolveClockTarget(store, target);
  const next = appendHistory(
    {
      ...clock,
      filled: 0,
      status: "running",
      lastTickRound: undefined,
      firedRound: undefined,
    },
    { kind: "reset", by: 0, filledAfter: 0, source },
  );
  return { store: withClock(store, next), clock: next };
}

/**
 * Drop a clock: running or fired clocks can be dropped; resolved or
 * dropped clocks are already closed.
 */
export function dropClock(
  store: ClockStore,
  target: string,
  opts: { source: string },
): { store: ClockStore; clock: Clock } {
  const source = requireSource(opts.source);
  const clock = resolveClockTarget(store, target);
  if (clock.status !== "running" && clock.status !== "fired") {
    throw new ClockError(
      `Clock "${clock.name}" is already ${clock.status} — it cannot be dropped.`,
    );
  }
  const next = appendHistory(
    { ...clock, status: "dropped" },
    { kind: "drop", by: 0, filledAfter: clock.filled, source },
  );
  return { store: withClock(store, next), clock: next };
}

export interface RoundAdvanceEvent {
  clock: Clock;
  fired: boolean;
  consequence?: string;
}

/**
 * Advance every running clock by one segment for a new combat
 * round — the watcher's entry point. A round the cursor already
 * saw is a no-op; a new combat id resets the round tracking first
 * (combat rounds restart at 1, so round 1 of a new combat is a new
 * round even though round 1 was already seen). Returns the events
 * in clock order: one per clock that ticked, with the consequence
 * for each clock that fired.
 */
export function advanceClocksToRound(
  store: ClockStore,
  opts: { combatId: string; round: number; source: string },
): { store: ClockStore; events: RoundAdvanceEvent[] } {
  const source = requireSource(opts.source);
  const round = requireRound(opts.round, "round");
  const combatId = opts.combatId.trim();
  if (combatId === "") throw new ClockError("advanceClocksToRound needs a combat id.");
  let next: ClockStore = store;
  if (store.roundCursor === undefined || store.roundCursor.combatId !== combatId) {
    // A new combat: clear every clock's last-ticked round so round 1
    // ticks again, and point the cursor at this combat.
    next = {
      ...store,
      roundCursor: { combatId, round: round - 1 },
      clocks: store.clocks.map((c) =>
        c.status === "running" ? { ...c, lastTickRound: undefined } : c,
      ),
    };
  }
  if (next.roundCursor !== undefined && round <= next.roundCursor.round) {
    return { store: next, events: [] };
  }
  const events: RoundAdvanceEvent[] = [];
  // One segment per new round, even if several rounds passed while
  // the watcher was away — a clock that missed rounds does not jump
  // ahead by all of them at once; the GM fills the gap by hand.
  // (The cursor still advances to the current round.)
  for (const clock of next.clocks) {
    if (clock.status !== "running") continue;
    const ticked = tickClock(next, clock.id, { source, round });
    next = ticked.store;
    events.push({
      clock: ticked.clock,
      fired: ticked.fired,
      ...(ticked.consequence !== undefined ? { consequence: ticked.consequence } : {}),
    });
  }
  next = { ...next, roundCursor: { combatId, round } };
  return { store: next, events };
}

/** The bar the table reads: filled segments solid, the rest empty. */
export function clockBar(clock: Clock): string {
  return "█".repeat(clock.filled) + "░".repeat(Math.max(0, clock.total - clock.filled));
}

/** One chat line for a clock — the table reads the bar, the count,
 *  and the rounds left at a glance. */
export function renderClock(clock: Clock): string {
  const left = clock.total - clock.filled;
  switch (clock.status) {
    case "running":
      return (
        `🕐 ${clock.name} [${clockBar(clock)}] ${clock.filled}/${clock.total} — ` +
        `${left} round${left === 1 ? "" : "s"} left` +
        (clock.consequence !== undefined ? ` — at zero: ${clock.consequence}` : "")
      );
    case "fired":
      return (
        `⏰ ${clock.name} hit zero [${clockBar(clock)}] ${clock.filled}/${clock.total}` +
        (clock.consequence !== undefined ? ` — ${clock.consequence}` : "")
      );
    case "resolved":
      return (
        `✅ ${clock.name} resolved [${clockBar(clock)}] ${clock.filled}/${clock.total}` +
        (clock.consequence !== undefined ? ` — ${clock.consequence}` : "")
      );
    case "dropped":
      return `🚫 ${clock.name} dropped [${clockBar(clock)}] ${clock.filled}/${clock.total}`;
  }
}

/** The whole store, one line per clock — running first. */
export function renderClockStore(store: ClockStore): string {
  const clocks = listClocks(store);
  if (clocks.length === 0) return "No clocks.";
  return clocks.map(renderClock).join("\n");
}

// ---------------------------------------------------------------- serialize

/** Shape check for a parsed store — bad shapes are rejected, never guessed at. */
export function isClockStore(v: unknown): v is ClockStore {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  if (s.version !== 1) return false;
  if (!Array.isArray(s.clocks)) return false;
  for (const c of s.clocks as Record<string, unknown>[]) {
    if (!c || typeof c !== "object") return false;
    if (typeof c.id !== "string" || c.id === "") return false;
    if (typeof c.name !== "string" || c.name === "") return false;
    if (typeof c.total !== "number" || !Number.isInteger(c.total) || c.total < 1) return false;
    if (typeof c.filled !== "number" || !Number.isInteger(c.filled) || c.filled < 0 || c.filled > c.total) return false;
    if (typeof c.status !== "string" || !(CLOCK_STATUSES as readonly string[]).includes(c.status)) return false;
    if (c.consequence !== undefined && typeof c.consequence !== "string") return false;
    if (typeof c.source !== "string" || c.source === "") return false;
    if (!Array.isArray(c.history)) return false;
    for (const h of c.history as Record<string, unknown>[]) {
      if (!h || typeof h !== "object") return false;
      if (typeof h.kind !== "string" || !["create", "tick", "fill", "resolve", "reset", "drop"].includes(h.kind)) return false;
      if (typeof h.by !== "number" || !Number.isInteger(h.by) || h.by < 0) return false;
      if (typeof h.filledAfter !== "number" || !Number.isInteger(h.filledAfter) || h.filledAfter < 0) return false;
      if (typeof h.source !== "string" || h.source === "") return false;
    }
  }
  if (s.roundCursor !== undefined) {
    const rc = s.roundCursor as Record<string, unknown>;
    if (!rc || typeof rc !== "object") return false;
    if (typeof rc.combatId !== "string" || rc.combatId === "") return false;
    // Round 0 means the combat was just seen and no round has been
    // advanced to yet (see advanceClocksToRound) — it is a valid
    // cursor, even though a caller-supplied round is never 0.
    if (typeof rc.round !== "number" || !Number.isInteger(rc.round) || rc.round < 0) return false;
  }
  return true;
}

export function serializeClockStore(store: ClockStore): string {
  return JSON.stringify(store);
}

/** Parse a store back. Returns null when the JSON is unreadable or
 *  the wrong shape — the caller starts a fresh store either way. */
export function parseClockStore(json: string): ClockStore | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return isClockStore(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- state file

/**
 * Where the clocks live while a watch runs, so a CLI restart keeps
 * the clocks and their history. Same pattern as the build/mode state
 * files: an env override, else a dotfile at the repo root. The file
 * is a CACHE of the store, not the source of truth — the chat lines
 * are what the table saw — so a lost file only loses the clocks
 * themselves (re-start them, don't hand-edit the file).
 */
export function defaultClockStatePath(): string {
  return (
    process.env.FOUNDRY_CLOCK_STATE ??
    path.join(import.meta.dir, "..", "..", ".clock-state.json")
  );
}

/** Write the store to the state file. Best effort, like the
 *  build/mode state: a failed write never breaks a tick. */
export function saveClockState(
  store: ClockStore,
  filePath: string = defaultClockStatePath(),
): void {
  try {
    fs.writeFileSync(filePath, serializeClockStore(store), "utf-8");
  } catch {
    // State is a convenience; a failed write must not break the clock.
  }
}

/** Read the store back. Returns null when there is no state yet, or
 *  the file is unreadable or the wrong shape — the caller starts a
 *  fresh store either way. */
export function loadClockState(
  filePath: string = defaultClockStatePath(),
): ClockStore | null {
  try {
    return parseClockStore(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- one-sentence start

export type ClockStartParse =
  | { kind: "create"; name: string; total: number; consequence?: string }
  | { kind: "clarify"; question: string }
  | null;

/**
 * Parse "start a clock" in one chat message into a clock spec.
 * Returns null when the line is not a clock request at all (so the
 * monitor falls through to the other branches). Ambiguity is a
 * question, never a guess.
 *
 * Recognized:
 *   "start a 6-segment clock: the pursuit"
 *   "start a clock: the ritual completes, 4 segments"
 *   "start a deadline clock for the train escape, 8 segments"
 *   "start a 4-segment clock: the guards arrive — at zero: the alarm sounds"
 *   (the "at zero:" / "when it fills:" tail is the consequence)
 * A line with no segment count asks how many segments; a line with
 * no name asks what the clock is called.
 */
export function parseClockStart(text: string): ClockStartParse {
  const s = text.trim();
  if (!/\bclock\b/i.test(s)) return null;
  if (!/\b(start|begin|new|make|set up|set a)\b/i.test(s)) return null;

  const countMatch =
    /(\d+)\s*[- ]segments?\b/i.exec(s) ??
    /\bsegments?\s*[:=]?\s*(\d+)\b/i.exec(s);
  const total = countMatch ? Number(countMatch[1]) : undefined;

  // The consequence tail, when present: "at zero: ..." or
  // "when it fills: ..." / "when it hits zero: ...".
  const consequenceMatch =
    /(?:at zero|when (?:it|this) (?:fills|hits zero|runs out|fires))\s*[:—-]?\s*(.+)$/i.exec(s);
  const consequence = consequenceMatch
    ? consequenceMatch[1].replace(/[.!]+$/, "").trim()
    : undefined;
  const body = consequenceMatch
    ? s.slice(0, consequenceMatch.index).trim()
    : s;

  // The name: after a colon, or after "for"/"called"/"named", or the
  // words after the segment count.
  let name: string | undefined;
  const colonIdx = body.indexOf(":");
  if (colonIdx >= 0) {
    name = body.slice(colonIdx + 1).trim();
  } else {
    const forMatch = /\b(?:for|called|named)\b\s+(.+)$/i.exec(body);
    if (forMatch) {
      name = forMatch[1].trim();
    } else if (countMatch) {
      const after = body.slice(countMatch.index + countMatch[0].length).trim();
      name = after !== "" ? after : undefined;
    }
  }
  if (name !== undefined) {
    // Strip a trailing segment-count phrase ("the pursuit, 6 segments"),
    // a trailing dash left by a cut-off consequence tail, and stray quotes.
    // A bare "clock" is not a name — it is the word the request itself
    // ends on ("start a 6-segment clock").
    name = name
      .replace(/,?\s*\d+\s*[- ]segments?\s*$/i, "")
      .replace(/\s*[—–-]+\s*$/, "")
      .replace(/^["“”']+|["“”']+$/g, "")
      .trim();
    if (name === "" || normalizeName(name) === "clock") name = undefined;
  }

  if (total === undefined) {
    return {
      kind: "clarify",
      question:
        name !== undefined
          ? `How many segments should the "${name}" clock have?`
          : "How many segments should the clock have?",
    };
  }
  if (total < 1 || total > MAX_CLOCK_SEGMENTS) {
    return {
      kind: "clarify",
      question: `A clock has 1–${MAX_CLOCK_SEGMENTS} segments — how many for this one?`,
    };
  }
  if (name === undefined) {
    return {
      kind: "clarify",
      question: `What is the ${total}-segment clock called?`,
    };
  }
  return {
    kind: "create",
    name,
    total,
    ...(consequence !== undefined && consequence !== ""
      ? { consequence }
      : {}),
  };
}

// ---------------------------------------------------------------- live layer

/** Read the current combat round from the live client — the same
 *  combat state the cutscene round clock polls. Null when there is
 *  no active combat (or no round yet). */
export function readCombatRound(
  live: FoundryLive,
): { combatId: string; round: number } | null {
  const combat = live.getCombatState() as unknown as
    | { _id?: string; round?: number; active?: boolean }
    | null;
  if (!combat || typeof combat.round !== "number" || combat.round < 1) return null;
  if (typeof combat._id !== "string" || combat._id === "") return null;
  return { combatId: combat._id, round: combat.round };
}

/** Post a clock line to chat — the table sees the clock tick. */
export async function announceClockLive(
  live: FoundryLive,
  line: string,
  dedupeKey?: string,
): Promise<string> {
  return live.sendChat(line, dedupeKey !== undefined ? { dedupeKey } : {});
}
