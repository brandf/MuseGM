export {};
/**
 * loot CLI — loot pipeline (P2).
 *
 * Usage (each prints one JSON object to stdout):
 *   bun run src/cli/loot.ts --generate --level 3 [--tier poor|standard|rich] [--seed 7]
 *       No connection: generate one hoard and print it (coins + items).
 *   bun run src/cli/loot.ts --fill --chest <loot-actor-id> --level 3 [--tier ...] [--seed ...]
 *       Generate a hoard and fill the chest's loot actor with it.
 *   bun run src/cli/loot.ts --open --chest <loot-actor-id> --character <actor-id> [--name Ezren]
 *       Move everything from the chest onto the character's sheet.
 *
 * LOG_LEVEL is forced to error before the library import so the vendored
 * client's info logs don't corrupt stdout (see wait.ts).
 */
process.env.LOG_LEVEL ??= "error";
const { generateLoot, formatLoot, fillChest, openChest, generateAndFillChest } =
  await import("../session/loot.js");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function usage(): never {
  process.stderr.write(
    "usage: bun run src/cli/loot.ts --generate --level <n> [--tier poor|standard|rich] [--seed <n>] | --fill --chest <actor-id> --level <n> [--tier ...] [--seed ...] | --open --chest <actor-id> --character <actor-id> [--name <name>]\n",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const level = Number(arg("--level") ?? "1");
  const tier = (arg("--tier") ?? "standard") as "poor" | "standard" | "rich";
  const seedArg = arg("--seed");
  const seed = seedArg !== undefined ? Number(seedArg) : undefined;

  if (process.argv.includes("--generate")) {
    const loot = generateLoot({ level, tier, seed });
    process.stdout.write(
      JSON.stringify({ loot, text: formatLoot(loot) }) + "\n",
    );
    return;
  }

  const chest = arg("--chest");
  if (!chest) usage();
  const { FoundryLive } = await import("../live.js");
  const live = await FoundryLive.connect();
  try {
    if (process.argv.includes("--fill")) {
      const { loot, itemIds } = await generateAndFillChest(live, chest, { level, tier, seed });
      process.stdout.write(
        JSON.stringify({ loot, itemIds, text: formatLoot(loot) }) + "\n",
      );
      return;
    }
    if (process.argv.includes("--open")) {
      const character = arg("--character");
      if (!character) usage();
      const moved = await openChest(live, chest, character, arg("--name"));
      process.stdout.write(JSON.stringify({ moved }) + "\n");
      return;
    }
    usage();
  } finally {
    await live.disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`loot failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
