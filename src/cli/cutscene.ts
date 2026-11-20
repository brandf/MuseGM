/**
 * cutscene CLI — validate and play a cutscene script (FR-5).
 *
 *   bun run src/cli/cutscene.ts --file examples/ambush.json [--validate-only] [--run-key <key>] [--continue-on-error]
 *
 * --validate-only checks the script (schema + formation math) with no
 * connection at all — importing live.js validates FOUNDRY_URL at import
 * time, so it is lazily imported only when actually playing. Prints the
 * play result (per-step log) as JSON. Stops on the first failed step
 * unless --continue-on-error is given.
 *
 * LOG_LEVEL is forced to error before the library import so the vendored
 * client's info logs don't corrupt stdout (see wait.ts).
 */
export {};
process.env.LOG_LEVEL ??= "error";
import * as fs from "node:fs";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const file = arg("--file");
  if (!file) {
    throw new Error("usage: cutscene --file script.json [--validate-only] [--run-key <key>] [--continue-on-error]");
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
  const { validateCutscene, expandCutscene } = await import("../session/cutscene.js");
  const validated = validateCutscene(parsed);
  if (!validated.ok) {
    process.stderr.write(`cutscene invalid:\n- ${validated.errors.join("\n- ")}\n`);
    process.exit(1);
  }
  const expanded = expandCutscene(validated.script);
  if (process.argv.includes("--validate-only")) {
    console.log(JSON.stringify({
      ok: true,
      name: validated.script.name,
      steps: validated.script.steps.length,
      expandedSteps: expanded.length,
      kinds: expanded.map((s) => s.kind),
    }, null, 2));
    return;
  }
  const { FoundryLive: LiveClient } = await import("../live.js");
  const { playCutscene } = await import("../session/cutscene.js");
  const live = await LiveClient.connect();
  try {
    const result = await playCutscene(live, parsed, {
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
  process.stderr.write(`cutscene failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
