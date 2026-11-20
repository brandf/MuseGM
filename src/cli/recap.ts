export {};
/**
 * recap CLI — session recaps (P2).
 *
 * Usage (each prints one JSON object to stdout):
 *   bun run src/cli/recap.ts --from-json <messages.json>
 *       No connection: build a recap from a JSON file holding an array of
 *       chat messages ({id, author, speaker: {alias}, content, style,
 *       timestamp}) and print the recap text + JSON.
 *   bun run src/cli/recap.ts --post [--limit 200] [--title "Session recap"]
 *       Live: read the recent chat log, build the recap, create a journal
 *       entry, and post a summary to chat.
 *
 * LOG_LEVEL is forced to error before the library import so the vendored
 * client's info logs don't corrupt stdout (see wait.ts).
 */
import * as fs from "node:fs";
process.env.LOG_LEVEL ??= "error";
const { buildRecap, recapToText, postRecap } = await import("../session/recap.js");
import type { ChatMessage } from "../types.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function usage(): never {
  process.stderr.write(
    "usage: bun run src/cli/recap.ts --from-json <messages.json> | --post [--limit <n>] [--title <title>]\n",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const fromJson = arg("--from-json");
  if (fromJson !== undefined) {
    const messages = JSON.parse(fs.readFileSync(fromJson, "utf-8")) as ChatMessage[];
    const recap = buildRecap(messages, { title: arg("--title") });
    process.stdout.write(JSON.stringify({ recap, text: recapToText(recap) }) + "\n");
    return;
  }

  if (process.argv.includes("--post")) {
    const { FoundryLive } = await import("../live.js");
    const live = await FoundryLive.connect();
    try {
      const limit = Number(arg("--limit") ?? "200");
      const { recap, journalId, messageId } = await postRecap(live, {
        title: arg("--title"),
        limit,
      });
      process.stdout.write(JSON.stringify({ recap, journalId, messageId }) + "\n");
    } finally {
      await live.disconnect();
    }
    return;
  }

  usage();
}

main().catch((err) => {
  process.stderr.write(`recap failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
