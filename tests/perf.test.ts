/**
 * Tests for speed-budget instrumentation (BRA-230, FR-10):
 * src/session/perf.ts (pure, injectable clock) and the monitor loop's
 * wiring (src/session/monitor.ts) with a fake live. No Foundry
 * connection needed — run with `bun test`.
 */
import { describe, expect, it } from "bun:test";
import {
  LatencyLog,
  SPEED_BUDGETS,
  cutsceneStepKind,
  formatLatencyReport,
  latencyLine,
  percentile,
  type LatencyRecord,
} from "../src/session/perf.js";
import { runMonitor } from "../src/session/monitor.js";
import type { ChatMessage } from "../src/types.js";
import type { FoundryLive } from "../src/live.js";

// ---------------------------------------------------------------- fake clock

function fakeClock(startMs = 1_000_000) {
  let now = startMs;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

// ---------------------------------------------------------------- perf module

describe("LatencyLog timers", () => {
  it("start/finish measures the elapsed time on the injected clock", () => {
    const clock = fakeClock();
    const log = new LatencyLog(clock.now);
    const t = log.start("room-build", "m1");
    clock.advance(4213);
    const rec = log.finish(t);
    expect(rec.kind).toBe("room-build");
    expect(rec.label).toBe("m1");
    expect(rec.durationMs).toBe(4213);
    expect(rec.startedAtMs).toBe(1_000_000);
    expect(rec.finishedAtMs).toBe(1_004_213);
    expect(rec.budgetMs).toBe(120000);
    expect(rec.overBudget).toBe(false);
  });

  it("a backwards clock never yields a negative duration", () => {
    const clock = fakeClock();
    const log = new LatencyLog(clock.now);
    const t = log.start("detect", "m2");
    clock.advance(-500);
    expect(log.finish(t).durationMs).toBe(0);
  });

  it("record() takes an explicit window (message timestamp → seen)", () => {
    const clock = fakeClock();
    const log = new LatencyLog(clock.now);
    const rec = log.record("detect", 998_800, 1_000_000, "m3");
    expect(rec.durationMs).toBe(1200);
    expect(rec.overBudget).toBe(false);
  });

  it("recordDuration() ends the window now (durations measured elsewhere)", () => {
    const clock = fakeClock();
    const log = new LatencyLog(clock.now);
    const rec = log.recordDuration("cutscene-step", 250, "w1:0");
    expect(rec.durationMs).toBe(250);
    expect(rec.finishedAtMs).toBe(1_000_000);
    expect(rec.startedAtMs).toBe(999_750);
  });

  it("records() returns a copy — mutating it does not touch the log", () => {
    const log = new LatencyLog(fakeClock().now);
    log.record("roll", 0, 100);
    const copy = log.records;
    copy.pop();
    expect(log.records).toHaveLength(1);
  });
});

describe("SPEED_BUDGETS", () => {
  it("every budget cites its source", () => {
    for (const [kind, b] of Object.entries(SPEED_BUDGETS)) {
      expect(b.source.length, kind).toBeGreaterThan(0);
    }
  });

  it("the sourced budgets are the numbers the spec and issue state", () => {
    expect(SPEED_BUDGETS.detect.ms).toBe(3000); // detect in 2–3 seconds
    expect(SPEED_BUDGETS.ambush.ms).toBe(30000); // ambush <30s
    expect(SPEED_BUDGETS["room-build"].ms).toBe(120000); // room build <2min
    expect(SPEED_BUDGETS["whisper-first-effect"].ms).toBe(120000); // 1–2 min
    expect(SPEED_BUDGETS.encounter.ms).toBe(60000); // FR-11 under a minute
    expect(SPEED_BUDGETS.reskin.ms).toBe(10000); // FR-2 under 10 seconds
    expect(SPEED_BUDGETS["cutscene-step"].ms).toBe(5000);
  });

  it("kinds with no sourced budget are measured, never flagged", () => {
    expect(SPEED_BUDGETS.roll.ms).toBeNull();
    expect(SPEED_BUDGETS.question.ms).toBeNull();
    expect(SPEED_BUDGETS["cutscene-wait"].ms).toBeNull();
    const log = new LatencyLog(fakeClock().now);
    const rec = log.record("roll", 0, 999_999);
    expect(rec.overBudget).toBe(false);
  });

  it("over-budget flags only when a budget exists and is exceeded", () => {
    const log = new LatencyLog(fakeClock().now);
    expect(log.record("detect", 0, 3000).overBudget).toBe(false); // exactly at budget
    expect(log.record("detect", 0, 3001).overBudget).toBe(true);
    expect(log.record("ambush", 0, 30000).overBudget).toBe(false);
    expect(log.record("ambush", 0, 30001).overBudget).toBe(true);
  });
});

describe("cutsceneStepKind", () => {
  it("wait steps record unbudgeted — their duration IS the wait", () => {
    for (const k of ["pause", "wait", "waitChat", "waitRound"]) {
      expect(cutsceneStepKind(k)).toBe("cutscene-wait");
    }
  });

  it("executing steps record budgeted", () => {
    for (const k of ["chat", "move", "light", "roll", "place", "reveal"]) {
      expect(cutsceneStepKind(k)).toBe("cutscene-step");
    }
  });
});

describe("percentile", () => {
  it("nearest-rank over a known set", () => {
    const s = [10, 20, 30, 40, 50];
    expect(percentile(s, 50)).toBe(30);
    expect(percentile(s, 95)).toBe(50);
    expect(percentile(s, 100)).toBe(50);
    expect(percentile(s, 1)).toBe(10);
  });

  it("a single sample is its own p50 and p95", () => {
    expect(percentile([4213], 50)).toBe(4213);
    expect(percentile([4213], 95)).toBe(4213);
  });

  it("throws on an empty set", () => {
    expect(() => percentile([], 50)).toThrow("at least one sample");
  });
});

describe("summary + report", () => {
  it("an empty log reports zero actions, no kinds", () => {
    const report = new LatencyLog(fakeClock().now).summary();
    expect(report.total).toBe(0);
    expect(report.byKind).toEqual([]);
    expect(report.overBudget).toEqual([]);
    expect(formatLatencyReport(report)).toBe("Latency report (0 actions):");
  });

  it("groups by kind with p50/p95/max and over-budget counts", () => {
    const log = new LatencyLog(fakeClock().now);
    for (const ms of [10, 20, 30, 40, 50]) log.record("detect", 0, ms);
    log.record("detect", 0, 5000); // over the 3000ms budget
    log.record("room-build", 0, 60_000);
    const report = log.summary();
    expect(report.total).toBe(7);
    const detect = report.byKind.find((k) => k.kind === "detect")!;
    expect(detect.count).toBe(6);
    expect(detect.p50Ms).toBe(30);
    expect(detect.p95Ms).toBe(5000);
    expect(detect.maxMs).toBe(5000);
    expect(detect.overBudget).toBe(1);
    expect(detect.budgetMs).toBe(3000);
    const build = report.byKind.find((k) => k.kind === "room-build")!;
    expect(build.p50Ms).toBe(60_000);
    expect(build.overBudget).toBe(0);
    expect(report.overBudget).toHaveLength(1);
    expect(report.overBudget[0].durationMs).toBe(5000);
  });

  it("formatLatencyReport lists kinds and the over-budget section", () => {
    const log = new LatencyLog(fakeClock().now);
    log.record("detect", 0, 100);
    log.record("detect", 0, 4000);
    const text = formatLatencyReport(log.summary());
    expect(text).toContain("Latency report (2 actions):");
    expect(text).toContain("detect: n=2 p50=100ms p95=4000ms max=4000ms budget=3000 over=1");
    expect(text).toContain("Over budget:");
    expect(text).toContain("latency kind=detect");
  });

  it("no over-budget section when nothing is over", () => {
    const log = new LatencyLog(fakeClock().now);
    log.record("roll", 0, 100);
    expect(formatLatencyReport(log.summary())).not.toContain("Over budget:");
  });
});

describe("latencyLine", () => {
  const rec: LatencyRecord = {
    kind: "room-build",
    label: "m7",
    startedAtMs: 0,
    finishedAtMs: 4213,
    durationMs: 4213,
    budgetMs: 120000,
    overBudget: false,
  };

  it("one line per action, with label and budget", () => {
    expect(latencyLine(rec)).toBe(
      "latency kind=room-build label=m7 ms=4213 budget=120000 over=false",
    );
  });

  it("unbudgeted kinds print budget=none, unlabeled records omit the label", () => {
    expect(latencyLine({ ...rec, kind: "roll", label: undefined, budgetMs: null })).toBe(
      "latency kind=roll ms=4213 budget=none over=false",
    );
  });
});

// ---------------------------------------------------------------- fake live

const GM = "KpemqVj5YCznuMRK";
const OWN = "74bQ3Z3siKIJsXF2";
const PLAYER = "G4LfGOoX5ex27D5B";

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: "m1",
    author: PLAYER,
    content: "hello",
    style: 1,
    timestamp: 0,
    ...partial,
  };
}

interface SentMsg {
  content: string;
  opts: Record<string, unknown>;
}

function fakeLive(overrides: Record<string, unknown> = {}) {
  const sent: SentMsg[] = [];
  const idem: SentMsg[] = [];
  let n = 0;
  const live = {
    userId: OWN,
    sent,
    idem,
    getChatMessages: (_limit: number) => [],
    getUsers: () => [{ _id: GM, name: "Gamemaster", role: 4, active: true }],
    getCombatState: () => null,
    getWorldSummary: () => ({ title: "TestBed", counts: {} }),
    raw: () => ({
      getJournals: () => [],
      getWorldData: () => ({
        scenes: [{ _id: "scene-1", name: "Entry Hall", tokens: [], lights: [], tiles: [], walls: [] }],
        packs: [],
      }),
      getScenes: () => [],
      searchActors: async (_q: unknown) => ({ actors: [] }),
    }),
    on: (_fn: unknown) => () => {},
    sendChat: async (content: string, opts: Record<string, unknown> = {}) => {
      sent.push({ content, opts });
      return `sent-${++n}`;
    },
    sendChatIdempotent: async (content: string, opts: Record<string, unknown> = {}) => {
      idem.push({ content, opts });
      return { id: `idem-${++n}`, duplicate: false };
    },
    rollDice: async (formula: string) => ({
      formula,
      total: 17,
      breakdown: "12 + 5",
      timestamp: new Date().toISOString(),
      source: "local" as const,
    }),
    waitForChat: async () => ({ timedOut: true, newMessages: [], lastSeen: null }),
    ...overrides,
  };
  return live;
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const CHAT_SCRIPT = {
  version: 1,
  name: "Test Whisper",
  steps: [
    { kind: "chat", content: "Something stirs in the dark." },
    { kind: "pause", ms: 10 },
  ],
};

describe("runMonitor latency wiring (fake live, --once)", () => {
  it("a public roll records detect + roll, both under budget", async () => {
    const clock = fakeClock();
    const roll = msg({ id: "r1", content: "roll 1d20+5", timestamp: 998_800 });
    const live = fakeLive({
      waitForChat: async () => ({ timedOut: false, newMessages: [roll], lastSeen: roll.id }),
    });
    const logs: Record<string, unknown>[] = [];
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: true,
      clock: clock.now,
      onLog: (l) => logs.push(l as Record<string, unknown>),
    });
    expect(summary.rollsHandled).toBe(1);
    expect(summary.latency.total).toBe(2);
    const detect = summary.latency.byKind.find((k) => k.kind === "detect")!;
    expect(detect.count).toBe(1);
    expect(detect.p50Ms).toBe(1200);
    const rollStat = summary.latency.byKind.find((k) => k.kind === "roll")!;
    expect(rollStat.count).toBe(1);
    expect(rollStat.p50Ms).toBe(0); // fake clock never advances during the roll
    expect(summary.latency.overBudget).toEqual([]);
    // One latency line per action, no over-budget warning.
    expect(logs.filter((l) => l.event === "latency")).toHaveLength(2);
    expect(logs.filter((l) => l.event === "latency-over-budget")).toHaveLength(0);
  });

  it("a slow detect logs one over-budget warning line", async () => {
    const clock = fakeClock();
    const roll = msg({ id: "r2", content: "roll 1d20+5", timestamp: 995_000 });
    const live = fakeLive({
      waitForChat: async () => ({ timedOut: false, newMessages: [roll], lastSeen: roll.id }),
    });
    const logs: Record<string, unknown>[] = [];
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: true,
      clock: clock.now,
      onLog: (l) => logs.push(l as Record<string, unknown>),
    });
    expect(summary.latency.overBudget).toHaveLength(1);
    expect(summary.latency.overBudget[0].kind).toBe("detect");
    expect(summary.latency.overBudget[0].durationMs).toBe(5000);
    const warnings = logs.filter((l) => l.event === "latency-over-budget");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].kind).toBe("detect");
    expect(warnings[0].ms).toBe(5000);
    expect(warnings[0].budgetMs).toBe(3000);
  });

  it("a message without a timestamp records no detect (skipped, not guessed)", async () => {
    const clock = fakeClock();
    const roll = msg({ id: "r3", content: "roll 1d20+5", timestamp: 0 });
    const live = fakeLive({
      waitForChat: async () => ({ timedOut: false, newMessages: [roll], lastSeen: roll.id }),
    });
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: true,
      clock: clock.now,
      onLog: () => {},
    });
    expect(summary.latency.byKind.map((k) => k.kind)).toEqual(["roll"]);
  });

  it("a question records its answer latency", async () => {
    const clock = fakeClock();
    const q = msg({ id: "q1", content: "whose turn is it?", timestamp: 999_500 });
    const live = fakeLive({
      waitForChat: async () => ({ timedOut: false, newMessages: [q], lastSeen: q.id }),
    });
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: true,
      clock: clock.now,
      onLog: () => {},
    });
    expect(summary.answered).toBe(1);
    expect(summary.latency.total).toBe(2);
    expect(summary.latency.byKind.find((k) => k.kind === "question")?.p50Ms).toBe(0);
    expect(summary.latency.byKind.find((k) => k.kind === "detect")?.p50Ms).toBe(500);
  });

  it("a fired staged beat records first-effect + per-step latencies in the log", async () => {
    // Stage-then-fire (BRA-244): the script whisper only stages —
    // no effect lands, so no first-effect is recorded for it. The
    // budget runs from the GM's "fire" to the first effect, so the
    // first-effect and per-step records carry the fire message's id.
    const clock = fakeClock();
    const scriptMsg = msg({
      id: "w20",
      author: GM,
      content: `play this:\n\`\`\`json\n${JSON.stringify(CHAT_SCRIPT)}\n\`\`\``,
      whisper: [OWN],
      timestamp: 999_000,
    });
    const fireMsg = msg({
      id: "w21",
      author: GM,
      content: "fire",
      whisper: [OWN],
      timestamp: 999_500,
    });
    const queue = [scriptMsg, fireMsg];
    let calls = 0;
    const live = fakeLive({
      waitForChat: async () => {
        calls += 1;
        if (queue.length === 0) return { timedOut: true, newMessages: [], lastSeen: null };
        const m = queue.shift()!;
        return { timedOut: false, newMessages: [m], lastSeen: m.id };
      },
    });
    const logs: Record<string, unknown>[] = [];
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: false,
      clock: clock.now,
      onLog: (l) => logs.push(l as Record<string, unknown>),
      shouldStop: () => calls >= 2,
    });
    expect(summary.whispersHandled).toBe(2);
    expect(summary.stagesHandled).toBe(2);
    // The first effect lands in the background timeline, after the
    // loop's shutdown summary is taken — so it is in the log lines,
    // not necessarily in summary.latency. That is the documented
    // snapshot behavior, not a bug.
    await waitFor(() =>
      logs.some((l) => l.event === "latency" && l.kind === "whisper-first-effect"),
    );
    await waitFor(() => live.sent.some((m) => m.content.includes("finished")));
    const firstEffect = logs.find(
      (l) => l.event === "latency" && l.kind === "whisper-first-effect",
    )!;
    expect(firstEffect.ms).toBe(0); // fake clock never advances
    expect(firstEffect.over).toBe(false);
    // Per-step: the chat step is budgeted, the pause step is a wait.
    await waitFor(() =>
      logs.some((l) => l.event === "latency" && l.kind === "cutscene-step"),
    );
    await waitFor(() =>
      logs.some((l) => l.event === "latency" && l.kind === "cutscene-wait"),
    );
    const step = logs.find((l) => l.event === "latency" && l.kind === "cutscene-step")!;
    expect(step.label).toBe("w21:0");
    const wait = logs.find((l) => l.event === "latency" && l.kind === "cutscene-wait")!;
    expect(wait.label).toBe("w21:1");
    expect(wait.budgetMs).toBeNull();
  });

  it("a rejected whispered script records no first-effect (no effect landed)", async () => {
    const clock = fakeClock();
    const bad = { version: 2, name: "Bad", steps: [{ kind: "explode" }] };
    const whisper = msg({
      id: "w21",
      author: GM,
      content: `play this:\n\`\`\`json\n${JSON.stringify(bad)}\n\`\`\``,
      whisper: [OWN],
      timestamp: 999_000,
    });
    const live = fakeLive({
      waitForChat: async () => ({
        timedOut: false,
        newMessages: [whisper],
        lastSeen: whisper.id,
      }),
    });
    const logs: Record<string, unknown>[] = [];
    const summary = await runMonitor(live as unknown as FoundryLive, {
      once: true,
      clock: clock.now,
      onLog: (l) => logs.push(l as Record<string, unknown>),
    });
    expect(summary.whispersHandled).toBe(1);
    await waitFor(() => live.sent.some((m) => m.content.includes("doesn't stage")));
    expect(
      logs.filter((l) => l.event === "latency" && l.kind === "whisper-first-effect"),
    ).toHaveLength(0);
    // The detect record still shows the monitor woke.
    expect(summary.latency.byKind.find((k) => k.kind === "detect")?.count).toBe(1);
  });
});
