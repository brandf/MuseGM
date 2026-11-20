export {};
/**
 * dice CLI — dice on demand (P1.5).
 *
 * Usage (each prints one JSON object to stdout):
 *   bun run src/cli/dice.ts --parse "roll 1d20+5 for Ezren"
 *       No connection: just parse a chat message into a roll request
 *       (or null when it isn't one). The monitor uses this to decide
 *       whether a message is a roll request.
 *   bun run src/cli/dice.ts --roll "1d20+5" [--flavor Perception] [--actor Ezren]
 *       Roll and post the visible result to chat.
 *   bun run src/cli/dice.ts --roll "1d20+3" --secret [--flavor "kobold save"]
 *       Secret GM roll: result whispered to the GM, chat gets only a
 *       "rolls behind the screen" line.
 *   bun run src/cli/dice.ts --group "1d20+2" [--flavor Perception] [--actors id1,id2]
 *       Group check: one roll per player character (or per --actors id),
 *       summary posted to chat.
 *
 * LOG_LEVEL is forced to error before the library import so the vendored
 * client's info logs don't corrupt stdout (see wait.ts).
 */
process.env.LOG_LEVEL ??= "error";
// Only the pure parser is imported up front: importing live.js pulls in
// the vendored MCP client, which validates FOUNDRY_URL at import time —
// and --parse must work with no connection at all (the monitor uses it
// to decide whether a message is a roll request).
const { parseRollRequest, postVisibleRoll, rollForChat, secretRoll, groupCheck } = await import("../session/dice.js");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function usage(): never {
  process.stderr.write(
    "usage: bun run src/cli/dice.ts --parse \"<chat text>\" | --roll \"<formula>\" [--flavor ...] [--actor ...] [--secret] | --group \"<formula>\" [--flavor ...] [--actors id1,id2]\n",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const parseText = arg("--parse");
  if (parseText !== undefined) {
    process.stdout.write(JSON.stringify({ request: parseRollRequest(parseText) }) + "\n");
    return;
  }

  const roll = arg("--roll");
  const group = arg("--group");
  if (!roll && !group) usage();

  const flavor = arg("--flavor");
  const { FoundryLive } = await import("../live.js");
  const live = await FoundryLive.connect();
  try {
    if (group) {
      const actors = arg("--actors");
      const { messageId, entries } = await groupCheck(live, group, {
        flavor,
        actorIds: actors ? actors.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      });
      process.stdout.write(JSON.stringify({ messageId, entries }) + "\n");
      return;
    }
    if (has("--secret")) {
      const { gmMessageId, publicMessageId, total } = await secretRoll(live, roll!, {
        flavor,
        actorName: arg("--actor"),
      });
      process.stdout.write(JSON.stringify({ gmMessageId, publicMessageId, total }) + "\n");
      return;
    }
    // Plain roll, or a full chat request ("roll 1d20+5 for Ezren").
    const messageId = roll!.trim().toLowerCase().startsWith("roll")
      ? await rollForChat(live, roll!)
      : await (async () => {
          const result = await live.rollDice(roll!, { flavor });
          return postVisibleRoll(live, result, { flavor, actorName: arg("--actor") });
        })();
    process.stdout.write(JSON.stringify({ messageId }) + "\n");
  } finally {
    await live.disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`dice failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
