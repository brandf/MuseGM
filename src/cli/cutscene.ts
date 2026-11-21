/**
 * cutscene CLI — validate, stage, and play a cutscene script (FR-5, BRA-231).
 *
 *   bun run src/cli/cutscene.ts --file examples/ambush.json [--validate-only] [--run-key <key>] [--continue-on-error]
 *   bun run src/cli/cutscene.ts --file examples/mice-ogre.json --stage --world world.json [--out beat.json]
 *   bun run src/cli/cutscene.ts --fire beat.json [--run-key <key>] [--continue-on-error]
 *   bun run src/cli/cutscene.ts --snapshot-world world.json
 *
 * --validate-only checks the script (schema + formation math) with no
 * connection at all — importing live.js validates FOUNDRY_URL at import
 * time, so it is lazily imported only when actually playing. Prints the
 * play result (per-step log) as JSON. Stops on the first failed step
 * unless --continue-on-error is given.
 *
 * --stage is the GM approval gate (BRA-231): the script is validated
 * and every reference it needs is resolved against the world snapshot
 * in --world (actors, scenes, tokens, lights, tiles, walls) — without
 * playing anything. The staged beat prints as JSON (or to --out), with
 * a GM preview and any warnings; a staging failure lists every problem
 * and exits 1. Nothing is posted, moved, or changed.
 *
 * --fire plays a staged beat file (from --stage): the beat's hash is
 * checked first — a script edited after staging refuses to fire.
 *
 * --snapshot-world connects and dumps the current world as a snapshot
 * JSON for --stage (actors, scenes, tokens, lights, tiles, walls,
 * combat). No script plays.
 *
 * LOG_LEVEL is forced to error before the library import so the vendored
 * client's info logs don't corrupt stdout (see wait.ts).
 */
export {};
process.env.LOG_LEVEL ??= "error";
import * as fs from "node:fs";

const USAGE = [
  "usage: cutscene --file script.json [--validate-only] [--run-key <key>] [--continue-on-error]",
  "       cutscene --file script.json --stage --world world.json [--out beat.json]",
  "       cutscene --fire beat.json [--run-key <key>] [--continue-on-error]",
  "       cutscene --snapshot-world world.json",
  "       cutscene --help",
  "",
  "--validate-only  check the script (schema + formation math), no connection",
  "--stage          stage the script against a world snapshot: validate + resolve",
  "                 every reference, play nothing; prints the staged beat as JSON",
  "--world <file>   world snapshot JSON for --stage (see --snapshot-world)",
  "--out <file>     write the staged beat to a file instead of stdout",
  "--fire <file>    play a staged beat file (hash-checked; edited beats refuse)",
  "--snapshot-world <file>  dump the live world as a snapshot JSON for --stage",
  "--run-key <key>  idempotency key for the whole run",
  "--continue-on-error  keep going after a failed step instead of stopping",
].join("\n");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(USAGE);
    return;
  }

  const snapshotWorldFile = arg("--snapshot-world");
  if (snapshotWorldFile) {
    const { FoundryLive: LiveClient } = await import("../live.js");
    const { snapshotWorld } = await import("../session/staging.js");
    const live = await LiveClient.connect();
    try {
      const snapshot = await snapshotWorld(live);
      fs.writeFileSync(snapshotWorldFile, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
      console.log(JSON.stringify({
        ok: true,
        file: snapshotWorldFile,
        actors: snapshot.actors.length,
        scenes: snapshot.scenes.length,
        combat: snapshot.combat ?? null,
      }, null, 2));
    } finally {
      await live.disconnect();
    }
    return;
  }

  const fireFile = arg("--fire");
  if (fireFile) {
    const beat: unknown = JSON.parse(fs.readFileSync(fireFile, "utf-8"));
    const { parseStagedBeat, playStagedCutscene } = await import("../session/staging.js");
    const parsed = parseStagedBeat(beat);
    const { FoundryLive: LiveClient } = await import("../live.js");
    const live = await LiveClient.connect();
    try {
      const result = await playStagedCutscene(live, parsed, {
        continueOnError: process.argv.includes("--continue-on-error"),
        runKey: arg("--run-key"),
      });
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    } finally {
      await live.disconnect();
    }
    return;
  }

  const file = arg("--file");
  if (!file) {
    throw new Error(`usage: cutscene --file script.json [--validate-only] [--run-key <key>] [--continue-on-error]\n${USAGE}`);
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));

  if (process.argv.includes("--stage")) {
    const worldFile = arg("--world");
    if (!worldFile) {
      throw new Error("--stage needs --world <snapshot.json> (dump one with --snapshot-world).");
    }
    const world: unknown = JSON.parse(fs.readFileSync(worldFile, "utf-8"));
    const { stageCutscene } = await import("../session/staging.js");
    const staged = stageCutscene(parsed, world as never);
    if (!staged.ok) {
      process.stderr.write(`cutscene cannot stage:\n- ${staged.errors.join("\n- ")}\n`);
      process.exit(1);
    }
    const out = arg("--out");
    const json = JSON.stringify(staged.beat, null, 2);
    if (out) {
      fs.writeFileSync(out, `${json}\n`, "utf-8");
      console.log(JSON.stringify({
        ok: true,
        staged: staged.beat.id,
        name: staged.beat.name,
        file: out,
        expandedSteps: staged.beat.expandedSteps.length,
        warnings: staged.beat.warnings,
        preview: staged.beat.preview,
      }, null, 2));
    } else {
      console.log(json);
    }
    return;
  }

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
