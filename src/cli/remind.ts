export {};
/**
 * remind CLI — turn reminders (P2).
 *
 * Usage (each prints one JSON object to stdout):
 *   bun run src/cli/remind.ts --demo
 *       No connection: print a reminder built from fixture combat data.
 *   bun run src/cli/remind.ts --combat <combat-id>
 *       Live: post the reminder for the current turn (whispered to the
 *       owning player when one can be found, public otherwise).
 *
 * LOG_LEVEL is forced to error before the library import so the vendored
 * client's info logs don't corrupt stdout (see wait.ts).
 */
process.env.LOG_LEVEL ??= "error";
const { buildTurnReminder, remindTurn } = await import("../session/reminders.js");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function usage(): never {
  process.stderr.write(
    "usage: bun run src/cli/remind.ts --demo | --combat <combat-id>\n",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  if (process.argv.includes("--demo")) {
    const text = buildTurnReminder({
      name: "Merisiel",
      round: 2,
      turn: 3,
      total: 5,
      hp: 11,
      hpMax: 25,
      isEnemy: false,
      conditions: [{ statusId: "Frightened 1", expiresRound: 3 }],
    });
    process.stdout.write(JSON.stringify({ text }) + "\n");
    return;
  }

  const combatId = arg("--combat");
  if (!combatId) usage();
  const { FoundryLive } = await import("../live.js");
  const { CombatAutopilot } = await import("../session/autopilot.js");
  const live = await FoundryLive.connect();
  try {
    const autopilot = new CombatAutopilot(live, combatId);
    const result = await remindTurn(live, autopilot);
    process.stdout.write(JSON.stringify(result) + "\n");
  } finally {
    await live.disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`remind failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
