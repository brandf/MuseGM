/**
 * Tests for the dress-rehearsal runner harness (BRA-238).
 *
 * Two halves:
 * - The harness itself: runner statuses (pass/fail/skip/manual),
 *   evidence on failures, preconditions on skips, report rendering
 *   (text + JSON), and the registry's shape (unique ids, every check
 *   covers a BACKLOG item, live checks carry preconditions, manual
 *   checks carry steps, non-manual live checks carry a runLive).
 * - The checks: the whole offline subset runs green (16 pass / 0
 *   fail), and one default live check (live-dice-roll) executes its
 *   runLive against a compact fake — which proves the harness's live
 *   path works. The fake is for the harness only: live results are
 *   proven only against the real server, when it is up (the fake
 *   never stands in for a live pass in the CLI's offline run).
 *
 * No connection is ever made, and no env vars are needed: the
 * rehearsal module lazy-loads the live builders (tiles.ts pulls in
 * the vendored client, which validates FOUNDRY_URL at import time),
 * so the static import below is safe with no server.
 * Run: bun test tests/rehearsal.test.ts
 */
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
  checkResultFor,
  defaultRehearsalChecks,
  findRehearsalCheck,
  pngSizePx,
  renderRehearsalReport,
  rehearsalReportToJson,
  runRehearsal,
  type RehearsalCheck,
  type RehearsalContext,
} from "../src/session/rehearsal.js";
import { loadPack } from "../src/worldbuilding/tiles-layout.js";
import type { FoundryLive } from "../src/live.js";
import type { DiceRollResult } from "../src/types.js";

const pack = loadPack(path.resolve(import.meta.dir, "../tiles/manifest.json"));
const ctx: RehearsalContext = { pack, serverBase: "worlds/testbed" };

describe("registry shape", () => {
  test("32 checks with unique ids", () => {
    const checks = defaultRehearsalChecks();
    expect(checks).toHaveLength(32);
    expect(new Set(checks.map((c) => c.id)).size).toBe(32);
  });

  test("16 offline, 16 live, 8 of the live ones manual", () => {
    const checks = defaultRehearsalChecks();
    expect(checks.filter((c) => c.kind === "offline")).toHaveLength(16);
    expect(checks.filter((c) => c.kind === "live")).toHaveLength(16);
    expect(checks.filter((c) => c.manualSteps)).toHaveLength(8);
  });

  test("every check names the BACKLOG item it covers", () => {
    for (const c of defaultRehearsalChecks()) {
      expect(c.id.length).toBeGreaterThan(0);
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.backlog.length).toBeGreaterThan(0);
    }
  });

  test("offline checks have run; live checks have a precondition", () => {
    for (const c of defaultRehearsalChecks()) {
      if (c.kind === "offline") expect(typeof c.run).toBe("function");
      if (c.kind === "live") {
        expect(c.precondition).toBeDefined();
        expect(c.precondition!.length).toBeGreaterThan(0);
      }
    }
  });

  test("manual live checks carry steps and no runLive; the rest carry runLive", () => {
    for (const c of defaultRehearsalChecks()) {
      if (c.kind !== "live") continue;
      if (c.manualSteps) {
        expect(c.manualSteps.length).toBeGreaterThan(0);
        expect(c.runLive).toBeUndefined();
      } else {
        expect(typeof c.runLive).toBe("function");
      }
    }
  });

  test("findRehearsalCheck finds by id and misses cleanly", () => {
    expect(findRehearsalCheck("pack-complete")?.id).toBe("pack-complete");
    expect(findRehearsalCheck("live-dressed-room")?.kind).toBe("live");
    expect(findRehearsalCheck("no-such-check")).toBeUndefined();
  });
});

describe("runner semantics", () => {
  test("a failing check reports fail with its evidence, not just a label", async () => {
    const checks: RehearsalCheck[] = [
      {
        id: "always-fails",
        title: "Always fails",
        backlog: "test",
        kind: "offline",
        run: () => ({ passed: false, evidence: "expected 2 rooms, got 1", detail: { expected: 2, actual: 1 } }),
      },
    ];
    const report = await runRehearsal(checks, ctx);
    expect(report.failed).toBe(1);
    expect(report.passed).toBe(0);
    expect(report.results[0].status).toBe("fail");
    expect(report.results[0].evidence).toBe("expected 2 rooms, got 1");
    expect(report.results[0].detail).toEqual({ expected: 2, actual: 1 });
  });

  test("a throwing check fails with the error message as its evidence", async () => {
    const checks: RehearsalCheck[] = [
      {
        id: "throws",
        title: "Throws",
        backlog: "test",
        kind: "offline",
        run: () => {
          throw new Error("boom: the pack file vanished");
        },
      },
    ];
    const report = await runRehearsal(checks, ctx);
    expect(report.failed).toBe(1);
    expect(report.results[0].evidence).toBe("boom: the pack file vanished");
  });

  test("a live check without a connection skips with its precondition, never passes", async () => {
    const checks: RehearsalCheck[] = [
      {
        id: "needs-server",
        title: "Needs a server",
        backlog: "test",
        kind: "live",
        precondition: "The server is up.",
        runLive: () => ({ passed: true, evidence: "would have passed" }),
      },
    ];
    const report = await runRehearsal(checks, ctx);
    expect(report.skipped).toBe(1);
    expect(report.passed).toBe(0);
    expect(report.results[0].status).toBe("skip");
    expect(report.results[0].evidence).toBe("The server is up.");
  });

  test("a manual live check with a connection reports manual, with its steps", async () => {
    const fakeLive = {} as FoundryLive;
    const checks: RehearsalCheck[] = [
      {
        id: "needs-hands",
        title: "Needs hands",
        backlog: "test",
        kind: "live",
        precondition: "The server is up.",
        manualSteps: ["Click the torch.", "Watch the light flip."],
      },
    ];
    const report = await runRehearsal(checks, { ...ctx, live: fakeLive });
    expect(report.manual).toBe(1);
    expect(report.passed).toBe(0);
    expect(report.results[0].status).toBe("manual");
    expect(report.results[0].evidence).toContain("Click the torch.");
  });

  test("runRehearsal passes the live connection through to runLive", async () => {
    const fakeLive = { userId: "mcp-api" } as unknown as FoundryLive;
    let seen: unknown = null;
    const checks: RehearsalCheck[] = [
      {
        id: "sees-live",
        title: "Sees live",
        backlog: "test",
        kind: "live",
        precondition: "The server is up.",
        runLive: (c) => {
          seen = c.live;
          return { passed: true, evidence: "saw the connection" };
        },
      },
    ];
    const report = await runRehearsal(checks, { ...ctx, live: fakeLive });
    expect(report.passed).toBe(1);
    expect(seen).toBe(fakeLive);
  });

  test("checkResultFor maps passed true/false to pass/fail", () => {
    const check: RehearsalCheck = { id: "x", title: "X", backlog: "test", kind: "offline" };
    expect(checkResultFor(check, { passed: true, evidence: "ok" }).status).toBe("pass");
    expect(checkResultFor(check, { passed: false, evidence: "nope" }).status).toBe("fail");
  });

  test("text report carries the marks, the failure evidence, and the counts", async () => {
    const checks: RehearsalCheck[] = [
      { id: "good", title: "Good", backlog: "test", kind: "offline", run: () => ({ passed: true, evidence: "ok" }) },
      { id: "bad", title: "Bad", backlog: "test", kind: "offline", run: () => ({ passed: false, evidence: "expected 2, got 1" }) },
      { id: "later", title: "Later", backlog: "test", kind: "live", precondition: "Server up.", runLive: () => ({ passed: true, evidence: "ok" }) },
    ];
    const report = await runRehearsal(checks, ctx);
    const text = renderRehearsalReport(report);
    expect(text).toContain("[PASS] good");
    expect(text).toContain("[FAIL] bad");
    expect(text).toContain("expected 2, got 1");
    expect(text).toContain("[SKIP] later");
    expect(text).toContain("1 pass, 1 fail, 1 skip, 0 manual (of 3");
    const json = rehearsalReportToJson(report) as { passed: number; failed: number; skipped: number };
    expect(json.passed).toBe(1);
    expect(json.failed).toBe(1);
    expect(json.skipped).toBe(1);
  });
});

describe("pngSizePx", () => {
  test("reads a real tile PNG's size from its IHDR", () => {
    expect(pngSizePx(path.resolve(import.meta.dir, "../tiles/pack/candle.png"))).toEqual({
      w: 100,
      h: 100,
    });
  });

  test("throws on a non-PNG", () => {
    expect(() => pngSizePx(path.resolve(import.meta.dir, "rehearsal.test.ts"))).toThrow(/not a PNG/);
  });
});

describe("the offline subset, end to end", () => {
  test("all 16 offline checks pass, 0 fail", async () => {
    const offline = defaultRehearsalChecks().filter((c) => c.kind === "offline");
    const report = await runRehearsal(offline, ctx);
    expect(report.total).toBe(16);
    expect(report.passed).toBe(16);
    expect(report.failed).toBe(0);
    expect(report.skipped).toBe(0);
    expect(report.manual).toBe(0);
  });

  test("the full registry offline: 16 pass, 16 skip, 0 fail, 0 manual", async () => {
    const report = await runRehearsal(defaultRehearsalChecks(), ctx);
    expect(report.total).toBe(32);
    expect(report.passed).toBe(16);
    expect(report.failed).toBe(0);
    expect(report.skipped).toBe(16);
    expect(report.manual).toBe(0);
  });
});

describe("a default live check against a compact fake", () => {
  /**
   * Compact fake, modeled on the tile-keys FakeLive: only the calls
   * rollForChat makes (rollDice + chat posts). This proves the
   * harness's live path executes a real check's runLive — it does not
   * prove the live server; the CLI's offline run still skips this
   * check, and the first real proof comes from the server being up.
   */
  test("live-dice-roll runs its runLive and posts the roll", async () => {
    const chats: string[] = [];
    const fake = {
      userId: "mcp-api",
      async rollDice(formula: string): Promise<DiceRollResult> {
        return {
          formula,
          total: 14,
          breakdown: "1d20 (9) + 5 = 14",
          timestamp: new Date().toISOString(),
          source: "local",
        };
      },
      async sendChat(content: string): Promise<string> {
        chats.push(content);
        return `msg-${chats.length}`;
      },
      async sendChatIdempotent(
        content: string,
        _opts: { dedupeKey: string },
      ): Promise<{ id: string; duplicate: boolean }> {
        chats.push(content);
        return { id: `msg-${chats.length}`, duplicate: false };
      },
    } as unknown as FoundryLive;
    const check = findRehearsalCheck("live-dice-roll")!;
    const report = await runRehearsal([check], { ...ctx, live: fake });
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(0);
    expect(chats).toHaveLength(1);
    expect(chats[0]).toContain("14");
  });
});
