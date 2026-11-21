export {};
/**
 * chronicle CLI — campaign chronicle store (BRA-232).
 *
 * The store lives in Foundry (a "Campaign Chronicle" journal entry) when
 * the table is playing; this CLI works on a store JSON file instead, so
 * every command below runs with no connection and no env. The file
 * format is `serializeChronicle` output — the same JSON the journal
 * flags carry.
 *
 * Usage (each prints one JSON object to stdout):
 *   bun run src/cli/chronicle.ts --demo
 *       No connection: build the demo store (grounded in the Nov 19
 *       session) and print it + the "previously on" recap + the
 *       floor-planner view + the generator facts.
 *   bun run src/cli/chronicle.ts --file <store.json> --list [--kind <kind>]
 *       [--session <s>] [--actor <name>]
 *       Print the entries matching the query (all entries by default).
 *   bun run src/cli/chronicle.ts --file <store.json> --add --kind <kind>
 *       --summary <text> --source <who/what> [--actors <a,b>] [--session <s>]
 *       [--detail <text>] [--role pc|npc] [--ref-id <entry-id>]
 *       Append an entry and write the file back. A missing file starts
 *       a new store. The source is required — the chronicle never gains
 *       unsourced facts (see src/session/chronicle.ts).
 *   bun run src/cli/chronicle.ts --file <store.json> --recap [--session <s>]
 *       [--limit <n>]
 *       Print the "previously on" summary from the store.
 *   bun run src/cli/chronicle.ts --file <store.json> --resolve --thread <entry-id>
 *       --source <who/what> [--summary <text>]
 *       Resolve an open thread (appends a resolution entry).
 *   bun run src/cli/chronicle.ts --file <store.json> --to-floor-plan
 *       Print the floor planner's `Chronicle` view of the store — the
 *       shape `planFloor` already takes, derived, never hand-written.
 *   bun run src/cli/chronicle.ts --file <store.json> --import-recap <recap.json>
 *       Append a session recap's entries (one session entry, one death
 *       entry per kill, one loot entry per loot line) and write the
 *       file back. <recap.json> is the `recap --from-json` output
 *       shape ({recap, text}) or a bare recap object.
 *
 * Args are parsed and --help is handled BEFORE the library import, so
 * `bun run src/cli/chronicle.ts --help` works with no connection and no
 * env. LOG_LEVEL is forced to error before the library import so the
 * vendored client's info logs don't corrupt stdout (see wait.ts).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type {
  ChronicleStore,
  ChronicleKind,
  ChronicleEntry,
  Recap,
} from "../session/chronicle.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const USAGE =
  "usage: bun run src/cli/chronicle.ts --demo | --file <store.json> --list [--kind <k>] [--session <s>] [--actor <a>] | --file <store.json> --add --kind <k> --summary <t> --source <s> [--actors <a,b>] [--session <s>] [--detail <t>] [--role pc|npc] [--ref-id <id>] | --file <store.json> --recap [--session <s>] [--limit <n>] | --file <store.json> --resolve --thread <id> --source <s> [--summary <t>] | --file <store.json> --to-floor-plan | --file <store.json> --import-recap <recap.json>";

function usage(): never {
  process.stderr.write(USAGE + "\n");
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv;
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE + "\n");
    return;
  }

  process.env.LOG_LEVEL ??= "error";
  const ch = await import("../session/chronicle.js");

  if (argv.includes("--demo")) {
    const store = ch.demoChronicle();
    process.stdout.write(
      JSON.stringify({
        store,
        text: ch.renderRecap(store),
        floorPlan: ch.toFloorPlannerChronicle(store),
        facts: ch.chronicleFacts(store),
      }) + "\n",
    );
    return;
  }

  const file = arg("--file");
  if (!file) usage();

  const loadStore = (): ChronicleStore => {
    if (!existsSync(file!)) {
      throw new ch.ChronicleError(
        `No chronicle file at ${file} — run --add to start one, or --demo to see the shape.`,
      );
    }
    return ch.parseChronicle(readFileSync(file!, "utf-8"));
  };
  const saveStore = (store: ChronicleStore): void => {
    writeFileSync(file!, ch.serializeChronicle(store) + "\n", "utf-8");
  };

  if (argv.includes("--list")) {
    const store = loadStore();
    const entries = ch.queryEntries(store, {
      kind: arg("--kind") as ChronicleKind | undefined,
      session: arg("--session"),
      actor: arg("--actor"),
    });
    process.stdout.write(JSON.stringify({ entries, count: entries.length }) + "\n");
    return;
  }

  if (argv.includes("--add")) {
    const kind = arg("--kind");
    const summary = arg("--summary");
    const source = arg("--source");
    if (!kind || !summary || !source) usage();
    const role = arg("--role");
    if (role !== undefined && role !== "pc" && role !== "npc") usage();
    const store = existsSync(file!) ? loadStore() : ch.emptyChronicle();
    const { store: next, entry } = ch.appendEntry(store, {
      kind: kind as ChronicleKind,
      summary,
      source,
      detail: arg("--detail"),
      actors: arg("--actors")?.split(","),
      session: arg("--session"),
      role: role as "pc" | "npc" | undefined,
      refId: arg("--ref-id"),
    });
    saveStore(next);
    process.stdout.write(JSON.stringify({ entry, file }) + "\n");
    return;
  }

  if (argv.includes("--recap")) {
    const store = loadStore();
    const limitRaw = arg("--limit");
    const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) usage();
    process.stdout.write(
      JSON.stringify({
        text: ch.renderRecap(store, { session: arg("--session"), limit }),
      }) + "\n",
    );
    return;
  }

  if (argv.includes("--resolve")) {
    const threadId = arg("--thread");
    const source = arg("--source");
    if (!threadId || !source) usage();
    const store = loadStore();
    const { store: next, entry, alreadyResolved } = ch.resolveThread(
      store,
      threadId,
      arg("--summary") ?? "",
      source,
    );
    if (!alreadyResolved) saveStore(next);
    process.stdout.write(JSON.stringify({ entry, alreadyResolved, file }) + "\n");
    return;
  }

  if (argv.includes("--to-floor-plan")) {
    const store = loadStore();
    process.stdout.write(JSON.stringify(ch.toFloorPlannerChronicle(store)) + "\n");
    return;
  }

  if (argv.includes("--import-recap")) {
    const recapFile = arg("--import-recap");
    if (!recapFile) usage();
    const raw = JSON.parse(readFileSync(recapFile!, "utf-8")) as unknown;
    const recap = (raw as { recap?: unknown }).recap ?? raw;
    if (typeof recap !== "object" || recap === null || Array.isArray(recap)) {
      throw new ch.ChronicleError(`No recap object in ${recapFile}.`);
    }
    const store = existsSync(file!) ? loadStore() : ch.emptyChronicle();
    let next = store;
    const entries: ChronicleEntry[] = [];
    for (const input of ch.recapToChronicleEntries(recap as Recap)) {
      const result = ch.appendEntry(next, input);
      next = result.store;
      entries.push(result.entry);
    }
    saveStore(next);
    process.stdout.write(JSON.stringify({ entries, file }) + "\n");
    return;
  }

  usage();
}

main().catch((err) => {
  process.stderr.write(`chronicle failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
