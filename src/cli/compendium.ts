export {};
/**
 * compendium CLI — search pack indexes and import pack documents.
 *
 * Usage (each prints one JSON object to stdout):
 *   bun run src/cli/compendium.ts --dracolich
 *       No connection: print the homebrew Dracolich draft actor JSON
 *       (every number in it is a draft, not book data).
 *   bun run src/cli/compendium.ts --list-packs
 *       List every pack in the world (id, label, type, entry count).
 *   bun run src/cli/compendium.ts --search "lich" [--type Actor] [--pack <id>] [--limit 20]
 *       Search the pack indexes by name (already in memory from connect).
 *   bun run src/cli/compendium.ts --get <packId> <docId> [--type Actor]
 *       Read one full document from a pack (modifyDocument "get").
 *       NEEDS LIVE CONFIRMATION on 14.370 — see docs/compendium-import.md.
 *   bun run src/cli/compendium.ts --import <packId> <docId> [--name <new>] [--keep-id]
 *       Import one pack Actor as a world actor (Actor create + Item creates).
 *
 * LOG_LEVEL is forced to error before the library import so the vendored
 * client's info logs don't corrupt stdout (see wait.ts).
 */
process.env.LOG_LEVEL ??= "error";
const {
  DRACOLICH_DRAFT,
  getPackDocument,
  getWorldPacks,
  importPackActor,
  listPacks,
  searchPackIndex,
} = await import("../session/compendium.js");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function usage(): never {
  process.stderr.write(
    "usage: bun run src/cli/compendium.ts --dracolich | --list-packs | --search \"<name>\" [--type Actor] [--pack <id>] [--limit N] | --get <packId> <docId> [--type Actor] | --import <packId> <docId> [--name <new>] [--keep-id]\n",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  // No connection needed: the homebrew draft.
  if (has("--dracolich")) {
    process.stdout.write(
      JSON.stringify({
        note: "HOMEBREW DRAFT — every number is chosen, not book data. Recommended path is import-the-Lich + applyDracolichPatch; see docs/compendium-import.md. Level warning: the party is level 1-2; a level 12 Dracolich is a story device, not a fight.",
        actor: DRACOLICH_DRAFT,
      }) + "\n",
    );
    return;
  }

  const { FoundryLive } = await import("../live.js");
  const live = await FoundryLive.connect();
  try {
    if (has("--list-packs")) {
      const packs = listPacks(getWorldPacks(live));
      process.stdout.write(JSON.stringify({ count: packs.length, packs }) + "\n");
      return;
    }
    const search = arg("--search");
    if (search !== undefined) {
      const limit = arg("--limit");
      const hits = searchPackIndex(getWorldPacks(live), search, {
        type: arg("--type"),
        packId: arg("--pack"),
        limit: limit ? Number(limit) : undefined,
      });
      process.stdout.write(JSON.stringify({ count: hits.length, hits }) + "\n");
      return;
    }
    const getPack = arg("--get");
    if (getPack !== undefined) {
      const docId = process.argv[process.argv.indexOf("--get") + 2];
      if (!docId) usage();
      const doc = await getPackDocument(live, arg("--type") ?? "Actor", getPack, docId);
      process.stdout.write(JSON.stringify({ pack: getPack, docId, doc }) + "\n");
      return;
    }
    const importPack = arg("--import");
    if (importPack !== undefined) {
      const docId = process.argv[process.argv.indexOf("--import") + 2];
      if (!docId) usage();
      const result = await importPackActor(live, importPack, docId, {
        name: arg("--name"),
        keepId: has("--keep-id"),
      });
      process.stdout.write(JSON.stringify(result) + "\n");
      return;
    }
    usage();
  } finally {
    await live.disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`compendium failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
