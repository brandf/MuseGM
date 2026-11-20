/**
 * dressing CLI — interactive dressing generator (FR-16).
 *
 * Usage (prints one JSON object to stdout):
 *   bun run src/cli/dressing.ts --demo [--seed <n>]
 *       No connection: the canned 8x6 Entry Hall (2 doors, 2 tables).
 *   bun run src/cli/dressing.ts --spec <room-spec.json> [--room <name>] [--seed <n>] [--spacing <n>] [--candles <n>] [--tables <json>]
 *       No connection: plan the dressing for a RoomSpec JSON file.
 *
 * LOG_LEVEL is forced to error before the library import so the vendored
 * client's info logs don't corrupt stdout (see wait.ts).
 */
import * as fs from "node:fs";

process.env.LOG_LEVEL ??= "error";
const { planDressing, formatDressingPlan, validateDressingPlan } = await import(
  "../session/dressing.js"
);
import type { RoomSpec } from "../worldbuilding/tiles-layout.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function usage(): never {
  process.stderr.write(
    "usage: bun run src/cli/dressing.ts --demo [--seed <n>]\n" +
      "   or: bun run src/cli/dressing.ts --spec <room-spec.json> [--room <name>] [--seed <n>] [--spacing <n>] [--candles <n>] [--tables '[{\"gx\":1,\"gy\":1}]']\n",
  );
  process.exit(2);
}

/** The canned demo room: 8x6 Entry Hall, a door north and south, two tables. */
function demoRoom(name: string): RoomSpec {
  return {
    name,
    gridW: 8,
    gridH: 6,
    seed: 1,
    doors: [
      { wall: "north", at: 4 },
      { wall: "south", at: 3 },
    ],
  };
}

async function main(): Promise<void> {
  const seedArg = arg("--seed");
  const seed = seedArg !== undefined ? Number(seedArg) : undefined;
  if (seed !== undefined && (!Number.isInteger(seed) || seed < 0)) usage();
  const spacingArg = arg("--spacing");
  const spacing = spacingArg !== undefined ? Number(spacingArg) : undefined;
  if (spacing !== undefined && (!Number.isInteger(spacing) || spacing < 1)) usage();
  const candlesArg = arg("--candles");
  const candleCount = candlesArg !== undefined ? Number(candlesArg) : undefined;
  if (candleCount !== undefined && (!Number.isInteger(candleCount) || candleCount < 0)) usage();
  const tablesArg = arg("--tables");
  let tables: { gx: number; gy: number }[] | undefined;
  if (tablesArg !== undefined) {
    try {
      tables = JSON.parse(tablesArg) as { gx: number; gy: number }[];
    } catch {
      usage();
    }
  }

  let room: RoomSpec;
  if (has("--demo")) {
    room = demoRoom(arg("--room") ?? "Entry Hall");
    tables = [
      { gx: 3, gy: 2 },
      { gx: 5, gy: 3 },
    ];
  } else {
    const specPath = arg("--spec");
    if (specPath === undefined) usage();
    try {
      room = JSON.parse(fs.readFileSync(specPath, "utf8")) as RoomSpec;
    } catch (err) {
      process.stderr.write(
        `dressing failed: cannot read spec ${specPath}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
    const name = arg("--room");
    if (name !== undefined) room = { ...room, name };
  }

  const plan = planDressing(room, { seed, spacing, tables, candleCount });
  const errors = validateDressingPlan(plan, room);
  if (errors.length > 0) {
    process.stderr.write(`dressing failed: plan invalid:\n${errors.map((e) => `  - ${e}`).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write(
    JSON.stringify({ plan, summary: formatDressingPlan(plan) }) + "\n",
  );
}

main().catch((err) => {
  process.stderr.write(`dressing failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
