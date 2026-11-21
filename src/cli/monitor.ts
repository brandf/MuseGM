export {};
/**
 * monitor CLI — the first-class monitor loop: `bun run monitor`.
 *
 * Runs the wait → answer → wait loop the Nov 19 subagent monitor was
 * doing by hand: waits for Foundry chat, answers roll requests and
 * data questions from live world state, handles Meroki Pins, announces
 * combat turn changes, and loops until stopped.
 *
 * What it answers, and what it does NOT:
 * - Dice (roll requests in chat), questions it can answer from data
 *   (turn / round / HP / AC / initiative / scene), pins, turn
 *   announcements. See src/session/monitor.ts for the rules — the
 *   monitor never invents stats or rolls.
 * - A GM whisper to Meroki is an instruction, not chatter: an embedded
 *   cutscene script or a named sequence ("mice and the ogre") is
 *   validated and played; a whispered build or question is answered
 *   back as a whisper. Anything else gets a whispered clarification.
 * - Session modes (BRA-233): one session carries a mode — hands-on
 *   (FR-1), co-design (FR-15), improvise (FR-18) — set at startup
 *   with --mode or switched mid-session in one chat message from the
 *   GM ("let's go hands-on on this room" / "take the brief from
 *   here"). The mode persists across restarts; the build state
 *   survives a switch untouched.
 * - Open chat / requests / roleplay are logged as "needs-agent" on
 *   stderr and skipped. A human Muse can answer those from the log.
 *
 * Usage:
 *   bun run src/cli/monitor.ts [--alias Meroki] [--debounce 3]
 *                              [--timeout 30] [--once] [--dry-run]
 *                              [--pack <manifest.json>] [--server-base <path>]
 *                              [--mode <hands-on|co-design|improvise>]
 *
 * Logs are JSON lines on stderr ({event, ...}); --once prints a summary
 * JSON object on stdout and exits. Ctrl-C stops the loop cleanly
 * (disconnects, prints the shutdown summary, exits 0).
 *
 * Arg parsing and --help run BEFORE the library import: importing
 * live.js validates FOUNDRY_URL at import time (see dice.ts), so --help
 * must work with no connection and no env vars. LOG_LEVEL is forced to
 * error before the import so the vendored client's info logs don't
 * corrupt stdout (see wait.ts).
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(name);
}

if (has("--help") || has("-h")) {
  process.stdout.write(
    `usage: bun run src/cli/monitor.ts [--alias Meroki] [--debounce 3] [--timeout 30] [--once] [--dry-run] [--pack <manifest.json>] [--server-base <path>] [--mode <hands-on|co-design|improvise>]\n` +
      `\n` +
      `  --alias <name>   display name in chat (default Meroki)\n` +
      `  --debounce <s>   burst-merge window per wait cycle (default 3)\n` +
      `  --timeout <s>    seconds per wait cycle; also bounds Ctrl-C latency (default 30)\n` +
      `  --once           run one wait cycle + pin drain + combat check, print a summary, exit\n` +
      `  --dry-run        classify + log, but post nothing and change nothing\n` +
      `  --pack <path>    tile-pack manifest for the build loop (default tiles/manifest.json)\n` +
      `  --server-base <path>  server folder the pack was uploaded to (default worlds/<world>)\n` +
      `  --mode <mode>    starting session mode: hands-on (FR-1, tile by tile),\n` +
      `                   co-design (FR-15, floor briefs), improvise (FR-18, mid-session\n` +
      `                   sequences). Persists across restarts; the GM can switch it\n` +
      `                   mid-session in one chat message ("take the brief from here").\n` +
      `\n` +
      `The monitor starts from the newest chat message (it never re-answers\n` +
      `history) and picks up open Meroki Pins dropped while it was offline.\n` +
      `Build requests in chat ("build an 8x6 room", "add a door", "undo\n` +
      `that") route to the build loop; ambiguous ones get a clarifying\n` +
      `question in chat, out-of-scope ones get "I can't do that yet".\n` +
      `A GM whisper to Meroki is an instruction: paste a cutscene script\n` +
      `or name a sequence ("mice and the ogre") and it plays; a whispered\n` +
      `build or question is answered back as a whisper to the GM.\n`,
  );
  process.exit(0);
}

process.env.LOG_LEVEL ??= "error";
const modeArg = arg("--mode");
if (
  modeArg !== undefined &&
  modeArg !== "hands-on" &&
  modeArg !== "co-design" &&
  modeArg !== "improvise"
) {
  process.stderr.write(
    `monitor: --mode must be hands-on, co-design, or improvise (got ${JSON.stringify(modeArg)})\n`,
  );
  process.exit(2);
}
const { FoundryLive } = await import("../live.js");
const { runMonitor } = await import("../session/monitor.js");

async function main(): Promise<void> {
  const alias = arg("--alias") ?? "Meroki";
  const debounce = Number(arg("--debounce") ?? "3");
  const timeout = Number(arg("--timeout") ?? "30");
  const once = has("--once");
  const dryRun = has("--dry-run");
  const packPath = arg("--pack");
  const serverBase = arg("--server-base");
  const mode = modeArg as "hands-on" | "co-design" | "improvise" | undefined;

  const live = await FoundryLive.connect();
  let stopping = false;
  const onSignal = (): void => {
    stopping = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const summary = await runMonitor(live, {
      alias,
      debounce,
      timeout,
      dryRun,
      once,
      packPath,
      serverBase,
      mode,
      shouldStop: () => stopping,
    });
    if (once) {
      process.stdout.write(JSON.stringify(summary) + "\n");
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await live.disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`monitor failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
