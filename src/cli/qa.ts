export {};
/**
 * qa CLI — player Q&A (P2).
 *
 * Usage (each prints one JSON object to stdout):
 *   bun run src/cli/qa.ts --fixture "what's my ac"
 *       No connection: answer a question about a built-in fixture actor
 *       (Ezren, level 3 wizard) — for testing the parser/answers.
 *   bun run src/cli/qa.ts --actor <id|name> --question "what's my ac"
 *       Live: read the actor's sheet and post the answer to chat.
 *
 * LOG_LEVEL is forced to error before the library import so the vendored
 * client's info logs don't corrupt stdout (see wait.ts).
 */
process.env.LOG_LEVEL ??= "error";
const { answerQuestion } = await import("../session/qa.js");
import type { ActorSheet } from "../session/qa.js";

/** Fixture actor for --fixture: Ezren, level 3 wizard (test data only). */
const FIXTURE_ACTOR: ActorSheet = {
  _id: "fixture-ezren",
  name: "Ezren",
  type: "character",
  system: {
    details: { level: { value: 3 } },
    attributes: {
      ac: { value: 16 },
      hp: { value: 21, max: 28 },
      perception: { value: 7 },
    },
    abilities: {
      str: { mod: 0 },
      dex: { mod: 2 },
      con: { mod: 1 },
      int: { mod: 4 },
      wis: { mod: 1 },
      cha: { mod: 0 },
    },
    saves: {
      fortitude: { value: 5 },
      reflex: { value: 7 },
      will: { value: 8 },
    },
    skills: { stealth: { mod: 5 }, arcana: { mod: 9 } },
    spellcasting: {
      entries: {
        arcane: {
          name: "Arcane",
          slots: {
            slot1: { max: 3, prepared: ["s1", "s2"] },
            slot2: { max: 2, prepared: [] },
          },
        },
      },
    },
  },
  items: [
    { _id: "i1", name: "Healing Potion (lesser)", type: "consumable", system: { quantity: 2 } },
    { _id: "i2", name: "Staff", type: "weapon", system: { quantity: 1 } },
    { _id: "i3", name: "Fireball", type: "spell", system: {} },
    { _id: "i4", name: "Magic Missile", type: "spell", system: {} },
  ],
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function usage(): never {
  process.stderr.write(
    'usage: bun run src/cli/qa.ts --fixture "<question>" | --actor <id|name> --question "<question>"\n',
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const question = arg("--question") ?? arg("--fixture");
  if (!question) usage();

  if (process.argv.includes("--fixture")) {
    const answer = answerQuestion(FIXTURE_ACTOR, question);
    process.stdout.write(JSON.stringify({ answer }) + "\n");
    return;
  }

  const actorRef = arg("--actor");
  if (!actorRef) usage();
  const { FoundryLive } = await import("../live.js");
  const { answerForActor } = await import("../session/qa.js");
  const live = await FoundryLive.connect();
  try {
    let actorId = actorRef;
    const raw = live.raw() as unknown as {
      getRawActor(id: string): { _id: string } | undefined;
    };
    if (!raw.getRawActor(actorRef)) {
      const found = (await live.searchActors(actorRef, { type: "character", limit: 5 })) as {
        actors?: { _id?: string; id?: string; name?: string }[];
      };
      const match = (found.actors ?? []).find(
        (a) => (a.name ?? "").toLowerCase() === actorRef.toLowerCase(),
      );
      if (!match) throw new Error(`Actor "${actorRef}" not found.`);
      actorId = String(match._id ?? match.id ?? "");
    }
    const result = await answerForActor(live, actorId, question);
    process.stdout.write(JSON.stringify(result) + "\n");
  } finally {
    await live.disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`qa failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
