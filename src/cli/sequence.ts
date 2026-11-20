/**
 * sequence CLI — run a timed action sequence from a JSON file, or the demo.
 *
 *   bun run src/cli/sequence.ts --file seq.json
 *   bun run src/cli/sequence.ts demo        # Otari demo: place → move → pause → roll → ping → delete
 *
 * A sequence file is a JSON array of steps, e.g.:
 *   [
 *     { "kind": "place", "sceneId": "Otari", "actor": "Kobold Warrior", "x": 200, "y": 200, "name": "Demo Kobold" },
 *     { "kind": "move", "sceneId": "Otari", "token": "Demo Kobold", "x": 800, "y": 200, "speed": 300 },
 *     { "kind": "pause", "ms": 1000 },
 *     { "kind": "roll", "formula": "1d20+5", "flavor": "Demo Kobold attacks" },
 *     { "kind": "ping", "x": 800, "y": 200, "sceneId": "Otari" },
 *     { "kind": "deleteToken", "sceneId": "Otari", "token": "Demo Kobold" }
 *   ]
 *
 * Step kinds: place, deleteToken, move, pause, chat, roll, damage, heal,
 * effect, ping, cursor, waitChat. Prints the per-step result log as JSON.
 * Stops on the first failed step unless the file sets "continueOnError"
 * via --continue-on-error.
 *
 * LOG_LEVEL is forced to error before the library import so the vendored
 * client's info logs don't corrupt stdout (see wait.ts).
 */
export {};
process.env.LOG_LEVEL ??= "error";
import * as fs from "node:fs";
const { FoundryLive: LiveClient } = await import("../live.js");
const { runSequence } = await import("../session/sequence.js");
import type { SequenceStep } from "../session/sequence.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const DEMO_STEPS: SequenceStep[] = [
  { kind: "place", sceneId: "Otari", actor: "Kobold Warrior", x: 200, y: 200, name: "Demo Kobold (sequence)" },
  { kind: "move", sceneId: "Otari", token: "Demo Kobold (sequence)", x: 800, y: 200, speed: 300 },
  { kind: "pause", ms: 1000 },
  { kind: "roll", formula: "1d20+5", flavor: "Demo Kobold attacks" },
  { kind: "ping", x: 800, y: 200, sceneId: "Otari", style: "pulse" },
  { kind: "deleteToken", sceneId: "Otari", token: "Demo Kobold (sequence)" },
];

async function main(): Promise<void> {
  const live = await LiveClient.connect();
  try {
    let steps: SequenceStep[];
    if (process.argv[2] === "demo") {
      steps = DEMO_STEPS;
    } else {
      const file = arg("--file");
      if (!file) throw new Error("usage: sequence --file seq.json | sequence demo");
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (!Array.isArray(parsed)) throw new Error("Sequence file must be a JSON array of steps.");
      steps = parsed as SequenceStep[];
    }
    const result = await runSequence(live, steps, {
      continueOnError: process.argv.includes("--continue-on-error"),
      runKey: arg("--run-key"),
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {
    await live.disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`sequence failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
