export {};
/**
 * questlog CLI — quest log (P3).
 *
 * Usage (each prints one JSON object to stdout):
 *   bun run src/cli/questlog.ts --demo
 *       No connection: build a small demo log (two quests, one objective
 *       completed, one failed) and print it + the party summary.
 *   bun run src/cli/questlog.ts --list
 *       Live: read the quest log and print it + the party summary.
 *   bun run src/cli/questlog.ts --show --quest <quest-id>
 *       Live: print one quest.
 *   bun run src/cli/questlog.ts --add --title <title> [--giver <name>]
 *       [--objective <text> ...] [--note <text> --source <who/what>]
 *       Live: add a quest (journal page + index refresh + chat line).
 *   bun run src/cli/questlog.ts --objective --quest <quest-id> --objective-id <objective-id>
 *       Live: mark an objective done.
 *   bun run src/cli/questlog.ts --objective --quest <quest-id> --add <text>
 *       Live: add an objective to an active quest.
 *   bun run src/cli/questlog.ts --note --quest <quest-id> --text <text> --source <who/what>
 *       Live: add a note to a quest (the source is required — see
 *       src/session/questlog.ts: the log never gains unsourced facts).
 *   bun run src/cli/questlog.ts --complete --quest <quest-id>
 *       Live: complete a quest.
 *   bun run src/cli/questlog.ts --fail --quest <quest-id>
 *       Live: fail a quest.
 *
 * Args are parsed and --help is handled BEFORE the library import, so
 * `bun run src/cli/questlog.ts --help` works with no connection and no
 * env. LOG_LEVEL is forced to error before the library import so the
 * vendored client's info logs don't corrupt stdout (see wait.ts).
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
  "usage: bun run src/cli/questlog.ts --demo | --list | --show --quest <id> | --add --title <title> [--giver <name>] [--objective <text> ...] [--note <text> --source <s>] | --objective --quest <id> (--objective-id <oid> | --add <text>) | --note --quest <id> --text <t> --source <s> | --complete --quest <id> | --fail --quest <id>";

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
  const ql = await import("../session/questlog.js");

  if (argv.includes("--demo")) {
    let log = ql.emptyQuestLog();
    const first = ql.addQuest(log, {
      title: "Escort the merchant caravan",
      giver: "Merchant Guild",
      objectives: ["Meet the caravan at the east gate", "Reach Otari by nightfall"],
      notes: [{ text: "Bandits on the east road.", source: "Guild notice board" }],
      createdAt: "2026-11-20",
    });
    log = first.log;
    const done = ql.completeObjective(log, first.quest.id, first.quest.objectives[0].id);
    log = done.log;
    const second = ql.addQuest(log, {
      title: "Clear the rats from the cellar",
      giver: "Innkeeper",
      objectives: ["Find the nest"],
      createdAt: "2026-11-20",
    });
    log = second.log;
    const failed = ql.failQuest(log, second.quest.id);
    log = failed.log;
    process.stdout.write(
      JSON.stringify({ log, text: ql.summarizePartyQuests(log) }) + "\n",
    );
    return;
  }

  const { FoundryLive } = await import("../live.js");
  const live = await FoundryLive.connect();
  try {
    if (argv.includes("--list")) {
      const { entryId, log } = ql.listQuestsLive(live);
      process.stdout.write(
        JSON.stringify({ entryId, log, text: ql.summarizePartyQuests(log) }) + "\n",
      );
      return;
    }

    if (argv.includes("--show")) {
      const questId = arg("--quest");
      if (!questId) usage();
      const { log } = ql.listQuestsLive(live);
      const quest = ql.getQuest(log, questId);
      if (!quest) throw new ql.QuestLogError(`Unknown quest: ${questId}`);
      process.stdout.write(JSON.stringify({ quest, text: ql.questToText(quest) }) + "\n");
      return;
    }

    if (argv.includes("--add")) {
      const title = arg("--title");
      if (!title) usage();
      const note = arg("--note");
      const source = arg("--source");
      if (note !== undefined && source === undefined) {
        throw new ql.QuestLogError("A note needs --source — who told the party, or what happened.");
      }
      const result = await ql.addQuestLive(live, {
        title,
        giver: arg("--giver"),
        objectives: argAll("--objective"),
        notes: note !== undefined ? [{ text: note, source: source! }] : undefined,
      });
      process.stdout.write(
        JSON.stringify({ quest: result.quest, pageId: result.pageId, entryId: result.entryId }) + "\n",
      );
      return;
    }

    if (argv.includes("--objective")) {
      const questId = arg("--quest");
      if (!questId) usage();
      const addText = arg("--add");
      if (addText !== undefined) {
        const result = await ql.addObjectiveLive(live, questId, addText);
        process.stdout.write(
          JSON.stringify({ quest: result.quest, objective: result.objective }) + "\n",
        );
        return;
      }
      const objectiveId = arg("--objective-id");
      if (!objectiveId) usage();
      const result = await ql.completeObjectiveLive(live, questId, objectiveId);
      process.stdout.write(
        JSON.stringify({ quest: result.quest, alreadyDone: result.alreadyDone }) + "\n",
      );
      return;
    }

    if (argv.includes("--note")) {
      const questId = arg("--quest");
      const text = arg("--text");
      const source = arg("--source");
      if (!questId || !text || !source) usage();
      const result = await ql.addNoteLive(live, questId, text, source);
      process.stdout.write(JSON.stringify({ quest: result.quest }) + "\n");
      return;
    }

    if (argv.includes("--complete")) {
      const questId = arg("--quest");
      if (!questId) usage();
      const result = await ql.completeQuestLive(live, questId);
      process.stdout.write(
        JSON.stringify({ quest: result.quest, alreadyCompleted: result.alreadyCompleted }) + "\n",
      );
      return;
    }

    if (argv.includes("--fail")) {
      const questId = arg("--quest");
      if (!questId) usage();
      const result = await ql.failQuestLive(live, questId);
      process.stdout.write(
        JSON.stringify({ quest: result.quest, alreadyFailed: result.alreadyFailed }) + "\n",
      );
      return;
    }

    usage();
  } finally {
    await live.disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`questlog failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
