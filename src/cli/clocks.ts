export {};
/**
 * clocks CLI — visible countdown/progress clocks on the table (BRA-228).
 *
 * Usage (each prints one JSON object to stdout, except --list which
 * prints the rendered clocks then the JSON):
 *   bun run src/cli/clocks.ts --demo
 *       No connection: two clocks (a deadline and a pursuit), ticked
 *       through combat rounds 1–6, rendered + the fired events.
 *   bun run src/cli/clocks.ts --list [--state <file>]
 *       No connection: list the clocks in the state file, rendered.
 *   bun run src/cli/clocks.ts --start --name <name> --segments <N>
 *       [--consequence <text>] [--source <s>] [--state <file>]
 *       Live: start a clock, save the state file, announce it in chat.
 *   bun run src/cli/clocks.ts --tick --clock <id-or-name> [--by <N>]
 *       [--source <s>] [--state <file>]
 *       Live: tick a clock, save, announce the new line (and the
 *       fired line when the tick fills it).
 *   bun run src/cli/clocks.ts --fill --clock <id-or-name> --to <N>
 *       [--source <s>] [--state <file>]
 *       Live: fill a clock to an absolute count, save, announce.
 *   bun run src/cli/clocks.ts --resolve --clock <id-or-name>
 *       [--source <s>] [--state <file>]
 *       Live: resolve a fired clock (its consequence was delivered).
 *   bun run src/cli/clocks.ts --reset --clock <id-or-name>
 *       [--source <s>] [--state <file>]
 *       Live: wind a clock back to 0, running.
 *   bun run src/cli/clocks.ts --drop --clock <id-or-name>
 *       [--source <s>] [--state <file>]
 *       Live: drop a clock.
 *   bun run src/cli/clocks.ts --show --clock <id-or-name>
 *       [--state <file>]
 *       No connection: print one clock, rendered + JSON.
 *   bun run src/cli/clocks.ts --watch [--state <file>]
 *       Live: poll the combat state every 2s; each new combat round
 *       ticks every running clock once and announces the lines.
 *       Stops when no running clock remains, or on Ctrl-C.
 *
 * Args are parsed and --help is handled BEFORE the library import, so
 * `bun run src/cli/clocks.ts --help` works with no connection and no
 * env. LOG_LEVEL is forced to error before the library import so the
 * vendored client's info logs don't corrupt stdout (see wait.ts).
 */

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

const USAGE =
  "usage: bun run src/cli/clocks.ts --demo | --list [--state <f>] | --show --clock <id> [--state <f>] | --start --name <n> --segments <N> [--consequence <c>] [--source <s>] [--state <f>] | --tick --clock <id> [--by <N>] [--source <s>] [--state <f>] | --fill --clock <id> --to <N> [--source <s>] [--state <f>] | --resolve|--reset|--drop --clock <id> [--source <s>] [--state <f>] | --watch [--state <f>]";

function usage(): never {
  process.stderr.write(USAGE + "\n");
  process.exit(2);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const argv = process.argv;
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE + "\n");
    return;
  }

  process.env.LOG_LEVEL ??= "error";
  const cl = await import("../session/clocks.js");

  const statePath = arg("--state");
  const load = (): ReturnType<typeof cl.emptyClockStore> =>
    cl.loadClockState(statePath ?? cl.defaultClockStatePath()) ??
    cl.emptyClockStore();
  const save = (store: ReturnType<typeof cl.emptyClockStore>): void =>
    cl.saveClockState(store, statePath ?? cl.defaultClockStatePath());

  if (argv.includes("--demo")) {
    let store = cl.emptyClockStore();
    const deadline = cl.createClock(store, {
      name: "the train leaves",
      total: 6,
      consequence: "The train pulls out — the heist window closes.",
      source: "demo",
      round: 1,
    });
    store = deadline.store;
    const pursuit = cl.createClock(store, {
      name: "the pursuit",
      total: 4,
      consequence: "The guards arrive in force.",
      source: "demo",
      round: 1,
    });
    store = pursuit.store;
    const lines: string[] = [cl.renderClockStore(store)];
    const fired: string[] = [];
    for (let round = 1; round <= 6; round++) {
      const advanced = cl.advanceClocksToRound(store, {
        combatId: "demo-combat",
        round,
        source: `combat round ${round}`,
      });
      store = advanced.store;
      for (const ev of advanced.events) {
        lines.push(cl.renderClock(ev.clock));
        if (ev.fired) fired.push(cl.renderClock(ev.clock));
      }
    }
    process.stdout.write(
      JSON.stringify(
        {
          clocks: store.clocks.map((c: { id: string; name: string; total: number; filled: number; status: string }) => ({
            id: c.id,
            name: c.name,
            total: c.total,
            filled: c.filled,
            status: c.status,
          })),
          lines,
          fired,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  if (argv.includes("--list")) {
    const store = load();
    process.stdout.write(
      JSON.stringify(
        { rendered: cl.renderClockStore(store), clocks: store.clocks },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  if (argv.includes("--show")) {
    const target = arg("--clock");
    if (!target) usage();
    const store = load();
    const clock = cl.resolveClockTarget(store, target);
    process.stdout.write(
      JSON.stringify({ rendered: cl.renderClock(clock), clock }, null, 2) + "\n",
    );
    return;
  }

  // Everything below is live: it connects and announces in chat.
  const { FoundryLive } = await import("../live.js");
  const live = await FoundryLive.connect();
  const source = arg("--source") ?? "clocks CLI";

  const announce = async (line: string): Promise<void> => {
    await cl.announceClockLive(live, line);
  };

  if (argv.includes("--start")) {
    const name = arg("--name");
    const segments = argInt("--segments");
    if (!name || segments === undefined) usage();
    let store = load();
    const created = cl.createClock(store, {
      name,
      total: segments,
      consequence: arg("--consequence"),
      source,
    });
    store = created.store;
    save(store);
    const line = `🕐 Clock started — ${cl.renderClock(created.clock)}`;
    await announce(line);
    process.stdout.write(
      JSON.stringify({ clock: created.clock, line }, null, 2) + "\n",
    );
    return;
  }

  if (argv.includes("--watch")) {
    let store = load();
    let stopped = false;
    process.on("SIGINT", () => {
      stopped = true;
    });
    let announcedWaiting = false;
    process.stdout.write("watching combat rounds for clocks…\n");
    while (!stopped) {
      const combat = cl.readCombatRound(live);
      if (combat === null) {
        if (!announcedWaiting) {
          process.stdout.write("no active combat — waiting for one…\n");
          announcedWaiting = true;
        }
        await sleep(2000);
        continue;
      }
      announcedWaiting = false;
      const advanced = cl.advanceClocksToRound(store, {
        combatId: combat.combatId,
        round: combat.round,
        source: `combat round ${combat.round}`,
      });
      if (advanced.events.length > 0) {
        store = advanced.store;
        save(store);
        for (const ev of advanced.events) {
          const line = cl.renderClock(ev.clock);
          process.stdout.write(line + "\n");
          await announce(line);
        }
      } else if (advanced.store !== store) {
        // The cursor moved (a new combat started) without ticking
        // anything — persist it so a restart does not re-tick.
        store = advanced.store;
        save(store);
      }
      if (store.clocks.filter((c: { status: string }) => c.status === "running").length === 0) {
        process.stdout.write("no running clocks remain — stopping.\n");
        break;
      }
      await sleep(2000);
    }
    process.stdout.write(
      JSON.stringify({ clocks: store.clocks, stopped }, null, 2) + "\n",
    );
    return;
  }

  const target = arg("--clock");
  if (!target) usage();

  if (argv.includes("--tick")) {
    const by = argInt("--by");
    let store = load();
    const ticked = cl.tickClock(store, target, {
      ...(by !== undefined ? { by } : {}),
      source,
    });
    store = ticked.store;
    save(store);
    const line = cl.renderClock(ticked.clock);
    await announce(line);
    process.stdout.write(
      JSON.stringify({ clock: ticked.clock, fired: ticked.fired, line }, null, 2) + "\n",
    );
    return;
  }

  if (argv.includes("--fill")) {
    const to = argInt("--to");
    if (to === undefined) usage();
    let store = load();
    const filled = cl.fillClock(store, target, { to, source });
    store = filled.store;
    save(store);
    const line = cl.renderClock(filled.clock);
    await announce(line);
    process.stdout.write(
      JSON.stringify({ clock: filled.clock, fired: filled.fired, line }, null, 2) + "\n",
    );
    return;
  }

  if (argv.includes("--resolve")) {
    let store = load();
    const resolved = cl.resolveClock(store, target, { source });
    store = resolved.store;
    save(store);
    const line = cl.renderClock(resolved.clock);
    await announce(line);
    process.stdout.write(JSON.stringify({ clock: resolved.clock, line }, null, 2) + "\n");
    return;
  }

  if (argv.includes("--reset")) {
    let store = load();
    const reset = cl.resetClock(store, target, { source });
    store = reset.store;
    save(store);
    const line = cl.renderClock(reset.clock);
    await announce(line);
    process.stdout.write(JSON.stringify({ clock: reset.clock, line }, null, 2) + "\n");
    return;
  }

  if (argv.includes("--drop")) {
    let store = load();
    const dropped = cl.dropClock(store, target, { source });
    store = dropped.store;
    save(store);
    const line = cl.renderClock(dropped.clock);
    await announce(line);
    process.stdout.write(JSON.stringify({ clock: dropped.clock, line }, null, 2) + "\n");
    return;
  }

  usage();
}

main().catch((err: unknown) => {
  process.stderr.write(`clocks: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
