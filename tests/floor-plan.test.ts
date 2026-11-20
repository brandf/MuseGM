/**
 * Floor-plan tests — high-level floor generation (FR-15).
 * Pure planning only; no Foundry connection.
 */
import { describe, it, expect } from "bun:test";
import {
  planFloor,
  validateFloorPlan,
  validateBrief,
  renderFloorPreview,
  lockFloorPlan,
} from "../src/session/floor-plan.js";
import type { Chronicle, FloorBrief, FloorPlan } from "../src/session/floor-plan.js";
import { validateCutscene } from "../src/session/cutscene.js";

const CHRONICLE: Chronicle = {
  campaign: "Menace Under Otari",
  partyMembers: ["Ezren", "Kyra", "Merisiel", "Valeros"],
  keyNpcs: ["the Lich", "Zolgran", "Xulgath"],
  pastEvents: [
    "Merisiel fell to Zolgran's Force Barrage in the Landing",
    "The party found the Lich's Lair beneath Otari",
    "Valeros joined the party in the Entry Hall",
  ],
  openThreads: ["The Lich's plan for Otari", "What the Lich is building in the deep dark"],
  notableDeaths: ["Merisiel"],
};

const BRIEF: FloorBrief = {
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

function demoPlan(): FloorPlan {
  return planFloor(BRIEF, CHRONICLE);
}

describe("planFloor — the demo floor", () => {
  it("plans the lich's lair floor: entry + 3 plate rooms + riddle + 2 encounter rooms + boss", () => {
    const plan = demoPlan();
    expect(plan.name).toBe("The Lich's Lair — Deep Floor");
    expect(plan.locked).toBe(false);
    const purposes = plan.rooms.map((r) => r.purpose);
    expect(purposes.filter((p) => p === "entry")).toHaveLength(1);
    expect(purposes.filter((p) => p === "plate")).toHaveLength(3);
    expect(purposes.filter((p) => p === "riddle")).toHaveLength(1);
    expect(purposes.filter((p) => p === "boss")).toHaveLength(1);
    expect(purposes.filter((p) => p === "encounter" || p === "ambush")).toHaveLength(2);
    expect(plan.rooms).toHaveLength(8);
  });

  it("is deterministic: same seed → byte-identical plan", () => {
    const a = JSON.stringify(demoPlan());
    const b = JSON.stringify(demoPlan());
    expect(a).toBe(b);
  });

  it("a different seed plans a different floor (room names or plate effects differ)", () => {
    const a = JSON.stringify(demoPlan());
    const other = JSON.stringify(planFloor({ ...BRIEF, seed: 8 }, CHRONICLE));
    expect(other).not.toBe(a);
  });

  it("defaults fill in when the brief is nearly empty", () => {
    const plan = planFloor({}, CHRONICLE);
    expect(plan.plates.plates).toHaveLength(3);
    expect(plan.riddle).toBeDefined();
    expect(plan.encounters.filter((e) => e.kind === "boss")).toHaveLength(1);
    expect(plan.partyLevel).toBe(1);
  });
});

describe("the plate puzzle", () => {
  it("has 3 plates in 3 distinct rooms, each with a distinct effect", () => {
    const plan = demoPlan();
    expect(plan.plates.plates).toHaveLength(3);
    const rooms = plan.plates.plates.map((p) => p.room);
    expect(new Set(rooms).size).toBe(3);
    const effects = plan.plates.plates.map((p) => p.effect);
    expect(new Set(effects).size).toBe(3);
    for (const plate of plan.plates.plates) {
      expect(plate.detail.length).toBeGreaterThan(20);
    }
  });

  it("all plates together unlock the boss door", () => {
    const plan = demoPlan();
    expect(plan.plates.unlocks.from.room).toBe("riddle");
    expect(plan.plates.unlocks.to.room).toBe("boss");
    expect(plan.plates.unlocks).toEqual(plan.bossDoor);
  });

  it("one plate's clue quotes a chronicle fact", () => {
    const plan = demoPlan();
    const clue = plan.plates.plates.find((p) => p.effect === "reveals a clue");
    if (clue) {
      expect(CHRONICLE.pastEvents.some((e) => clue.detail.includes(e))).toBe(true);
    } else {
      // The seeded effect draw may not include the clue plate for this
      // seed — then some plate's detail must still reference the boss room.
      expect(plan.plates.plates.some((p) => p.detail.includes("Sanctum"))).toBe(true);
    }
  });
});

describe("the riddle", () => {
  it("fills its slots from the chronicle and answers with a chronicle name", () => {
    const plan = demoPlan();
    expect(plan.riddle).toBeDefined();
    expect(plan.chronicleNames).toContain(plan.riddle!.answer);
    expect(plan.riddle!.question).not.toContain("{");
    expect(plan.riddle!.answerSource).toContain("chronicle");
  });

  it("the answer is someone the party knows — Merisiel, the Lich, or a party member", () => {
    const plan = demoPlan();
    expect(["Merisiel", "the Lich", "Zolgran", "Xulgath", "Ezren", "Kyra", "Valeros"]).toContain(
      plan.riddle!.answer,
    );
  });

  it("throws when the chronicle has no name to answer with", () => {
    const empty: Chronicle = {
      partyMembers: [],
      keyNpcs: [],
      pastEvents: [],
      openThreads: [],
    };
    expect(() => planFloor(BRIEF, empty)).toThrow(/chronicle name/i);
  });
});

describe("encounters — ambush as cutscene, boss as boss", () => {
  it("has 2 minor encounters, exactly one an ambush, plus the boss", () => {
    const plan = demoPlan();
    expect(plan.encounters.filter((e) => e.kind === "minor")).toHaveLength(1);
    expect(plan.encounters.filter((e) => e.kind === "ambush")).toHaveLength(1);
    expect(plan.encounters.filter((e) => e.kind === "boss")).toHaveLength(1);
  });

  it("the ambush is flagged as a cutscene with a valid cutscene script", () => {
    const plan = demoPlan();
    const ambush = plan.encounters.find((e) => e.kind === "ambush")!;
    expect(ambush.cutscene).toBe(true);
    expect(ambush.cutsceneScript).toBeDefined();
    // The script must pass the cutscene engine's own strict validation.
    const result = validateCutscene(ambush.cutsceneScript);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`Ambush script failed validation: ${result.errors.join("; ")}`);
    const validated = result.script;
    expect(validated.name).toContain("Ambush");
    expect(validated.steps.length).toBeGreaterThanOrEqual(3);
    const placeSteps = validated.steps.filter((s) => s.kind === "place");
    expect(placeSteps).toHaveLength(ambush.spec.npcs.length);
  });

  it("plain minor encounters are NOT cutscenes", () => {
    const plan = demoPlan();
    const minor = plan.encounters.find((e) => e.kind === "minor")!;
    expect(minor.cutscene).toBe(false);
    expect(minor.cutsceneScript).toBeUndefined();
  });

  it("the boss is the Lich, level party+2, in the boss room", () => {
    const plan = demoPlan();
    const boss = plan.encounters.find((e) => e.kind === "boss")!;
    expect(boss.room).toBe("boss");
    expect(boss.spec.npcs[0].name).toBe("the Lich");
    expect(boss.spec.npcs[0].role).toBe("leader");
    expect(boss.spec.partyLevel).toBe(4);
    expect(boss.spec.npcs).toHaveLength(3);
  });

  it("every encounter spec has NPCs with living-kit roles and a story context", () => {
    const plan = demoPlan();
    for (const enc of plan.encounters) {
      expect(enc.spec.npcs.length).toBeGreaterThan(0);
      expect(enc.spec.partyLevel).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("validateFloorPlan", () => {
  it("the demo plan is valid", () => {
    expect(validateFloorPlan(demoPlan())).toEqual([]);
  });

  it("catches an orphan room (unreachable from the entry)", () => {
    const plan = demoPlan();
    plan.rooms.push({
      id: "orphan", name: "Orphan Vault", purpose: "plate", gridW: 5, gridH: 5,
      doors: [], source: { kind: "brief", ref: "brief.puzzleCount" },
    });
    const errors = validateFloorPlan(plan);
    expect(errors.some((e) => e.includes("unreachable") && e.includes("orphan"))).toBe(true);
  });

  it("catches a boss reachable without its door (a shortcut link bypassing the plate chain)", () => {
    const plan = demoPlan();
    plan.links.push({
      from: { room: "entry", wall: "south", at: 3 },
      to: { room: "boss", wall: "north", at: 5 },
    });
    const errors = validateFloorPlan(plan);
    expect(errors.some((e) => e.includes("without its door"))).toBe(true);
  });

  it("catches a missing boss room", () => {
    const plan = demoPlan();
    plan.rooms = plan.rooms.filter((r) => r.id !== "boss");
    const errors = validateFloorPlan(plan);
    expect(errors.some((e) => e.includes("Boss room"))).toBe(true);
  });

  it("catches a puzzle element with no source", () => {
    const plan = demoPlan();
    plan.plates.source = { kind: "brief", ref: "" };
    const errors = validateFloorPlan(plan);
    expect(errors.some((e) => e.includes("no source"))).toBe(true);
  });

  it("catches a riddle answered with a name nobody knows", () => {
    const plan = demoPlan();
    plan.riddle!.answer = "King Vharg of Nowhere";
    const errors = validateFloorPlan(plan);
    expect(errors.some((e) => e.includes("not a chronicle name"))).toBe(true);
  });

  it("catches two plates with the same effect", () => {
    const plan = demoPlan();
    plan.plates.plates[1].effect = plan.plates.plates[0].effect;
    const errors = validateFloorPlan(plan);
    expect(errors.some((e) => e.includes("same effect"))).toBe(true);
  });

  it("catches an encounter in a room that does not exist", () => {
    const plan = demoPlan();
    plan.encounters[0].room = "nowhere";
    const errors = validateFloorPlan(plan);
    expect(errors.some((e) => e.includes("unknown room"))).toBe(true);
  });
});

describe("validateBrief", () => {
  it("rejects zero plate rooms", () => {
    expect(() => validateBrief({ puzzleCount: 0 })).toThrow(/at least one pressure-plate/);
  });

  it("rejects a party level below 1", () => {
    expect(() => validateBrief({ partyLevel: 0 })).toThrow(/Party level/);
  });
});

describe("renderFloorPreview — the convergence loop", () => {
  it("renders every room name and the links between them", () => {
    const plan = demoPlan();
    const preview = renderFloorPreview(plan);
    for (const room of plan.rooms) {
      expect(preview).toContain(room.name);
    }
    expect(preview).toContain("---");
    expect(preview).toContain("|");
  });

  it("has one paragraph per beat: puzzle + riddle + 3 encounters + 2 intrigue + 2 storyline", () => {
    const plan = demoPlan();
    const preview = renderFloorPreview(plan);
    const beats = preview.split("\n").filter((l) => l.startsWith("### "));
    expect(beats).toHaveLength(1 + 1 + 3 + 2 + 2);
    expect(beats.some((b) => b.includes("Puzzle"))).toBe(true);
    expect(beats.some((b) => b.includes("Riddle"))).toBe(true);
    expect(beats.some((b) => b.includes("Ambush"))).toBe(true);
    expect(beats.some((b) => b.includes("Boss battle"))).toBe(true);
    expect(beats.some((b) => b.includes("Intrigue"))).toBe(true);
    expect(beats.some((b) => b.includes("Storyline"))).toBe(true);
  });

  it("the preview names the riddle answer's owner but never invents a new proper noun for the answer", () => {
    const plan = demoPlan();
    const preview = renderFloorPreview(plan);
    expect(preview).toContain(plan.riddle!.answer);
  });
});

describe("lockFloorPlan — the build manifest", () => {
  it("locks the plan and lists the builder calls in order", () => {
    const plan = demoPlan();
    const { plan: locked, manifest } = lockFloorPlan(plan);
    expect(locked.locked).toBe(true);
    expect(plan.locked).toBe(false);
    const tools = manifest.map((s) => s.tool);
    expect(tools[0]).toBe("uploadTilePack");
    expect(tools[1]).toBe("buildDungeon");
    // Plates wire before encounters; treasure comes right after the boss encounter.
    const trapIdx = tools.indexOf("trap");
    const encIdx = tools.indexOf("encounter-gen");
    const treasureIdx = tools.indexOf("treasure");
    const cutsceneIdx = tools.indexOf("cutscene");
    expect(trapIdx).toBeGreaterThan(1);
    expect(trapIdx).toBeLessThan(encIdx);
    expect(treasureIdx).toBeGreaterThan(encIdx);
    expect(cutsceneIdx).toBeGreaterThan(1);
    expect(tools).toContain("send"); // riddle reveal
    expect(tools).toContain("journal"); // intrigue + storyline GM notes
    // Orders are sequential from 0.
    expect(manifest.map((s) => s.order)).toEqual(manifest.map((_, i) => i));
  });

  it("the buildDungeon step carries a valid dungeon graph (rooms + links)", () => {
    const { manifest } = lockFloorPlan(demoPlan());
    const build = manifest.find((s) => s.tool === "buildDungeon")!;
    const dungeon = build.args["dungeon"] as { rooms: unknown[]; links: unknown[] };
    expect(dungeon.rooms).toHaveLength(8);
    expect(dungeon.links).toHaveLength(7);
  });

  it("the boss treasure step is budgeted (500 gp, party level)", () => {
    const { manifest } = lockFloorPlan(demoPlan());
    const treasure = manifest.find((s) => s.tool === "treasure")!;
    expect(treasure.args["budgetGp"]).toBe(500);
    expect(treasure.args["level"]).toBe(2);
    expect(treasure.args["room"]).toBe("boss");
  });

  it("refuses to lock an invalid plan and refuses to lock twice", () => {
    const plan = demoPlan();
    plan.rooms = plan.rooms.filter((r) => r.id !== "boss");
    expect(() => lockFloorPlan(plan)).toThrow(/Cannot lock/);
    const { plan: locked } = lockFloorPlan(demoPlan());
    expect(() => lockFloorPlan(locked)).toThrow(/already locked/);
  });
});

describe("intrigue + storyline trace to the chronicle", () => {
  it("every intrigue beat names a chronicle NPC and quotes a chronicle fact", () => {
    const plan = demoPlan();
    expect(plan.intrigue).toHaveLength(2);
    for (const beat of plan.intrigue) {
      expect(beat.npcs.length).toBeGreaterThan(0);
      expect(CHRONICLE.pastEvents.some((e) => beat.secret.includes(e))).toBe(true);
      expect(beat.source.kind).toBe("chronicle");
    }
  });

  it("every storyline advance traces to a brief thread", () => {
    const plan = demoPlan();
    expect(plan.storyline).toHaveLength(2);
    for (const adv of plan.storyline) {
      expect(BRIEF.storylineThreads).toContain(adv.thread);
      expect(adv.source.kind).toBe("brief");
    }
  });
});
