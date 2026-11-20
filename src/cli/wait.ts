export {};
/**
 * wait CLI — the blocking tool Muse calls in a loop.
 *
 * Connects to Foundry, then blocks until new chat arrives or the timeout
 * expires. Prints exactly one JSON object to stdout and exits:
 *   {"timedOut": false, "new": [{id, author, speaker, content, timestamp}...], "lastSeen": "<newest id>"}
 *
 * Usage:
 *   bun run src/cli/wait.ts --last-seen <id> [--timeout 120] [--debounce 3]
 *   bun run src/cli/wait.ts --from-now [--timeout 120] [--debounce 3]
 *
 * Wake-up is broadcast-driven (sub-second); a 1s poll is the fallback.
 * Run it in a loop: wait -> answer what arrived -> wait again from the
 * returned lastSeen.
 *
 * The vendored MCP client logs to stdout at info level, which would corrupt
 * the JSON on stdout — so LOG_LEVEL is forced to error before the library
 * is imported (dynamic import: the env var must be set before the client's
 * config module loads).
 */
process.env.LOG_LEVEL ??= "error";
const { FoundryLive } = await import("../live.js");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(name);
}

const lastSeenArg = arg("--last-seen");
const timeout = Number(arg("--timeout") ?? "120");
const debounce = Number(arg("--debounce") ?? "3");

async function main(): Promise<void> {
  const live = await FoundryLive.connect();
  try {
    let lastSeen: string | null = lastSeenArg ?? null;
    if (has("--from-now") || !lastSeen) {
      const recent = live.getChatMessages(1);
      lastSeen = recent.length > 0 ? recent[recent.length - 1].id : null;
    }
    const result = await live.waitForChat({ lastSeen, timeout, debounce });
    const out = {
      timedOut: result.timedOut,
      new: result.newMessages.map((m) => ({
        id: m.id,
        author: m.author,
        speaker: m.speaker,
        content: m.content,
        timestamp: m.timestamp,
      })),
      lastSeen: result.lastSeen,
    };
    process.stdout.write(JSON.stringify(out) + "\n");
  } finally {
    await live.disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`wait failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
