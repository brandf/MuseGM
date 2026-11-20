/**
 * combat CLI — run the combat autopilot on a live combat.
 *
 *   bun run src/cli/combat.ts status --combat <id>
 *   bun run src/cli/combat.ts next --combat <id>            # advance one turn
 *   bun run src/cli/combat.ts damage --combat <id> --actor <actor-id> --amount <n>
 *   bun run src/cli/combat.ts heal --combat <id> --actor <actor-id> --amount <n>
 *   bun run src/cli/combat.ts condition --combat <id> --combatant <id> --status prone [--rounds 1]
 *   bun run src/cli/combat.ts clear-condition --combat <id> --combatant <id> --status prone
 *   bun run src/cli/combat.ts watch --combat <id> [--seconds 120]
 *
 * Prints JSON describing the resulting state. Turn advances and 0 HP
 * callouts are also posted to Foundry chat.
 *
 * LOG_LEVEL is forced to error before the library import so the vendored
 * client's info logs don't corrupt stdout (see wait.ts).
 */
export {};
process.env.LOG_LEVEL ??= "error";
const { FoundryLive } = await import("../live.js");
const { CombatAutopilot } = await import("../session/autopilot.js");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const cmd = process.argv[2];
const combatId = arg("--combat");

if (!cmd || !combatId) {
  process.stderr.write(
    "usage: bun run src/cli/combat.ts <status|next|damage|heal|condition|watch> --combat <id> [...]\n",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  if (!combatId) throw new Error("--combat <id> is required");
  const live = await FoundryLive.connect();
  try {
    const pilot = new CombatAutopilot(live, combatId);
    let out: unknown;
    switch (cmd) {
      case "status": {
        out = pilot.status();
        break;
      }
      case "next": {
        out = await pilot.advanceTurn();
        break;
      }
      case "damage": {
        const actorId = arg("--actor");
        const amount = Number(arg("--amount") ?? "0");
        if (!actorId) throw new Error("damage needs --actor <id> --amount <n>");
        out = { ...(await pilot.damage(actorId, amount)), actor: actorId };
        break;
      }
      case "heal": {
        const actorId = arg("--actor");
        const amount = Number(arg("--amount") ?? "0");
        if (!actorId) throw new Error("heal needs --actor <id> --amount <n>");
        out = { ...(await pilot.heal(actorId, amount)), actor: actorId };
        break;
      }
      case "condition": {
        const combatantId = arg("--combatant");
        const status = arg("--status");
        const rounds = Number(arg("--rounds") ?? "1");
        if (!combatantId || !status) throw new Error("condition needs --combatant <id> --status <id>");
        const effectId = await pilot.applyCondition(combatantId, status, rounds);
        out = { combatant: combatantId, status, rounds, effectId };
        break;
      }
      case "clear-condition": {
        const combatantId = arg("--combatant");
        const status = arg("--status");
        if (!combatantId || !status) throw new Error("clear-condition needs --combatant <id> --status <id>");
        await pilot.removeCondition(combatantId, status);
        out = { combatant: combatantId, status, cleared: true };
        break;
      }
      case "watch": {
        const seconds = Number(arg("--seconds") ?? "120");
        const ended = await pilot.watchLoop({ maxSeconds: seconds });
        out = { ended };
        break;
      }
      default:
        throw new Error(`unknown command: ${cmd}`);
    }
    process.stdout.write(JSON.stringify(out) + "\n");
  } finally {
    await live.disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`combat failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
