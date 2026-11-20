export {};
/**
 * floor-plan CLI — high-level floor generation (FR-15), the vague-brief mode.
 *
 * Usage (no connection — pure planning):
 *   bun run src/cli/floor-plan.ts --demo
 *       Plan the canned lich's lair floor, print the convergence-loop
 *       preview, then print the locked plan + build manifest as JSON.
 *   bun run src/cli/floor-plan.ts --validate-only --file <plan.json>
 *       Read a plan file and validate it (exit 1 with the errors).
 *
 * LOG_LEVEL is forced to error before the library import so the vendored
 * client's info logs don't corrupt stdout (see wait.ts).
 */
process.env.LOG_LEVEL ??= "error";
const { planFloor, renderFloorPreview, validateFloorPlan, lockFloorPlan } =
  await import("../session/floor-plan.js");
import type { Chronicle, FloorBrief } from "../session/floor-plan.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function usage(): never {
  process.stderr.write(
    "usage: bun run src/cli/floor-plan.ts --demo | --validate-only --file <plan.json>\n",
  );
  process.exit(2);
}

/** The canned demo: the lich's lair floor, from the real Nov 19 session chronicle. */
const DEMO_BRIEF: FloorBrief = {
  name: "The Lich's Lair — Deep Floor",
  theme: "death",
  partyLevel: 2,
  seed: 7,
  puzzleKind: "pressure-plates",
  puzzleCount: 3,
  riddle: true,
  minorEncounterCount: 2,
  ambush: true,
  boss: { kind: "lich", name: "the Lich" },
  intrigueCount: 2,
  storylineThreads: ["The Lich's plan for Otari", "What the Lich is building in the deep dark"],
  bossTreasureGp: 500,
};

const DEMO_CHRONICLE: Chronicle = {
  campaign: "Menace Under Otari",
  partyMembers: ["Ezren", "Kyra", "Merisiel", "Valeros"],
  keyNpcs: ["the Lich", "Zolgran", "Xulgath"],
  pastEvents: [
    "Merisiel fell to Zolgran's Force Barrage in the Landing",
    "The party found the Lich's Lair beneath Otari",
    "Valeros joined the party in the Entry Hall",
  ],
  openThreads: [
    "The Lich's plan for Otari",
    "What the Lich is building in the deep dark",
  ],
  notableDeaths: ["Merisiel"],
};

async function main(): Promise<void> {
  if (process.argv.includes("--demo")) {
    const plan = planFloor(DEMO_BRIEF, DEMO_CHRONICLE);
    const preview = renderFloorPreview(plan);
    const locked = lockFloorPlan(plan);
    process.stdout.write(preview + "\n\n");
    process.stdout.write(JSON.stringify({ plan: locked.plan, manifest: locked.manifest }) + "\n");
    return;
  }
  if (process.argv.includes("--validate-only")) {
    const file = arg("--file");
    if (!file) usage();
    const plan = JSON.parse(await Bun.file(file!).text());
    const errors = validateFloorPlan(plan);
    if (errors.length > 0) {
      process.stderr.write(`floor plan invalid:\n${errors.map((e) => `• ${e}`).join("\n")}\n`);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({ ok: true, plan: plan.name }) + "\n");
    return;
  }
  usage();
}

main().catch((err) => {
  process.stderr.write(`floor-plan failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
