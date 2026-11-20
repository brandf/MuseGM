export {};
/**
 * treasure CLI — value-budgeted treasure generation (FR-14).
 *
 * Usage (prints one JSON object to stdout):
 *   bun run src/cli/treasure.ts --budget <gp> --level <n> [--seed <n>] [--theme dungeon|gothic|underwater|crypt]
 *       No connection: generate one hoard and print it.
 *
 * LOG_LEVEL is forced to error before the library import so the vendored
 * client's info logs don't corrupt stdout (see wait.ts).
 */
process.env.LOG_LEVEL ??= "error";
const { generateTreasure, formatTreasure } = await import("../session/treasure.js");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function usage(): never {
  process.stderr.write(
    "usage: bun run src/cli/treasure.ts --budget <gp> --level <n> [--seed <n>] [--theme dungeon|gothic|underwater|crypt]\n",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const budgetArg = arg("--budget");
  if (budgetArg === undefined) usage();
  const budgetGp = Number(budgetArg);
  if (!Number.isFinite(budgetGp) || budgetGp < 1) usage();
  const level = Number(arg("--level") ?? "1");
  const seedArg = arg("--seed");
  const seed = seedArg !== undefined ? Number(seedArg) : undefined;
  const theme = arg("--theme");

  const hoard = generateTreasure({ budgetGp, level, seed, theme });
  process.stdout.write(
    JSON.stringify({ hoard, text: formatTreasure(hoard) }) + "\n",
  );
}

main().catch((err) => {
  process.stderr.write(`treasure failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
