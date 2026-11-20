/**
 * encounter CLI — build (or clean up) a combat encounter live.
 *
 * Build:
 *   bun run src/cli/encounter.ts --monsters "Kobold Warrior x2, Kobold Scout" [--scene <id>] [--origin 900,700] [--encounter-key <key>]
 *   -> {"sceneId","sceneName","combatId","tokens":[{tokenId,combatantId,actorId,name,x,y,hp,hpMax,initiative,initiativeMod}],"order":[...]}
 *   With --encounter-key, a re-run resumes the same encounter instead of
 *   building a second one (same tokens, same combat, same initiative).
 *
 * Clean up a demo encounter (ends combat, deletes its tokens):
 *   bun run src/cli/encounter.ts --cleanup --combat <id> --tokens <id1,id2> --scene <id>
 *   -> {"cleaned":true}
 *
 * LOG_LEVEL is forced to error before the library import so the vendored
 * client's info logs don't corrupt stdout (see wait.ts).
 */
export {};
process.env.LOG_LEVEL ??= "error";
const { FoundryLive } = await import("../live.js");
const { buildEncounter, clearEncounter } = await import("../session/encounter.js");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(name);
}

function parseMonsters(spec: string): { name: string; count?: number }[] {
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/^(.+?)\s*x(\d+)$/i);
      return m ? { name: m[1].trim(), count: Number(m[2]) } : { name: s };
    });
}

async function main(): Promise<void> {
  const live = await FoundryLive.connect();
  try {
    if (has("--cleanup")) {
      const combatId = arg("--combat");
      const tokens = (arg("--tokens") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const sceneId = arg("--scene");
      if (!sceneId || tokens.length === 0) {
        throw new Error("--cleanup needs --scene <id> and --tokens <id1,id2> (plus --combat <id> when a combat is running).");
      }
      await clearEncounter(live, { combatId, tokenIds: tokens, sceneId });
      process.stdout.write(JSON.stringify({ cleaned: true }) + "\n");
      return;
    }
    const spec = arg("--monsters");
    if (!spec) throw new Error('usage: --monsters "Kobold Warrior x2, Kobold Scout"');
    const originArg = arg("--origin");
    const origin = originArg
      ? { x: Number(originArg.split(",")[0]), y: Number(originArg.split(",")[1]) }
      : undefined;
    const result = await buildEncounter(live, parseMonsters(spec), {
      sceneId: arg("--scene"),
      origin,
      encounterKey: arg("--encounter-key"),
    });
    process.stdout.write(JSON.stringify(result) + "\n");
  } finally {
    await live.disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`encounter failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
