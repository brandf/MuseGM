/**
 * Speed-budget instrumentation (BRA-230, FR-10) — the pure half.
 *
 * FR-10 governs every feature: the time from the creator's message to
 * the change visible on the table should be measured in seconds. Until
 * now nothing measured it. This module is the ruler:
 *
 * - `LatencyLog` records named timings (one per action) against a
 *   budget table, with an injectable clock so plain `bun test` covers
 *   it — the module never calls `Date.now()` itself; the live layer
 *   passes the clock in (default `realClock`).
 * - `SPEED_BUDGETS` is the budget table. Every budget cites its
 *   source; a kind with no sourced budget gets `ms: null` — it is
 *   measured and reported, never flagged over-budget. Do not invent a
 *   budget to make the report look complete; set it from live data
 *   and cite the run that justifies it.
 * - `summarize` / `formatLatencyReport` turn a session's records into
 *   the p50/p95 report the issue asks for.
 *
 * What a record means, honestly:
 * - `detect`: message timestamp → the monitor loop sees the message.
 *   Includes the waitForChat debounce (default 3s), so a 3s detect is
 *   the loop working as designed, not a slowdown.
 * - An action record (room-build, roll, question, whisper-first-effect)
 *   spans message receipt → the visible effect landing (tiles synced
 *   + confirmation posted, answer posted, first cutscene step
 *   completed). A failed action records nothing — no effect landed.
 *   The detect record still captures that the monitor woke.
 * - `cutscene-step` is one executing step's duration, measured by the
 *   player. Wait steps (`pause` / `wait` / `waitChat` / `waitRound`)
 *   record under `cutscene-wait` instead: their duration IS the wait,
 *   not execution latency, and flagging a 5-round wait as "slow" would
 *   be nonsense.
 * - The summary is a snapshot at shutdown. Background plays (a
 *   whispered sequence keeps running after the ack) record into the
 *   log lines as they land; if one lands after shutdown it is in the
 *   log, not in the summary.
 */
export type Clock = () => number;

/** Wall-clock milliseconds. The live default; tests inject a fake. */
export const realClock: Clock = () => Date.now();

/** One measurable latency, from the creator's message to a visible effect. */
export type LatencyKind =
  | "detect"
  | "ambush"
  | "room-build"
  | "whisper-first-effect"
  | "encounter"
  | "reskin"
  | "cutscene-step"
  | "cutscene-wait"
  | "roll"
  | "question";

/** A budget, with the source that justifies it — never an invented number. */
export interface SpeedBudget {
  /** Milliseconds, or null when no sourced budget exists yet. */
  ms: number | null;
  source: string;
}

export const SPEED_BUDGETS: Record<LatencyKind, SpeedBudget> = {
  detect: {
    ms: 3000,
    source: "FR-10 + monitor contract: detect in 2–3 seconds (waitForChat debounce default 3s)",
  },
  ambush: {
    ms: 30000,
    source: "BRA-230 acceptance: ambush <30s",
  },
  "room-build": {
    ms: 120000,
    source: "BRA-230 acceptance: room build <2min",
  },
  "whisper-first-effect": {
    ms: 120000,
    source: "BRA-230 acceptance + FR-18: whisper → first visible effect 1–2 min",
  },
  encounter: {
    ms: 60000,
    source: "FR-11 acceptance: encounter on the table in under a minute",
  },
  reskin: {
    ms: 10000,
    source: "FR-2 acceptance: a built room re-skinned in under 10 seconds of execution",
  },
  "cutscene-step": {
    ms: 5000,
    source:
      "FR-10: code execution is seconds — chosen ceiling for one executing step; tune from live data",
  },
  "cutscene-wait": {
    ms: null,
    source: "wait steps: the duration IS the wait, not execution latency — measured, never flagged",
  },
  roll: {
    ms: null,
    source: "no sourced end-to-end budget — measured, set from live data",
  },
  question: {
    ms: null,
    source: "no sourced end-to-end budget — measured, set from live data",
  },
};

/** Cutscene step kinds whose duration is a wait, not execution. */
export const CUTSCENE_WAIT_KINDS: ReadonlySet<string> = new Set([
  "pause",
  "wait",
  "waitChat",
  "waitRound",
]);

/** Which latency kind a cutscene step's duration records under. */
export function cutsceneStepKind(stepKind: string): "cutscene-step" | "cutscene-wait" {
  return CUTSCENE_WAIT_KINDS.has(stepKind) ? "cutscene-wait" : "cutscene-step";
}

export interface LatencyRecord {
  kind: LatencyKind;
  /** What was timed (message id, `msgId:stepIndex`, …). */
  label?: string;
  startedAtMs: number;
  finishedAtMs: number;
  durationMs: number;
  /** The budget in force, or null when the kind has none. */
  budgetMs: number | null;
  overBudget: boolean;
}

/** An open timer: finish it when the effect lands, drop it when it never does. */
export interface TimerHandle {
  kind: LatencyKind;
  label?: string;
  startedAtMs: number;
}

function toRecord(
  kind: LatencyKind,
  label: string | undefined,
  startedAtMs: number,
  finishedAtMs: number,
): LatencyRecord {
  const budgetMs = SPEED_BUDGETS[kind].ms;
  // A clock that runs backwards (or a mis-set message timestamp) never
  // yields a negative duration — the record is 0ms, not -400ms.
  const durationMs = Math.max(0, finishedAtMs - startedAtMs);
  return {
    kind,
    label,
    startedAtMs,
    finishedAtMs,
    durationMs,
    budgetMs,
    overBudget: budgetMs !== null && durationMs > budgetMs,
  };
}

/** Nearest-rank percentile over an ascending array (n >= 1). */
export function percentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) throw new Error("percentile needs at least one sample");
  const rank = Math.ceil((p / 100) * n);
  return sortedAsc[Math.min(n - 1, Math.max(0, rank - 1))];
}

export interface KindLatencyStats {
  kind: LatencyKind;
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  overBudget: number;
  budgetMs: number | null;
}

export interface SessionLatencyReport {
  total: number;
  byKind: KindLatencyStats[];
  /** Every over-budget record, in the order it landed. */
  overBudget: LatencyRecord[];
}

/** Append-only record of a session's latencies, on an injectable clock. */
export class LatencyLog {
  private readonly clock: Clock;
  private readonly recs: LatencyRecord[] = [];

  constructor(clock: Clock = realClock) {
    this.clock = clock;
  }

  /** Current time on this log's clock. */
  now(): number {
    return this.clock();
  }

  /** Start a timer; finish it when the visible effect lands. */
  start(kind: LatencyKind, label?: string): TimerHandle {
    return { kind, label, startedAtMs: this.clock() };
  }

  /** Finish a timer into a record. `atMs` defaults to now. */
  finish(handle: TimerHandle, atMs: number = this.clock()): LatencyRecord {
    const rec = toRecord(handle.kind, handle.label, handle.startedAtMs, atMs);
    this.recs.push(rec);
    return rec;
  }

  /** Record a finished window outright (message timestamp → seen). */
  record(
    kind: LatencyKind,
    startedAtMs: number,
    finishedAtMs: number,
    label?: string,
  ): LatencyRecord {
    const rec = toRecord(kind, label, startedAtMs, finishedAtMs);
    this.recs.push(rec);
    return rec;
  }

  /**
   * Record a duration measured elsewhere (a cutscene step's
   * `durationMs`, measured by the player): the window ends now.
   */
  recordDuration(kind: LatencyKind, durationMs: number, label?: string): LatencyRecord {
    const finishedAtMs = this.clock();
    const rec = toRecord(kind, label, finishedAtMs - Math.max(0, durationMs), finishedAtMs);
    this.recs.push(rec);
    return rec;
  }

  get records(): LatencyRecord[] {
    return [...this.recs];
  }

  byKind(kind: LatencyKind): LatencyRecord[] {
    return this.recs.filter((r) => r.kind === kind);
  }

  summary(): SessionLatencyReport {
    const byKind: KindLatencyStats[] = [];
    const seen = new Set<LatencyKind>();
    for (const rec of this.recs) {
      if (seen.has(rec.kind)) continue;
      seen.add(rec.kind);
      const durations = this.byKind(rec.kind)
        .map((r) => r.durationMs)
        .sort((a, b) => a - b);
      byKind.push({
        kind: rec.kind,
        count: durations.length,
        p50Ms: percentile(durations, 50),
        p95Ms: percentile(durations, 95),
        maxMs: durations[durations.length - 1],
        overBudget: this.byKind(rec.kind).filter((r) => r.overBudget).length,
        budgetMs: SPEED_BUDGETS[rec.kind].ms,
      });
    }
    return {
      total: this.recs.length,
      byKind,
      overBudget: this.recs.filter((r) => r.overBudget),
    };
  }
}

/** The one-line latency record: `latency kind=room-build label=m7 ms=4213 budget=120000 over=false`. */
export function latencyLine(rec: LatencyRecord): string {
  const parts = [
    `latency kind=${rec.kind}`,
    rec.label !== undefined ? `label=${rec.label}` : null,
    `ms=${rec.durationMs}`,
    `budget=${rec.budgetMs ?? "none"}`,
    `over=${rec.overBudget}`,
  ].filter((p): p is string => p !== null);
  return parts.join(" ");
}

/** Human-readable session report: p50/p95 per kind against its budget. */
export function formatLatencyReport(report: SessionLatencyReport): string {
  const lines = [`Latency report (${report.total} action${report.total === 1 ? "" : "s"}):`];
  for (const k of report.byKind) {
    lines.push(
      `  ${k.kind}: n=${k.count} p50=${k.p50Ms}ms p95=${k.p95Ms}ms max=${k.maxMs}ms budget=${k.budgetMs ?? "none"} over=${k.overBudget}`,
    );
  }
  if (report.overBudget.length > 0) {
    lines.push("  Over budget:");
    for (const rec of report.overBudget) {
      lines.push(`    ${latencyLine(rec)}`);
    }
  }
  return lines.join("\n");
}
