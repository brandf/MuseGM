/**
 * build-loop CLI — the chat-driven building loop (FR-1) + undo (FR-8),
 * offline. No connection: parse GM lines, plan the edits, print the
 * spec diff and the chat line the monitor would post.
 *
 * Usage (prints one JSON object to stdout):
 *   bun run src/cli/build-loop.ts --demo
 *       The canned Nov 19 script: build the Entry Hall, add a secret
 *       door, widen it, carve a corridor, add bones, undo, redo.
 *   bun run src/cli/build-loop.ts --say "<line>" [--spec <dungeon.json>]
 *       Parse one line against the demo room (8x6 Entry Hall, south
 *       door) or the dungeon in --spec, and print the plan: the parse,
 *       the op, the spec diff, and the chat line.
 *
 * Arg parsing and --help run BEFORE the library import: importing the
 * live layer validates FOUNDRY_URL at import time (see dice.ts), so
 * --help must work with no connection and no env vars. LOG_LEVEL is
 * forced to error before the import so the vendored client's info logs
 * don't corrupt stdout (see wait.ts).
 */
import * as fs from "node:fs";

process.env.LOG_LEVEL ??= "error";
const {
  BuildSession,
  describeDungeon,
  diffSummary,
  formatBuildLine,
  parseBuildRequest,
  validateDungeonRooms,
} = await import("../session/build-loop.js");
const { loadPack } = await import("../worldbuilding/tiles-layout.js");
import type { DungeonSpec } from "../worldbuilding/tiles-layout.js";
import type { BuildSession as BuildSessionType } from "../session/build-loop.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function usage(): never {
  process.stderr.write(
    "usage: bun run src/cli/build-loop.ts --demo\n" +
      "   or: bun run src/cli/build-loop.ts --say \"<line>\" [--spec <dungeon.json>]\n",
  );
  process.exit(2);
}

/** The canned demo room: the 8x6 Entry Hall the Nov 19 session built. */
function demoDungeon(): DungeonSpec {
  return {
    rooms: [
      {
        id: "entry-hall",
        name: "Entry Hall",
        gridW: 8,
        gridH: 6,
        seed: 1,
        doors: [{ wall: "south", at: 3 }],
      },
    ],
    links: [],
  };
}

/** The canned Nov 19 script: one room, built iteratively in chat. */
const DEMO_LINES = [
  "build an 8x6 entry hall with a south door",
  "add a secret door in the north wall",
  "make this room 10 units wider",
  "add a corridor going north for 100 meters",
  "add some bones",
  "undo that",
  "redo that",
];

const SERVER_BASE = "worlds/testbed";

async function main(): Promise<void> {
  const pack = loadPack();
  if (has("--demo")) {
    const session = new BuildSession();
    const steps: Record<string, unknown>[] = [];
    for (const said of DEMO_LINES) {
      const before = session.current();
      const parsed = parseBuildRequest(said, {
        room: session.activeRoomSpec() ?? undefined,
      });
      if (!parsed) {
        steps.push({ said, kind: "not-build" });
        continue;
      }
      if (parsed.kind === "clarify") {
        steps.push({ said, kind: "clarify", question: parsed.question });
        continue;
      }
      if (parsed.kind === "unsupported") {
        steps.push({ said, kind: "unsupported", reason: parsed.reason });
        continue;
      }
      const op = parsed.op;
      if (op.type === "undo") {
        const entry = session.undo();
        steps.push({
          said,
          kind: "build",
          op,
          summary: entry ? `Undid: ${entry.summary}` : "Nothing to undo yet.",
          chatLine: entry ? `↩️ Undid: ${entry.summary}` : "Nothing to undo yet.",
          diff: diffSummary(before.dungeon, session.current().dungeon),
        });
        continue;
      }
      if (op.type === "redo") {
        const entry = session.redo();
        steps.push({
          said,
          kind: "build",
          op,
          summary: entry ? `Redid: ${entry.summary}` : "Nothing to redo.",
          chatLine: entry ? `↪️ Redid: ${entry.summary}` : "Nothing to redo.",
          diff: diffSummary(before.dungeon, session.current().dungeon),
        });
        continue;
      }
      try {
        const peeked = session.peek(op, { pack });
        validateDungeonRooms(peeked.state.dungeon, pack, SERVER_BASE);
        if (peeked.changed) session.commit(peeked.state, said, op, peeked.summary);
        steps.push({
          said,
          kind: "build",
          op,
          summary: peeked.summary,
          chatLine: formatBuildLine(peeked.summary, op),
          diff: diffSummary(before.dungeon, session.current().dungeon),
        });
      } catch (err) {
        steps.push({
          said,
          kind: "build",
          op,
          error: err instanceof Error ? err.message : String(err),
          chatLine: `I couldn't build that — ${err instanceof Error ? err.message : String(err)}`,
          diff: ["(no change)"],
        });
      }
    }
    process.stdout.write(
      JSON.stringify({
        steps,
        finalDungeon: describeDungeon(session.current().dungeon),
        history: session.history().map((e) => e.summary),
      }) + "\n",
    );
    return;
  }

  const said = arg("--say");
  if (said === undefined) usage();
  let session: BuildSessionType;
  const specPath = arg("--spec");
  if (specPath !== undefined) {
    try {
      const dungeon = JSON.parse(fs.readFileSync(specPath, "utf8")) as DungeonSpec;
      session = new BuildSession(dungeon);
    } catch (err) {
      process.stderr.write(
        `build-loop failed: cannot read dungeon ${specPath}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  } else {
    session = new BuildSession(demoDungeon());
  }
  const before = session.current();
  const parsed = parseBuildRequest(said, {
    room: session.activeRoomSpec() ?? undefined,
  });
  if (!parsed) {
    process.stdout.write(JSON.stringify({ said, kind: "not-build" }) + "\n");
    return;
  }
  if (parsed.kind === "clarify") {
    process.stdout.write(
      JSON.stringify({ said, kind: "clarify", question: parsed.question }) + "\n",
    );
    return;
  }
  if (parsed.kind === "unsupported") {
    process.stdout.write(
      JSON.stringify({
        said,
        kind: "unsupported",
        reason: parsed.reason,
        chatLine: `I can't do that yet — ${parsed.reason}.`,
      }) + "\n",
    );
    return;
  }
  const op = parsed.op;
  if (op.type === "undo" || op.type === "redo") {
    const entry = op.type === "undo" ? session.undo() : session.redo();
    process.stdout.write(
      JSON.stringify({
        said,
        kind: "build",
        op,
        summary: entry
          ? `${op.type === "undo" ? "Undid" : "Redid"}: ${entry.summary}`
          : `Nothing to ${op.type}.`,
        chatLine: entry
          ? `${op.type === "undo" ? "↩️" : "↪️"} ${op.type === "undo" ? "Undid" : "Redid"}: ${entry.summary}`
          : `Nothing to ${op.type}.`,
        before: describeDungeon(before.dungeon),
        after: describeDungeon(session.current().dungeon),
        diff: diffSummary(before.dungeon, session.current().dungeon),
      }) + "\n",
    );
    return;
  }
  try {
    const peeked = session.peek(op, { pack });
    validateDungeonRooms(peeked.state.dungeon, pack, SERVER_BASE);
    if (peeked.changed) session.commit(peeked.state, said, op, peeked.summary);
    process.stdout.write(
      JSON.stringify({
        said,
        kind: "build",
        op,
        summary: peeked.summary,
        chatLine: formatBuildLine(peeked.summary, op),
        before: describeDungeon(before.dungeon),
        after: describeDungeon(session.current().dungeon),
        diff: diffSummary(before.dungeon, session.current().dungeon),
      }) + "\n",
    );
  } catch (err) {
    process.stdout.write(
      JSON.stringify({
        said,
        kind: "build",
        op,
        error: err instanceof Error ? err.message : String(err),
        chatLine: `I couldn't build that — ${err instanceof Error ? err.message : String(err)}`,
        before: describeDungeon(before.dungeon),
        after: describeDungeon(session.current().dungeon),
      }) + "\n",
    );
  }
}

main().catch((err) => {
  process.stderr.write(`build-loop failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
