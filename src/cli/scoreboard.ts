export {};
/**
 * scoreboard CLI — visible score/points tracking for contests (BRA-237).
 *
 * Usage (each prints one JSON object to stdout):
 *   bun run src/cli/scoreboard.ts --demo
 *       No connection: run a demo dragon-soccer board (start, goals,
 *       a foul, a winner) and print it + the one-line summary.
 *   bun run src/cli/scoreboard.ts --list
 *       Live: read the scoreboards and print them + the summaries.
 *   bun run src/cli/scoreboard.ts --show --board <board-id>
 *       Live: print one board.
 *   bun run src/cli/scoreboard.ts --start --name <name> --target <n>
 *       --team <name> [--team <name> ...]
 *       Live: start a board (journal page + index refresh + chat line).
 *   bun run src/cli/scoreboard.ts --award --board <id> --team <name>
 *       --points <n> --source <who/what>
 *       Live: award points (negative for a foul).
 *   bun run src/cli/scoreboard.ts --set --board <id> --team <name>
 *       --points <n> --source <who/what>
 *       Live: set a team's points outright.
 *   bun run src/cli/scoreboard.ts --end --board <id>
 *       Live: end a board early (leader wins, tie ends with no winner).
 *
 * Args are parsed and --help is handled BEFORE the library import, so
 * `bun run src/cli/scoreboard.ts --help` works with no connection and
 * no env. LOG_LEVEL is forced to error before the library import so
 * the vendored client's info logs don't corrupt stdout (see wait.ts).
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function argAll(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === name && i + 1 < process.argv.length) out.push(process.argv[i + 1]);
  }
  return out;
}

const USAGE =
  "usage: bun run src/cli/scoreboard.ts --demo | --list | --show --board <id> | --start --name <name> --target <n> --team <name> [--team <name> ...] | --award --board <id> --team <name> --points <n> --source <s> | --set --board <id> --team <name> --points <n> --source <s> | --end --board <id>";

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
  const sb = await import("../session/scoreboard.js");

  if (argv.includes("--demo")) {
    let board = sb.startScoreboard({
      name: "Dragon Soccer",
      target: 3,
      teams: ["Red", "Blue"],
      createdAt: "2026-11-20",
    });
    board = sb.awardPoints(board, "Red", 1, "Valeros scored").board;
    board = sb.awardPoints(board, "Blue", 1, "Kyra scored").board;
    board = sb.awardPoints(board, "Red", -1, "fire foul on the Red side").board;
    board = sb.awardPoints(board, "Red", 3, "a long shot, then two quick goals").board;
    process.stdout.write(
      JSON.stringify({ board, text: sb.scoreboardToText(board) }) + "\n",
    );
    return;
  }

  const { FoundryLive } = await import("../live.js");
  const live = await FoundryLive.connect();
  try {
    if (argv.includes("--list")) {
      const result = sb.listScoreboardsLive(live);
      process.stdout.write(
        JSON.stringify({ entryId: result.entryId, store: result.store, text: result.text }) + "\n",
      );
      return;
    }

    if (argv.includes("--show")) {
      const boardId = arg("--board");
      if (!boardId) usage();
      const { store } = sb.listScoreboardsLive(live);
      const board = sb.getBoard(store, boardId);
      if (!board) throw new sb.ScoreboardError(`Unknown scoreboard: ${boardId}`);
      process.stdout.write(JSON.stringify({ board, text: sb.scoreboardToText(board) }) + "\n");
      return;
    }

    if (argv.includes("--start")) {
      const name = arg("--name");
      const target = arg("--target");
      const teams = argAll("--team");
      if (!name || !target || teams.length < 2) usage();
      const targetN = Number(target);
      if (!Number.isInteger(targetN)) usage();
      const result = await sb.startScoreboardLive(live, { name, target: targetN, teams });
      process.stdout.write(
        JSON.stringify({ board: result.board, pageId: result.pageId, entryId: result.entryId }) +
          "\n",
      );
      return;
    }

    if (argv.includes("--award") || argv.includes("--set")) {
      const boardId = arg("--board");
      const team = arg("--team");
      const points = arg("--points");
      const source = arg("--source");
      if (!boardId || !team || points === undefined || !source) usage();
      const n = Number(points);
      if (!Number.isInteger(n)) usage();
      if (argv.includes("--award")) {
        const result = await sb.awardPointsLive(live, boardId, team, n, source);
        process.stdout.write(
          JSON.stringify({ board: result.board, event: result.event, won: result.won }) + "\n",
        );
      } else {
        const result = await sb.setPointsLive(live, boardId, team, n, source);
        process.stdout.write(
          JSON.stringify({ board: result.board, event: result.event, won: result.won }) + "\n",
        );
      }
      return;
    }

    if (argv.includes("--end")) {
      const boardId = arg("--board");
      if (!boardId) usage();
      const result = await sb.endScoreboardLive(live, boardId);
      process.stdout.write(
        JSON.stringify({ board: result.board, alreadyFinished: result.alreadyFinished }) + "\n",
      );
      return;
    }

    usage();
  } finally {
    await live.disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`scoreboard failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
