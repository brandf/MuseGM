/**
 * Encounter-gen tests — rapid custom encounter generation (FR-11).
 * Pure generation only; no Foundry connection.
 */
import { describe, it, expect } from "bun:test";
import {
  generateEncounter,
  formatEncounter,
  scaleStats,
  pickSpells,
  pickWeapon,
  pickSignature,
  livingKit,
  buildBackstory,
  formationPositions,
  NPC_ROLES,
} from "../src/session/encounter-gen.js";
import { angleToEast } from "../src/session/formations.js";
import type { EncounterSpec, NpcRole, StoryContext } from "../src/session/encounter-gen.js";
import { rngFromSeed } from "../src/session/loot.js";

const STORY: StoryContext = {
  campaign: "Menace Under Otari",
  location: "the Lich's Lair",
  facts: [
    "Zolgran the kobold boss was slain in the Landing",
    "The party found the Lich's Lair beneath Otari",
  ],
  people: ["the Lich", "Zolgran"],
};

/** Names that appear NOWHERE in the story context — a backstory must never contain them. */
const DECOYS = ["Vharg", "Kestrel", "Mirella", "the Ashen Court"];

function baseSpec(overrides: Partial<EncounterSpec> = {}): EncounterSpec {
  return {
    npcs: [
      { name: "Captain Morvain", role: "leader" },
      { name: "Sergeant Anselm", role: "guard" },
      { name: "Hexer Ondine", role: "mage" },
      { name: "Acolyte Sable", role: "priest" },
      { name: "Brute Garr", role: "brute" },
      { name: "Slink", role: "rogue" },
    ],
    formation: { type: "ring", center: { x: 800, y: 800 } },
    theme: "death",
    partyLevel: 2,
    story: STORY,
    seed: 7,
    ...overrides,
  };
}

describe("templates and scaling", () => {
  it("scales HP and attack with level", () => {
    const l1 = scaleStats("guard", 1);
    const l5 = scaleStats("guard", 5);
    expect(l1.hp).toBe(12);
    expect(l5.hp).toBe(12 + 9 * 4);
    expect(l5.attackBonus).toBeGreaterThan(l1.attackBonus);
    expect(l5.ac).toBeGreaterThanOrEqual(l1.ac);
  });

  it("generates every role", () => {
    for (const role of NPC_ROLES) {
      const enc = generateEncounter(baseSpec({ npcs: [{ name: `Test ${role}`, role }] }));
      expect(enc.npcs).toHaveLength(1);
      expect(enc.npcs[0].hp).toBeGreaterThan(0);
      expect(enc.npcs[0].ac).toBeGreaterThan(0);
    }
  });

  it("is deterministic for a given spec + seed", () => {
    const a = generateEncounter(baseSpec());
    const b = generateEncounter(baseSpec());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = generateEncounter(baseSpec({ seed: 8 }));
    expect(JSON.stringify(c)).not.toBe(JSON.stringify(a));
  });
});

describe("gear and spells", () => {
  it("death-theme mage spells all come from the death list", () => {
    const deathSpells = ["Chill Touch", "Grim Tendrils", "Harm", "Vampiric Feast", "Enervation", "Animate Dead", "Death Knell", "Spectral Hand"];
    const rng = rngFromSeed(7);
    const spells = pickSpells("mage", "death", rng);
    expect(spells).toHaveLength(3);
    for (const s of spells) expect(deathSpells).toContain(s);
    expect(new Set(spells).size).toBe(3);
  });

  it("non-casters get no spells", () => {
    const rng = rngFromSeed(7);
    expect(pickSpells("guard", "death", rng)).toEqual([]);
    expect(pickSpells("brute", "death", rng)).toEqual([]);
    expect(pickSpells("rogue", "death", rng)).toEqual([]);
  });

  it("death-theme weapons carry the grave-touched flavor", () => {
    const rng = rngFromSeed(7);
    const w = pickWeapon("guard", "death", rng);
    expect(w.name.startsWith("grave-touched ")).toBe(true);
    const base = w.name.replace("grave-touched ", "");
    expect(["Longsword", "Spear", "Warhammer"]).toContain(base);
  });

  it("generic theme weapons have no flavor prefix", () => {
    const rng = rngFromSeed(7);
    const w = pickWeapon("guard", "generic", rng);
    expect(["Longsword", "Spear", "Warhammer"]).toContain(w.name);
  });
});

describe("living kit (rule 1)", () => {
  it("every NPC carries the full living kit plus one personal item", () => {
    const enc = generateEncounter(baseSpec());
    const kitNames = ["Rations (1 day)", "Waterskin", "Bedroll", "Rope (50 ft.)", "Torches (2)", "Whetstone"];
    for (const npc of enc.npcs) {
      const names = npc.livingKit.map((i) => i.name);
      for (const required of kitNames) expect(names).toContain(required);
      const personal = npc.livingKit.filter((i) => i.story !== undefined);
      expect(personal).toHaveLength(1);
      expect(personal[0].name).not.toBe("Rations (1 day)");
    }
  });

  it("kit items are characterization, not loot (price 0)", () => {
    const rng = rngFromSeed(7);
    for (const item of livingKit(rng)) {
      expect((item.system.price as { value: number }).value).toBe(0);
    }
  });
});

describe("signature items (rule 2)", () => {
  it("every NPC has exactly one signature item with a name and a story", () => {
    const enc = generateEncounter(baseSpec());
    for (const npc of enc.npcs) {
      expect(npc.signature.name.length).toBeGreaterThan(0);
      expect(npc.signature.story).toBeDefined();
      expect((npc.signature.story ?? "").length).toBeGreaterThan(10);
      expect(npc.signature.signature).toBe(true);
      expect(npc.signature.dropsOnDeath).toBe(true);
      const all = [...npc.weapons, ...npc.livingKit, ...npc.spells, npc.signature];
      expect(all.filter((i) => i.signature)).toHaveLength(1);
    }
  });

  it("signature names are unique within the encounter", () => {
    const enc = generateEncounter(baseSpec());
    const names = enc.npcs.map((n) => n.signature.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("many same-role NPCs still get unique signatures (pool + fallback)", () => {
    const enc = generateEncounter(
      baseSpec({
        npcs: Array.from({ length: 8 }, (_, i) => ({ name: `Guard ${i + 1}`, role: "guard" as NpcRole })),
      }),
    );
    const names = enc.npcs.map((n) => n.signature.name);
    expect(new Set(names).size).toBe(8);
  });

  it("a Muse-authored signature is used verbatim", () => {
    const enc = generateEncounter(
      baseSpec({
        npcs: [
          { name: "Captain Morvain", role: "leader", signature: { name: "The Blade of Dawn", story: "Carried since the first watch." } },
        ],
      }),
    );
    expect(enc.npcs[0].signature.name).toBe("The Blade of Dawn");
    expect(enc.npcs[0].signature.story).toBe("Carried since the first watch.");
  });

  it("duplicate Muse-authored signature names are rejected", () => {
    expect(() =>
      generateEncounter(
        baseSpec({
          npcs: [
            { name: "A", role: "guard", signature: { name: "Same Blade", story: "One." } },
            { name: "B", role: "guard", signature: { name: "same blade", story: "Two." } },
          ],
        }),
      ),
    ).toThrow(/Duplicate signature/);
  });

  it("pickSignature never repeats a name from the used set", () => {
    const rng = rngFromSeed(3);
    const used = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const item = pickSignature("mage", "death", rng, used);
      expect(used.has(item.name)).toBe(true);
    }
    expect(used.size).toBe(6);
  });
});

describe("backstories (honesty rule)", () => {
  it("references story facts and never invents names", () => {
    const enc = generateEncounter(baseSpec());
    const joined = enc.npcs.map((n) => n.backstory).join(" ");
    const mentionsContext =
      joined.includes("Zolgran") || joined.includes("Otari") || joined.includes("Lich's Lair") || joined.includes("the Lich");
    expect(mentionsContext).toBe(true);
    for (const decoy of DECOYS) {
      expect(joined).not.toContain(decoy);
    }
    for (const npc of enc.npcs) expect(npc.generic).toBe(false);
  });

  it("a Muse one-liner is used verbatim", () => {
    const enc = generateEncounter(
      baseSpec({
        npcs: [{ name: "Captain Morvain", role: "leader", oneLiner: "Swore an oath to the lich after the fall of the old garrison." }],
      }),
    );
    expect(enc.npcs[0].backstory).toContain("Swore an oath to the lich after the fall of the old garrison.");
  });

  it("no context means explicitly generic, not invented", () => {
    const rng = rngFromSeed(7);
    const { text, generic } = buildBackstory({ name: "Test Guard", role: "guard" }, {}, rng);
    expect(generic).toBe(true);
    expect(text).toContain("No story on record");
    for (const decoy of DECOYS) expect(text).not.toContain(decoy);
  });
});

describe("formations", () => {
  it("ring of 9 is evenly spaced and faces the center", () => {
    const positions = formationPositions({ type: "ring", center: { x: 800, y: 800 }, radius: 300 }, 9);
    expect(positions).toHaveLength(9);
    for (const p of positions) {
      const dist = Math.hypot(p.x - 800, p.y - 800);
      expect(dist).toBeGreaterThanOrEqual(299);
      expect(dist).toBeLessThanOrEqual(301);
      const expectedFacing = angleToEast({ x: p.x, y: p.y }, { x: 800, y: 800 });
      expect(Math.abs(p.facing - expectedFacing)).toBeLessThan(1);
    }
    const angles = positions.map((p) => Math.atan2(p.y - 800, p.x - 800)).sort((a, b) => a - b);
    for (let i = 1; i < angles.length; i++) {
      const diff = angles[i] - angles[i - 1];
      expect(Math.abs(diff - (2 * Math.PI) / 9)).toBeLessThan(0.01);
    }
  });

  it("line is evenly spaced in a row", () => {
    const positions = formationPositions({ type: "line", center: { x: 800, y: 800 }, spacing: 100 }, 4);
    expect(positions).toHaveLength(4);
    expect(positions.map((p) => p.y)).toEqual([800, 800, 800, 800]);
    for (let i = 1; i < 4; i++) expect(positions[i].x - positions[i - 1].x).toBe(100);
  });

  it("wedge points at the center and opens away from the focus", () => {
    const positions = formationPositions(
      { type: "wedge", center: { x: 800, y: 800 }, focus: { x: 800, y: 400 }, spacing: 100 },
      5,
    );
    expect(positions).toHaveLength(5);
    expect(positions[0].x).toBe(800);
    expect(positions[0].y).toBe(800);
    // The arms go away from the focus (downward, y > 800) and spread sideways.
    for (const p of positions.slice(1)) expect(p.y).toBeGreaterThanOrEqual(800);
  });

  it("wedge matches the legacy positions and facings exactly (BRA-201 merge)", () => {
    // Hardcoded from the pre-merge implementation — the merge must not
    // move a single pixel or change a single facing number. This is
    // the demo encounter's formation (wedge, 6 NPCs).
    const positions = formationPositions(
      { type: "wedge", center: { x: 800, y: 800 }, focus: { x: 800, y: 400 }, spacing: 100 },
      6,
    );
    expect(positions).toEqual([
      { name: "", x: 800, y: 800, facing: -90 },
      { name: "", x: 700, y: 900, facing: -78.69006752597979 },
      { name: "", x: 900, y: 900, facing: -101.30993247402021 },
      { name: "", x: 600, y: 1000, facing: -71.56505117707799 },
      { name: "", x: 1000, y: 1000, facing: -108.43494882292202 },
      { name: "", x: 500, y: 1100, facing: -66.80140948635182 },
    ]);
  });

  it("wedge with a diagonal focus matches the legacy geometry exactly", () => {
    const positions = formationPositions(
      { type: "wedge", center: { x: 800, y: 800 }, focus: { x: 900, y: 700 }, spacing: 100 },
      5,
    );
    expect(positions).toEqual([
      { name: "", x: 800, y: 800, facing: -45 },
      { name: "", x: 659, y: 800, facing: -22.53540778705149 },
      { name: "", x: 800, y: 941, facing: -67.46459221294852 },
      { name: "", x: 517, y: 800, facing: -14.633052919155656 },
      { name: "", x: 800, y: 1083, facing: -75.36694708084435 },
    ]);
  });

  it("wedge with no focus collapses onto the center (legacy behavior, preserved)", () => {
    const positions = formationPositions({ type: "wedge", center: { x: 800, y: 800 }, spacing: 100 }, 3);
    expect(positions).toEqual([
      { name: "", x: 800, y: 800, facing: 0 },
      { name: "", x: 800, y: 800, facing: 0 },
      { name: "", x: 800, y: 800, facing: 0 },
    ]);
  });

  it("line with a focus faces each member at the focus", () => {
    const positions = formationPositions(
      { type: "line", center: { x: 800, y: 800 }, spacing: 100, focus: { x: 800, y: 400 } },
      4,
    );
    expect(positions).toEqual([
      { name: "", x: 650, y: 800, facing: -69.44395478041653 },
      { name: "", x: 750, y: 800, facing: -82.87498365109819 },
      { name: "", x: 850, y: 800, facing: -97.12501634890181 },
      { name: "", x: 950, y: 800, facing: -110.55604521958347 },
    ]);
  });
});

describe("assembly and validation", () => {
  it("assembles a 6-NPC encounter with matching placements", () => {
    const enc = generateEncounter(baseSpec());
    expect(enc.npcs).toHaveLength(6);
    expect(enc.placements).toHaveLength(6);
    expect(enc.placements.map((p) => p.name).sort()).toEqual(enc.npcs.map((n) => n.name).sort());
    expect(enc.summary).toContain("6 foes");
  });

  it("formatEncounter names every NPC and its signature drop", () => {
    const enc = generateEncounter(baseSpec());
    const text = formatEncounter(enc);
    for (const npc of enc.npcs) {
      expect(text).toContain(npc.name);
      expect(text).toContain(npc.signature.name);
    }
  });

  it("rejects duplicate NPC names", () => {
    expect(() =>
      generateEncounter(
        baseSpec({ npcs: [{ name: "Same", role: "guard" }, { name: "same", role: "mage" }] }),
      ),
    ).toThrow(/Duplicate NPC name/);
  });

  it("rejects unknown roles, empty lists, and oversized encounters", () => {
    expect(() =>
      generateEncounter(baseSpec({ npcs: [{ name: "X", role: "dragon" as NpcRole }] })),
    ).toThrow(/Unknown NPC role/);
    expect(() => generateEncounter(baseSpec({ npcs: [] }))).toThrow(/at least one NPC/);
    expect(() =>
      generateEncounter(
        baseSpec({ npcs: Array.from({ length: 13 }, (_, i) => ({ name: `N${i}`, role: "guard" as NpcRole })) }),
      ),
    ).toThrow(/max 12/);
  });

  it("rejects a bad party level and a bad formation", () => {
    expect(() => generateEncounter(baseSpec({ partyLevel: 0 }))).toThrow(/Party level/);
    expect(() =>
      generateEncounter(baseSpec({ formation: { type: "circle", center: { x: 0, y: 0 } } as never })),
    ).toThrow(/Unknown formation/);
  });
});
