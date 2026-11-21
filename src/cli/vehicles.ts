export {};
/**
 * vehicles CLI — moving vehicles (BRA-235).
 *
 * Usage (each prints one JSON object to stdout, except --list which
 * prints the rendered vehicles then the JSON):
 *   bun run src/cli/vehicles.ts --demo
 *       No connection: the Iron Horse (locomotive, tender, three
 *       cars) on its route, advanced rounds 1–6 — the trestle-bridge
 *       deadline fires on round 3, the train arrives on round 5.
 *   bun run src/cli/vehicles.ts --list [--state <file>]
 *       No connection: list the vehicles in the state file, rendered.
 *   bun run src/cli/vehicles.ts --show --vehicle <id-or-name> [--state <file>]
 *       No connection: print one vehicle, rendered + JSON.
 *   bun run src/cli/vehicles.ts --start --spec <file> [--state <file>] [--source <s>]
 *       Live: read a vehicle spec (JSON — the createVehicle input:
 *       name, kind, route, speedCellsPerRound, cars, ...), start it,
 *       save the state file, announce it in chat.
 *   bun run src/cli/vehicles.ts --advance --vehicle <id-or-name> [--rounds <N>]
 *       [--source <s>] [--state <file>]
 *       Live: advance the vehicle, move every shifted token, save,
 *       announce deadline/arrival lines.
 *   bun run src/cli/vehicles.ts --board --vehicle <id-or-name> --token <id>
 *       --car <carId> [--offset <N>] [--lateral <N>] [--name <n>]
 *       [--source <s>] [--state <file>]
 *       Live: board a token (snaps it to its seat), save, announce.
 *   bun run src/cli/vehicles.ts --leave --vehicle <id-or-name> --token <id>
 *       [--source <s>] [--state <file>]
 *       Live: a rider steps off (stays where it is), save, announce.
 *   bun run src/cli/vehicles.ts --alongside-add --vehicle <id-or-name>
 *       --token <id> --lateral <N> [--behind <N>] [--name <n>]
 *       [--source <s>] [--state <file>]
 *       Live: an escort joins alongside, save, announce.
 *   bun run src/cli/vehicles.ts --alongside-remove --vehicle <id-or-name>
 *       --token <id> [--source <s>] [--state <file>]
 *       Live: an escort leaves, save, announce.
 *   bun run src/cli/vehicles.ts --stop|--resume --vehicle <id-or-name>
 *       [--source <s>] [--state <file>]
 *       Live: halt / resume a vehicle, save, announce.
 *   bun run src/cli/vehicles.ts --set-speed --vehicle <id-or-name>
 *       --speed <N> [--source <s>] [--state <file>]
 *       Live: change the speed, save, announce.
 *   bun run src/cli/vehicles.ts --watch [--state <file>]
 *       Live: poll the combat state every 2s; each new combat round
 *       advances every running vehicle once and announces the lines.
 *       Stops when no running vehicle remains, or on Ctrl-C.
 *
 * Args are parsed and --help is handled BEFORE the library import, so
 * `bun run src/cli/vehicles.ts --help` works with no connection and no
 * env. LOG_LEVEL is forced to error before the library import so the
 * vendored client's info logs don't corrupt stdout (see wait.ts).
 */

import * as fs from "node:fs";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function argInt(name: string): number | undefined {
  const v = arg(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
}

function argNum(name: string): number | undefined {
  const v = arg(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

const USAGE =
  "usage: bun run src/cli/vehicles.ts --demo | --list [--state <f>] | --show --vehicle <id> [--state <f>] | --start --spec <file> [--state <f>] [--source <s>] | --advance --vehicle <id> [--rounds <N>] [--source <s>] [--state <f>] | --board --vehicle <id> --token <id> --car <carId> [--offset <N>] [--lateral <N>] [--name <n>] [--source <s>] [--state <f>] | --leave --vehicle <id> --token <id> [--source <s>] [--state <f>] | --alongside-add --vehicle <id> --token <id> --lateral <N> [--behind <N>] [--name <n>] [--source <s>] [--state <f>] | --alongside-remove --vehicle <id> --token <id> [--source <s>] [--state <f>] | --stop|--resume --vehicle <id> [--source <s>] [--state <f>] | --set-speed --vehicle <id> --speed <N> [--source <s>] [--state <f>] | --watch [--state <f>]";

function usage(): never {
  process.stderr.write(USAGE + "\n");
  process.exit(2);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The demo train: locomotive, tender, three cars — the Great Train Robbery. */
function demoVehicleSpec(): Record<string, unknown> {
  return {
    name: "The Iron Horse",
    kind: "train",
    route: [
      { x: 0, y: 10 },
      { x: 18, y: 10 },
      { x: 26, y: 14 },
      { x: 26, y: 24 },
    ],
    speedCellsPerRound: 4,
    gapCells: 0.5,
    cars: [
      { id: "locomotive", name: "Locomotive", lengthCells: 3 },
      { id: "tender", name: "Tender", lengthCells: 2 },
      { id: "boxcar", name: "Boxcar", lengthCells: 4 },
      { id: "flatcar", name: "Flatcar", lengthCells: 4 },
      { id: "caboose", name: "Caboose", lengthCells: 3 },
    ],
    deadline: {
      name: "the trestle bridge",
      atDistance: 30,
      consequence: "The trestle bridge is ahead — the heist window is closing.",
    },
    tokenId: "iron-horse-loco",
    sceneId: "demo-scene",
    riders: [
      { tokenId: "valeros", name: "Valeros", carId: "boxcar", offsetCells: 1, lateralCells: 0 },
      { tokenId: "kyra", name: "Kyra", carId: "caboose", offsetCells: 1, lateralCells: 0 },
    ],
    alongside: [
      { tokenId: "merisiel", name: "Merisiel", behindCells: 2, lateralCells: -3 },
      { tokenId: "ezren", name: "Ezren", behindCells: 6, lateralCells: 3 },
    ],
    source: "demo",
  };
}

async function main(): Promise<void> {
  const argv = process.argv;
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE + "\n");
    return;
  }

  process.env.LOG_LEVEL ??= "error";
  const vh = await import("../session/vehicles.js");

  const statePath = arg("--state");
  const load = (): ReturnType<typeof vh.emptyVehicleStore> =>
    vh.loadVehicleState(statePath ?? vh.defaultVehicleStatePath()) ??
    vh.emptyVehicleStore();
  const save = (store: ReturnType<typeof vh.emptyVehicleStore>): void =>
    vh.saveVehicleState(store, statePath ?? vh.defaultVehicleStatePath());

  if (argv.includes("--demo")) {
    let vehicle = vh.createVehicle(
      demoVehicleSpec() as unknown as Parameters<typeof vh.createVehicle>[0],
    );
    const lines: string[] = [vh.renderVehicle(vehicle)];
    const fired: string[] = [];
    const rounds: { round: number; moved: number; events: unknown; positions: unknown }[] = [];
    for (let round = 1; round <= 6; round++) {
      const advanced = vh.advanceVehicle(vehicle, { rounds: 1, source: `combat round ${round}` });
      vehicle = advanced.vehicle;
      lines.push(vh.renderVehicle(vehicle));
      for (const event of advanced.events) {
        const line = vh.advanceEventLine(vehicle, event);
        if (line) fired.push(line);
      }
      rounds.push({
        round,
        moved: advanced.movedCells,
        events: advanced.events,
        positions: vh.vehicleTokenPositions(vehicle),
      });
    }
    process.stdout.write(
      JSON.stringify({ vehicle, lines, fired, rounds }, null, 2) + "\n",
    );
    return;
  }

  if (argv.includes("--list")) {
    const store = load();
    process.stdout.write(
      JSON.stringify(
        { rendered: vh.renderVehicleStore(store), vehicles: store.vehicles },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  if (argv.includes("--show")) {
    const target = arg("--vehicle");
    if (!target) usage();
    const store = load();
    const vehicle = vh.resolveVehicleTarget(store, target);
    process.stdout.write(
      JSON.stringify({ rendered: vh.renderVehicle(vehicle), vehicle }, null, 2) + "\n",
    );
    return;
  }

  // Everything below is live: it connects and announces in chat.
  const { FoundryLive } = await import("../live.js");
  const live = await FoundryLive.connect();
  const source = arg("--source") ?? "vehicles CLI";

  if (argv.includes("--start")) {
    const specPath = arg("--spec");
    if (!specPath) usage();
    let spec: Record<string, unknown>;
    try {
      spec = JSON.parse(fs.readFileSync(specPath, "utf-8")) as Record<string, unknown>;
    } catch (e) {
      process.stderr.write(`Cannot read vehicle spec ${specPath}: ${(e as Error).message}\n`);
      process.exit(2);
    }
    if (spec.source === undefined) spec.source = source;
    const vehicle = vh.createVehicle(
      spec as unknown as Parameters<typeof vh.createVehicle>[0],
    );
    let store = load();
    store = vh.addVehicle(store, vehicle);
    save(store);
    const line = `🚂 Vehicle started — ${vh.renderVehicle(vehicle)}`;
    await live.sendChat(line);
    process.stdout.write(
      JSON.stringify({ vehicle, line }, null, 2) + "\n",
    );
    return;
  }

  if (argv.includes("--watch")) {
    const clocks = await import("../session/clocks.js");
    let store = load();
    let stopped = false;
    process.on("SIGINT", () => {
      stopped = true;
    });
    let announcedWaiting = false;
    let lastCombatId = "";
    let lastRound = 0;
    process.stdout.write("watching combat rounds for vehicles…\n");
    while (!stopped) {
      const combat = clocks.readCombatRound(live);
      if (combat === null) {
        if (!announcedWaiting) {
          process.stdout.write("no active combat — waiting for one…\n");
          announcedWaiting = true;
        }
        await sleep(2000);
        continue;
      }
      announcedWaiting = false;
      const isNewRound = combat.combatId !== lastCombatId || combat.round !== lastRound;
      if (isNewRound) {
        // A new combat resets the round tracking (rounds restart at 1).
        lastCombatId = combat.combatId;
        lastRound = combat.round;
        const roundSource = `combat round ${combat.round}`;
        for (const vehicle of store.vehicles.filter((v: { status: string }) => v.status === "running")) {
          const advanced = await vh.advanceVehicleLive(live, vehicle, {
            rounds: 1,
            source: roundSource,
          });
          store = vh.updateVehicle(store, advanced.vehicle);
          save(store);
          for (const line of advanced.lines) {
            process.stdout.write(line + "\n");
          }
          process.stdout.write(vh.renderVehicle(advanced.vehicle) + "\n");
        }
      }
      if (store.vehicles.filter((v: { status: string }) => v.status === "running").length === 0) {
        process.stdout.write("no running vehicles remain — stopping.\n");
        break;
      }
      await sleep(2000);
    }
    process.stdout.write(
      JSON.stringify({ vehicles: store.vehicles, stopped }, null, 2) + "\n",
    );
    return;
  }

  const target = arg("--vehicle");
  if (!target) usage();

  if (argv.includes("--advance")) {
    const rounds = argInt("--rounds") ?? 1;
    let store = load();
    const vehicle = vh.resolveVehicleTarget(store, target);
    const advanced = await vh.advanceVehicleLive(live, vehicle, { rounds, source });
    store = vh.updateVehicle(store, advanced.vehicle);
    save(store);
    process.stdout.write(
      JSON.stringify(
        {
          vehicle: advanced.vehicle,
          movedCells: advanced.movedCells,
          events: advanced.events,
          movedTokens: advanced.movedTokens,
          lines: advanced.lines,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  if (argv.includes("--board")) {
    const tokenId = arg("--token");
    const carId = arg("--car");
    if (!tokenId || !carId) usage();
    let store = load();
    const vehicle = vh.resolveVehicleTarget(store, target);
    const boarded = await vh.boardVehicleLive(live, vehicle, {
      tokenId,
      ...(arg("--name") !== undefined ? { name: arg("--name") as string } : {}),
      carId,
      ...(argNum("--offset") !== undefined ? { offsetCells: argNum("--offset") as number } : {}),
      ...(argNum("--lateral") !== undefined ? { lateralCells: argNum("--lateral") as number } : {}),
      source,
    });
    store = vh.updateVehicle(store, boarded.vehicle);
    save(store);
    process.stdout.write(
      JSON.stringify({ vehicle: boarded.vehicle, rider: boarded.rider, movedTo: boarded.movedTo, line: boarded.line }, null, 2) + "\n",
    );
    return;
  }

  if (argv.includes("--leave")) {
    const tokenId = arg("--token");
    if (!tokenId) usage();
    let store = load();
    const vehicle = vh.resolveVehicleTarget(store, target);
    const left = await vh.leaveVehicleLive(live, vehicle, { tokenId, source });
    store = vh.updateVehicle(store, left.vehicle);
    save(store);
    process.stdout.write(
      JSON.stringify({ vehicle: left.vehicle, rider: left.rider, line: left.line }, null, 2) + "\n",
    );
    return;
  }

  if (argv.includes("--alongside-add")) {
    const tokenId = arg("--token");
    const lateral = argNum("--lateral");
    if (!tokenId || lateral === undefined) usage();
    let store = load();
    const vehicle = vh.resolveVehicleTarget(store, target);
    const next = vh.addAlongside(vehicle, {
      tokenId,
      ...(arg("--name") !== undefined ? { name: arg("--name") as string } : {}),
      ...(argNum("--behind") !== undefined ? { behindCells: argNum("--behind") as number } : {}),
      lateralCells: lateral,
      source,
    });
    store = vh.updateVehicle(store, next);
    save(store);
    const line = `🚂 ${arg("--name") ?? tokenId} joins the escort alongside ${next.name}.`;
    await live.sendChat(line);
    process.stdout.write(
      JSON.stringify({ vehicle: next, line }, null, 2) + "\n",
    );
    return;
  }

  if (argv.includes("--alongside-remove")) {
    const tokenId = arg("--token");
    if (!tokenId) usage();
    let store = load();
    const vehicle = vh.resolveVehicleTarget(store, target);
    const next = vh.removeAlongside(vehicle, { tokenId, source });
    store = vh.updateVehicle(store, next);
    save(store);
    const line = `🚂 ${tokenId} leaves the escort alongside ${next.name}.`;
    await live.sendChat(line);
    process.stdout.write(
      JSON.stringify({ vehicle: next, line }, null, 2) + "\n",
    );
    return;
  }

  if (argv.includes("--stop")) {
    let store = load();
    const vehicle = vh.resolveVehicleTarget(store, target);
    const next = vh.stopVehicle(vehicle, { source });
    store = vh.updateVehicle(store, next);
    save(store);
    const line = `🚂 ${next.name} stops at ${next.distance} cells.`;
    await live.sendChat(line);
    process.stdout.write(
      JSON.stringify({ vehicle: next, line }, null, 2) + "\n",
    );
    return;
  }

  if (argv.includes("--resume")) {
    let store = load();
    const vehicle = vh.resolveVehicleTarget(store, target);
    const next = vh.resumeVehicle(vehicle, { source });
    store = vh.updateVehicle(store, next);
    save(store);
    const line = `🚂 ${next.name} resumes at ${next.speedCellsPerRound} cells/round.`;
    await live.sendChat(line);
    process.stdout.write(
      JSON.stringify({ vehicle: next, line }, null, 2) + "\n",
    );
    return;
  }

  if (argv.includes("--set-speed")) {
    const speed = argNum("--speed");
    if (speed === undefined) usage();
    let store = load();
    const vehicle = vh.resolveVehicleTarget(store, target);
    const next = vh.setSpeed(vehicle, { speed, source });
    store = vh.updateVehicle(store, next);
    save(store);
    const line = `🚂 ${next.name} now runs at ${next.speedCellsPerRound} cells/round.`;
    await live.sendChat(line);
    process.stdout.write(
      JSON.stringify({ vehicle: next, line }, null, 2) + "\n",
    );
    return;
  }

  usage();
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
