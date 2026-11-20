/**
 * ping CLI — ping the canvas or move the cursor, as seen by other clients.
 *
 *   bun run src/cli/ping.ts --x 500 --y 600 [--scene <id>] [--style pulse|alert|pull|arrow] [--pull]
 *   bun run src/cli/ping.ts --x 500 --y 600 --cursor   # cursor only, no ping
 *
 * Prints JSON {sceneId, x, y, style, pull}. Scene defaults to the active
 * scene. A ping is scene-scoped: only clients viewing that scene see it.
 *
 * LOG_LEVEL is forced to error before the library import so the vendored
 * client's info logs don't corrupt stdout (see wait.ts).
 */
export {};
process.env.LOG_LEVEL ??= "error";
const { FoundryLive: LiveClient } = await import("../live.js");
import type { PingStyle } from "../live.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const live = await LiveClient.connect();
  try {
    const x = Number(arg("--x") ?? "NaN");
    const y = Number(arg("--y") ?? "NaN");
    if (Number.isNaN(x) || Number.isNaN(y)) {
      throw new Error("usage: ping --x <n> --y <n> [--scene <id>] [--style pulse|alert|pull|arrow] [--pull] [--cursor]");
    }
    const sceneId = arg("--scene");
    let out: unknown;
    if (process.argv.includes("--cursor")) {
      out = { cursor: true, ...(await live.moveCursor(x, y, { sceneId })) };
    } else {
      const style = (arg("--style") ?? "pulse") as PingStyle;
      if (!["pulse", "alert", "pull", "arrow"].includes(style)) {
        throw new Error(`Unknown ping style: ${style} (pulse|alert|pull|arrow)`);
      }
      out = await live.ping(x, y, {
        sceneId,
        style,
        pull: process.argv.includes("--pull") ? true : undefined,
      });
    }
    console.log(JSON.stringify(out));
  } finally {
    await live.disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`ping failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
