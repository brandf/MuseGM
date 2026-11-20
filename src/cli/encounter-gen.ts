export {};
/**
 * encounter-gen CLI — rapid custom encounter generation (FR-11).
 *
 * Usage (each prints one JSON object to stdout):
 *   bun run src/cli/encounter-gen.ts --generate --spec encounter.json
 *       No connection: generate the encounter from a spec file and print it.
 *   bun run src/cli/encounter-gen.ts --demo
 *       No connection: generate the built-in demo encounter (the lich's
 *       honor guard patrol) and print it.
 *   bun run src/cli/encounter-gen.ts --build --spec encounter.json [--scene <id>]
 *       Create the actors, place the tokens in formation, start combat.
 *   bun run src/cli/encounter-gen.ts --actors --spec encounter.json
 *       Create the actors only (no tokens, no combat).
 *
 * Spec file (JSON):
 *   {
 *     "theme": "death",
 *     "partyLevel": 2,
 *     "seed": 7,
 *     "formation": { "type": "wedge", "center": { "x": 800, "y": 800 }, "focus": { "x": 800, "y": 400 } },
 *     "story": { "campaign": "Menace Under Otari", "location": "the Lich's Lair",
 *                "facts": ["Zolgran the kobold boss was slain in the Landing"],
 *                "people": ["the Lich", "Zolgran"] },
 *     "npcs": [
 *       { "name": "Captain Morvain", "role": "leader", "oneLiner": "Swore an oath to the lich after the fall of the old garrison." },
 *       { "name": "Hexer Ondine", "role": "mage" }
 *     ]
 *   }
 *
 * LOG_LEVEL is forced to error before the library import so the vendored
 * client's info logs don't corrupt stdout (see wait.ts).
 */
process.env.LOG_LEVEL ??= "error";
const {
  generateEncounter,
  formatEncounter,
  createCustomActors,
  createCustomEncounter,
} = await import("../session/encounter-gen.js");
import type { EncounterSpec } from "../session/encounter-gen.js";

/** The demo encounter: the lich's honor guard patrol (example data, labeled as such). */
const DEMO_SPEC: EncounterSpec = {
  theme: "death",
  partyLevel: 2,
  seed: 7,
  formation: { type: "wedge", center: { x: 800, y: 800 }, focus: { x: 800, y: 400 } },
  story: {
    campaign: "Menace Under Otari",
    location: "the Lich's Lair",
    facts: [
      "Zolgran the kobold boss was slain in the Landing",
      "The party found the Lich's Lair beneath Otari",
    ],
    people: ["the Lich", "Zolgran"],
  },
  npcs: [
    { name: "Captain Morvain", role: "leader", oneLiner: "Swore an oath to the lich after the fall of the old garrison." },
    { name: "Sergeant Anselm", role: "guard" },
    { name: "Warden Piotr", role: "guard" },
    { name: "Hexer Ondine", role: "mage" },
    { name: "Acolyte Sable", role: "priest" },
    { name: "Brute Garr", role: "brute" },
  ],
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function usage(): never {
  process.stderr.write(
    "usage: bun run src/cli/encounter-gen.ts --generate --spec <file.json> | --demo | --build --spec <file.json> [--scene <id>] | --actors --spec <file.json>\n",
  );
  process.exit(2);
}

async function loadSpec(): Promise<EncounterSpec> {
  const path = arg("--spec");
  if (!path) usage();
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(path as string, "utf-8");
  return JSON.parse(raw) as EncounterSpec;
}

async function main(): Promise<void> {
  if (process.argv.includes("--demo")) {
    const enc = generateEncounter(DEMO_SPEC);
    process.stdout.write(JSON.stringify({ encounter: enc, text: formatEncounter(enc) }) + "\n");
    return;
  }
  if (process.argv.includes("--generate")) {
    const spec = await loadSpec();
    const enc = generateEncounter(spec);
    process.stdout.write(JSON.stringify({ encounter: enc, text: formatEncounter(enc) }) + "\n");
    return;
  }

  const spec = await loadSpec();
  const { FoundryLive } = await import("../live.js");
  const live = await FoundryLive.connect();
  try {
    if (process.argv.includes("--actors")) {
      const enc = generateEncounter(spec);
      const created = await createCustomActors(live, enc);
      process.stdout.write(JSON.stringify({ created, text: formatEncounter(enc) }) + "\n");
      return;
    }
    if (process.argv.includes("--build")) {
      const result = await createCustomEncounter(live, spec, { sceneId: arg("--scene") });
      process.stdout.write(
        JSON.stringify({
          combatId: result.combatId,
          tokens: result.tokens,
          text: formatEncounter(result.encounter),
        }) + "\n",
      );
      return;
    }
    usage();
  } finally {
    await live.disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`encounter-gen failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
