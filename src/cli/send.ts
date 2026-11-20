export {};
/**
 * send CLI — post one message to Foundry chat.
 *
 * Usage:
 *   bun run src/cli/send.ts --content "..." [--alias Meroki] [--style 1]
 *
 * Prints {"id": "<created message _id>"} to stdout.
 *
 * LOG_LEVEL is forced to error before the library import so the vendored
 * client's info logs don't corrupt stdout (see wait.ts).
 */
process.env.LOG_LEVEL ??= "error";
const { FoundryLive } = await import("../live.js");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const content = arg("--content");
  if (!content) {
    process.stderr.write("usage: bun run src/cli/send.ts --content \"...\" [--alias Meroki] [--style 1]\n");
    process.exit(2);
  }
  const alias = arg("--alias");
  const style = arg("--style");
  const live = await FoundryLive.connect();
  try {
    const id = await live.sendChat(content, {
      alias: alias ?? "Meroki",
      style: style !== undefined ? Number(style) : 1,
    });
    process.stdout.write(JSON.stringify({ id }) + "\n");
  } finally {
    await live.disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`send failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
