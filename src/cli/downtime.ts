export {};
import type { DowntimeKind } from "../session/downtime.js";
/**
 * downtime CLI — downtime ledger (BRA-204, P3).
 *
 * Usage (each prints one JSON object to stdout):
 *   bun run src/cli/downtime.ts --demo
 *       No connection: build the demo ledger (Valeros shops, Ezren
 *       crafts a sword over two sessions of partial progress, Kyra
 *       trains, Merisiel's rest is proposed but not confirmed) and
 *       print it + the summary.
 *   bun run src/cli/downtime.ts --list
 *       Live: read the downtime ledger and print it + the summary.
 *   bun run src/cli/downtime.ts --show --character <name>
 *       Live: print one character's ledger view.
 *   bun run src/cli/downtime.ts --start --character <name> --kind <kind>
 *       --title <title> [--cost <gp>] [--days <n>] [--detail <text>]
 *       [--outcome <text>] --source <who/what>
 *       Live: propose a downtime activity (journal page + index
 *       refresh + chat line). Nothing takes effect until the GM
 *       confirms it.
 *   bun run src/cli/downtime.ts --heal --character <name>
 *       --rest rest8h|treatWounds [--title <title>] [--detail <text>]
 *       --source <who/what>
 *       Live: propose a healing activity from the rest rules. The
 *       proposal quotes the rule; the GM confirms it — no HP is ever
 *       applied here.
 *   bun run src/cli/downtime.ts --confirm --id <activity-id>
 *       Live: the GM confirms a proposed activity.
 *   bun run src/cli/downtime.ts --advance --id <activity-id> --days <n>
 *       --source <who/what>
 *       Live: advance a crafting / training / research activity by
 *       days of work. Progress persists across sessions.
 *   bun run src/cli/downtime.ts --complete --id <activity-id>
 *       --outcome <text> --source <who/what>
 *       Live: complete an activity with the outcome in the GM's words.
 *   bun run src/cli/downtime.ts --cancel --id <activity-id> --source <who/what>
 *       Live: cancel an activity.
 *
 * Args are parsed and --help is handled BEFORE the library import, so
 * `bun run src/cli/downtime.ts --help` works with no connection and no
 * env. LOG_LEVEL is forced to error before the library import so the
 * vendored client's info logs don't corrupt stdout (see wait.ts).
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function argNum(name: string): number | undefined {
  const raw = arg(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

const USAGE =
  "usage: bun run src/cli/downtime.ts --demo | --list | --show --character <name> | --start --character <name> --kind <kind> --title <title> [--cost <gp>] [--days <n>] [--detail <text>] [--outcome <text>] --source <s> | --heal --character <name> --rest rest8h|treatWounds [--title <t>] [--detail <text>] --source <s> | --confirm --id <id> | --advance --id <id> --days <n> --source <s> | --complete --id <id> --outcome <text> --source <s> | --cancel --id <id> --source <s>";

function usage(): never {
  process.stderr.write(USAGE + "\n");
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv;
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE + "\n");
    return;
  }

  process.env.LOG_LEVEL ??= "error";
  const dt = await import("../session/downtime.js");

  if (argv.includes("--demo")) {
    const ledger = dt.demoLedger();
    process.stdout.write(
      JSON.stringify({ ledger, text: dt.summarizeDowntime(ledger) }) + "\n",
    );
    return;
  }

  const { FoundryLive } = await import("../live.js");
  const live = await FoundryLive.connect();
  try {
    if (argv.includes("--list")) {
      const { entryId, ledger } = dt.listDowntimeLive(live);
      process.stdout.write(
        JSON.stringify({ entryId, ledger, text: dt.summarizeDowntime(ledger) }) + "\n",
      );
      return;
    }

    if (argv.includes("--show")) {
      const character = arg("--character");
      if (!character) usage();
      const { ledger } = dt.listDowntimeLive(live);
      const view = dt.characterLedger(ledger, character!);
      process.stdout.write(
        JSON.stringify({
          view,
          text:
            view.activities.length > 0
              ? view.activities.map((a) => dt.activityToText(a)).join("\n\n")
              : `${character} has no downtime yet.`,
        }) + "\n",
      );
      return;
    }

    if (argv.includes("--start")) {
      const character = arg("--character");
      const kind = arg("--kind");
      const title = arg("--title");
      const source = arg("--source");
      if (!character || !kind || !title || !source) usage();
      const result = await dt.startActivityLive(live, {
        kind: kind as DowntimeKind,
        character,
        title,
        detail: arg("--detail"),
        costGp: argNum("--cost"),
        days: argNum("--days"),
        proposedOutcome: arg("--outcome"),
        source,
      });
      process.stdout.write(
        JSON.stringify({ activity: result.activity, pageId: result.pageId, entryId: result.entryId }) + "\n",
      );
      return;
    }

    if (argv.includes("--heal")) {
      const character = arg("--character");
      const rest = arg("--rest");
      const source = arg("--source");
      if (!character || !rest || !source) usage();
      const result = await dt.proposeHealingLive(live, {
        character,
        rest: rest!,
        title: arg("--title"),
        detail: arg("--detail"),
        source,
      });
      process.stdout.write(
        JSON.stringify({ activity: result.activity, pageId: result.pageId, entryId: result.entryId }) + "\n",
      );
      return;
    }

    if (argv.includes("--confirm")) {
      const id = arg("--id");
      if (!id) usage();
      const result = await dt.confirmActivityLive(live, id);
      process.stdout.write(JSON.stringify({ activity: result.activity }) + "\n");
      return;
    }

    if (argv.includes("--advance")) {
      const id = arg("--id");
      const days = argNum("--days");
      const source = arg("--source");
      if (!id || days === undefined || !source) usage();
      const result = await dt.advanceActivityLive(live, id, days, source);
      process.stdout.write(
        JSON.stringify({ activity: result.activity, becameReady: result.becameReady }) + "\n",
      );
      return;
    }

    if (argv.includes("--complete")) {
      const id = arg("--id");
      const outcome = arg("--outcome");
      const source = arg("--source");
      if (!id || !outcome || !source) usage();
      const result = await dt.completeActivityLive(live, id, outcome, source);
      process.stdout.write(
        JSON.stringify({ activity: result.activity, alreadyCompleted: result.alreadyCompleted }) + "\n",
      );
      return;
    }

    if (argv.includes("--cancel")) {
      const id = arg("--id");
      const source = arg("--source");
      if (!id || !source) usage();
      const result = await dt.cancelActivityLive(live, id, source);
      process.stdout.write(
        JSON.stringify({ activity: result.activity, alreadyCancelled: result.alreadyCancelled }) + "\n",
      );
      return;
    }

    usage();
  } finally {
    await live.disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`downtime failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
