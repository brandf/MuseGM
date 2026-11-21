export {};
/**
 * rules CLI — real rule lookup (BRA-205). The MCP `lookup_rule` is a
 * stub; this searches the installed compendium packs (index from the
 * `world` payload, full documents over the socket) and the world's
 * journals, and returns the answer WITH its citations.
 *
 * Usage (each prints one JSON object to stdout):
 *   bun run src/cli/rules.ts --demo
 *       No connection: run three canned questions over the demo fixture
 *       corpus (labels say FIXTURE — illustrative text, not book data)
 *       and print the answers.
 *   bun run src/cli/rules.ts --demo "<question>"
 *       No connection: run one question over the demo fixture corpus.
 *   bun run src/cli/rules.ts --ask "<question>" [--limit N] [--fetch-docs N]
 *       Live: search the installed packs + journals and print the
 *       answer with citations. `--fetch-docs` caps how many top index
 *       candidates get their full document read (default 5).
 *
 * An answer with no source says so: when nothing matches, the result
 * is "not found in the installed books" with the closest matches, never
 * a made-up ruling.
 *
 * LOG_LEVEL is forced to error before the library import so the vendored
 * client's info logs don't corrupt stdout (see wait.ts).
 */
process.env.LOG_LEVEL ??= "error";
const { demoLookup, lookupRuleLive } = await import("../session/rules.js");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function usage(): never {
  process.stderr.write(
    "usage: bun run src/cli/rules.ts --demo [\"<question>\"] | --ask \"<question>\" [--limit N] [--fetch-docs N]\n",
  );
  process.exit(2);
}

const DEMO_QUESTIONS = [
  "What does flat-footed do?",
  "How many actions does it take to reload a crossbow?",
  "How do I ride a dragon to the moon?",
];

async function main(): Promise<void> {
  if (has("--demo")) {
    const question = arg("--demo");
    if (question !== undefined) {
      process.stdout.write(
        JSON.stringify({ demo: true, ...demoLookup(question) }) + "\n",
      );
      return;
    }
    const answers = DEMO_QUESTIONS.map((q) => demoLookup(q));
    process.stdout.write(JSON.stringify({ demo: true, answers }) + "\n");
    return;
  }
  const question = arg("--ask");
  if (question === undefined) usage();
  const limit = arg("--limit");
  const fetchDocs = arg("--fetch-docs");
  const { FoundryLive } = await import("../live.js");
  const live = await FoundryLive.connect();
  try {
    const answer = await lookupRuleLive(live, question, {
      limit: limit ? Number(limit) : undefined,
      fetchDocs: fetchDocs ? Number(fetchDocs) : undefined,
    });
    process.stdout.write(JSON.stringify(answer) + "\n");
  } finally {
    await live.disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`rules failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
