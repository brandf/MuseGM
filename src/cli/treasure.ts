export {};
/**
 * treasure CLI — value-budgeted treasure generation (FR-14) + live layer
 * + art step (BRA-200).
 *
 * Usage (prints one JSON object to stdout):
 *   bun run src/cli/treasure.ts --budget <gp> --level <n> [--seed <n>] [--theme dungeon|gothic|underwater|crypt]
 *       No connection: generate one hoard and print it.
 *   bun run src/cli/treasure.ts --fill --chest <loot-actor-id> --budget <gp> --level <n> [--seed <n>] [--theme ...]
 *       Generate a hoard and fill the chest's loot actor with it. Prints
 *       { hoard, placement, text }; placement.failed names anything that
 *       could not be placed and why — a failed placement is reported,
 *       never silently dropped.
 *   bun run src/cli/treasure.ts --art --hoard <hoard.json> [--art-dir <dir>]
 *       No connection: wire already-generated art files into a hoard
 *       (see src/session/treasure-art.ts). Reads a hoard JSON file — the
 *       { hoard, text } output of the generate mode, or a bare hoard —
 *       and prints { hoard, plan, artReport, text }. Default art dir is
 *       ./treasure-art. The media step itself (generating the square
 *       images from the plan's prompts) runs outside this CLI.
 *
 * LOG_LEVEL is forced to error before the library import so the vendored
 * client's info logs don't corrupt stdout (see wait.ts).
 */
process.env.LOG_LEVEL ??= "error";
import { readFileSync } from "node:fs";
const {
  generateTreasure,
  formatTreasure,
  generateAndFillTreasureChest,
} = await import("../session/treasure.js");
const { planTreasureArt, applyTreasureArt, formatTreasureArtPlan, formatTreasureArtReport } =
  await import("../session/treasure-art.js");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function usage(): never {
  process.stderr.write(
    "usage: bun run src/cli/treasure.ts --budget <gp> --level <n> [--seed <n>] [--theme dungeon|gothic|underwater|crypt] | --fill --chest <actor-id> --budget <gp> --level <n> [--seed <n>] [--theme ...] | --art --hoard <hoard.json> [--art-dir <dir>]\n",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  // Offline art step: wire generated art files into a saved hoard.
  if (process.argv.includes("--art")) {
    const hoardFile = arg("--hoard");
    if (!hoardFile) usage();
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(hoardFile!, "utf-8"));
    } catch (err) {
      process.stderr.write(
        `treasure --art: cannot read hoard file ${hoardFile}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
    const hoard =
      (parsed as { hoard?: unknown }).hoard ?? parsed;
    if (!hoard || typeof hoard !== "object" || !Array.isArray((hoard as { signatureItems?: unknown }).signatureItems)) {
      process.stderr.write(`treasure --art: ${hoardFile} does not contain a hoard\n`);
      process.exit(1);
    }
    const artDir = arg("--art-dir") ?? "treasure-art";
    const plan = planTreasureArt(
      hoard as Parameters<typeof planTreasureArt>[0],
      artDir,
    );
    const result = applyTreasureArt(
      hoard as Parameters<typeof applyTreasureArt>[0],
      artDir,
    );
    process.stdout.write(
      JSON.stringify({
        hoard: result.hoard,
        plan,
        artReport: result.report,
        text: `${formatTreasureArtPlan(plan)}\n${formatTreasureArtReport(result)}`,
      }) + "\n",
    );
    return;
  }

  const budgetArg = arg("--budget");
  if (budgetArg === undefined) usage();
  const budgetGp = Number(budgetArg);
  if (!Number.isFinite(budgetGp) || budgetGp < 1) usage();
  const level = Number(arg("--level") ?? "1");
  const seedArg = arg("--seed");
  const seed = seedArg !== undefined ? Number(seedArg) : undefined;
  const theme = arg("--theme");

  // Live fill: generate a hoard and place it in a chest's loot actor.
  if (process.argv.includes("--fill")) {
    const chest = arg("--chest");
    if (!chest) usage();
    const { FoundryLive } = await import("../live.js");
    const live = await FoundryLive.connect();
    try {
      const { hoard, placement } = await generateAndFillTreasureChest(live, chest, {
        budgetGp,
        level,
        seed,
        theme,
      });
      process.stdout.write(
        JSON.stringify({ hoard, placement, text: formatTreasure(hoard) }) + "\n",
      );
      return;
    } finally {
      await live.disconnect();
    }
  }

  const hoard = generateTreasure({ budgetGp, level, seed, theme });
  process.stdout.write(
    JSON.stringify({ hoard, text: formatTreasure(hoard) }) + "\n",
  );
}

main().catch((err) => {
  process.stderr.write(`treasure failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
