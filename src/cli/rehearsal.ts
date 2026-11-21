/**
 * Dress-rehearsal CLI (BRA-238): "go and check it" runs the live-test
 * suite and reports breakage.
 *
 *   bun run src/cli/rehearsal.ts --list
 *       List every check: id, kind (offline/live), the BACKLOG item it
 *       covers, and the live precondition (or the manual steps) for
 *       live checks. No connection.
 *   bun run src/cli/rehearsal.ts --run [--json]
 *       Run the offline checks; live checks are SKIPPED with their
 *       preconditions (never reported as a pass, never faked). Prints
 *       the text report (or JSON with --json). Exits 1 iff any check
 *       failed; skips and manual checks do not fail the run.
 *   bun run src/cli/rehearsal.ts --run --live [--json]
 *       Run the whole rehearsal against the live server: connects as
 *       mcp-api, runs the offline checks AND the live checks (manual
 *       checks still report as manual — they need a human eye/hand).
 *       The server must be up; a failed connect is an error, not a
 *       rehearsal result. Disconnects at the end.
 *   bun run src/cli/rehearsal.ts --check <id> [--live] [--json]
 *       Run one check by id.
 *
 * The checks are the BACKLOG live-test checklists, encoded in
 * src/session/rehearsal.ts. See that module for the honesty rules
 * (failures carry evidence, skips carry preconditions, manual checks
 * are a fourth status, never a pass).
 *
 * LOG_LEVEL is forced to error before the library import so the
 * vendored client's info logs don't corrupt stdout (see wait.ts).
 */
export {};
process.env.LOG_LEVEL ??= "error";
import {
  REHEARSAL_SERVER_BASE,
  defaultRehearsalChecks,
  findRehearsalCheck,
  renderRehearsalReport,
  rehearsalReportToJson,
  runRehearsal,
  type RehearsalCheck,
  type RehearsalContext,
  type RehearsalReport,
} from "../session/rehearsal.js";
import { loadPack } from "../worldbuilding/tiles-layout.js";

const USAGE = [
  "usage: rehearsal --list",
  "       rehearsal --run [--live] [--json]",
  "       rehearsal --check <id> [--live] [--json]",
  "       rehearsal --help",
  "",
  "--list        list every check with its kind and BACKLOG item",
  "--run         run the offline checks (live checks skip); --live runs the whole rehearsal against the server",
  "--check <id>  run one check by id",
  "--json        print the report as JSON instead of text",
].join("\n");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function usage(): never {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

function listChecks(checks: RehearsalCheck[]): void {
  for (const c of checks) {
    const extra =
      c.kind === "live"
        ? c.manualSteps
          ? " [manual — needs a human eye/hand at the table]"
          : " [live]"
        : "";
    process.stdout.write(`${c.id} (${c.kind}) — ${c.title}${extra}\n  covers: ${c.backlog}\n`);
    if (c.kind === "live" && c.precondition) {
      process.stdout.write(`  needs: ${c.precondition}\n`);
    }
    if (c.manualSteps) {
      for (const step of c.manualSteps) process.stdout.write(`  step: ${step}\n`);
    }
  }
  const offline = checks.filter((c) => c.kind === "offline").length;
  const live = checks.filter((c) => c.kind === "live").length;
  const manual = checks.filter((c) => c.manualSteps).length;
  process.stdout.write(`\n${checks.length} checks: ${offline} offline, ${live} live (${manual} manual).\n`);
}

function printReport(report: RehearsalReport, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(rehearsalReportToJson(report), null, 2)}\n`);
  } else {
    process.stdout.write(`${renderRehearsalReport(report)}\n`);
  }
}

async function main(): Promise<void> {
  if (has("--help")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const checks = defaultRehearsalChecks();
  if (has("--list")) {
    listChecks(checks);
    return;
  }
  const json = has("--json");
  const wantLive = has("--live");
  const checkId = arg("--check");
  const toRun: RehearsalCheck[] = checkId
    ? (() => {
        const found = findRehearsalCheck(checkId);
        if (!found) {
          process.stderr.write(`No rehearsal check "${checkId}". Run --list to see them.\n`);
          process.exit(2);
        }
        return [found];
      })()
    : checks;
  if (!has("--run") && !checkId) usage();

  const pack = loadPack();
  const ctx: RehearsalContext = { pack, serverBase: REHEARSAL_SERVER_BASE };
  let report: RehearsalReport;
  if (!wantLive) {
    report = await runRehearsal(toRun, ctx);
  } else {
    // Lazy import: importing live.js validates FOUNDRY_URL at import
    // time, so --help/--list/--run stay usable with no connection.
    const { FoundryLive } = await import("../live.js");
    const live = await FoundryLive.connect();
    try {
      report = await runRehearsal(toRun, { ...ctx, live });
    } finally {
      await live.disconnect();
    }
  }
  printReport(report, json);
  if (report.failed > 0) process.exit(1);
}

await main();
