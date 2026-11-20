/**
 * High-level floor generation (FR-15) — the vague-brief mode.
 *
 * Two modes, not one: the hands-on mode (FR-1: "add a door here") is
 * specific and direct; this mode is vague and high-level. The creator
 * throws out ideas — "three pressure-plate puzzles in three rooms to
 * unlock a door, a riddle over here, two minor encounters, one an
 * ambush, then the boss battle, some intrigue, and move the main story
 * forward" — and Muse does the creative work.
 *
 * The flow:
 * 1. `planFloor(brief, chronicle)` — brief + campaign chronicle in, a
 *    floor plan out. Pure and deterministic for a given seed.
 * 2. `renderFloorPreview(plan)` — the convergence loop: a cheap ASCII
 *    layout sketch + one paragraph per beat, shown to the creator
 *    BEFORE anything is built. Show a few things, erase them, show
 *    alternatives — the iteration happens at the idea level, not the
 *    tile level.
 * 3. `lockFloorPlan(plan)` — once the ideas converge, the plan is
 *    locked and a build manifest is produced: the ordered list of
 *    existing-builder calls it maps to (buildDungeon, encounter-gen,
 *    cutscene, treasure, traps). The manifest is DATA, not execution —
 *    the live wiring is a later step.
 *
 * HONESTY RULE (the same rule as the encounter generator and the
 * recap): every puzzle, encounter, intrigue beat, and storyline
 * advance traces to something in the brief or the chronicle — nothing
 * generic, nothing invented. Each element carries its `source`
 * (brief item or chronicle entry), and `validateFloorPlan` fails any
 * element with no source. The riddle's answer is a name or event the
 * party already knows, taken from the chronicle. The plates each do
 * something distinct, drawn from the brief's puzzle kind + chronicle
 * facts. With no chronicle facts to draw on, the planner says so
 * (throws) instead of inventing plot.
 *
 * Pure functions only (no Foundry, no I/O), unit tested in
 * tests/floor-plan.test.ts. The only runtime import is the seeded RNG
 * from loot.ts; encounter-gen and cutscene types are imported type-only.
 */
import { rngFromSeed } from "./loot.js";
import type { EncounterSpec, EncounterTheme, NpcRole } from "./encounter-gen.js";
import type { CutsceneScript } from "./cutscene.js";
import type { DoorSpec, WallSide } from "../worldbuilding/tiles-layout.js";

// ---------------------------------------------------------------- types

/** Where one plan element came from. Every element carries one. */
export interface PlanSource {
  kind: "brief" | "chronicle";
  /** The brief field or chronicle entry it traces to, e.g. "brief.puzzleKind" or "chronicle: Merisiel fell to Zolgran's Force Barrage in the Landing". */
  ref: string;
}

/** The vague brief, as the creator gives it. Everything is optional — sensible defaults fill the gaps. */
export interface FloorBrief {
  /** Floor name, e.g. "The Lich's Lair — Deep Floor". Default: "Untitled Floor". */
  name?: string;
  /** Story theme, e.g. "death", "gothic", "crypt". Default: "dungeon". */
  theme?: string;
  /** Party level the floor is built for. Default: 1. */
  partyLevel?: number;
  /** Seed for deterministic planning. Default: 7. */
  seed?: number;
  /** Puzzle kind. Default: "pressure-plates". */
  puzzleKind?: string;
  /** How many pressure-plate rooms. Default: 3. Must be >= 1. */
  puzzleCount?: number;
  /** Include a riddle room. Default: true. */
  riddle?: boolean;
  /** How many minor encounters. Default: 2. */
  minorEncounterCount?: number;
  /** One of the minor encounters is an ambush cutscene. Default: true. */
  ambush?: boolean;
  /** The boss. Default: { kind: "lich", name: "the Lich" }. */
  boss?: { kind?: string; name?: string };
  /** How many intrigue beats. Default: 2. */
  intrigueCount?: number;
  /** Storyline threads to advance. Default: the chronicle's open threads. */
  storylineThreads?: string[];
  /** Boss-room treasure budget in gp. Default: 500. */
  bossTreasureGp?: number;
  /** Custom room names (plate rooms, encounter rooms, boss room). Seeded pools are used for any not given. */
  roomNames?: { entry?: string; plates?: string[]; riddle?: string; encounters?: string[]; boss?: string };
}

/**
 * The campaign chronicle, as Muse has been chronicling it (recaps,
 * journals). PLAIN DATA, passed in — the planner never invents it.
 * Everything the planner writes about the story comes from here or
 * from the brief; with nothing to draw on, the planner throws rather
 * than inventing plot.
 */
export interface Chronicle {
  campaign?: string;
  /** The player characters. */
  partyMembers: string[];
  /** Named NPCs/factions the story knows. */
  keyNpcs: string[];
  /** Past events, as plain strings (from recaps). */
  pastEvents: string[];
  /** Open storyline threads. */
  openThreads: string[];
  /** Named dead, for riddles and memorial beats. */
  notableDeaths?: string[];
}

export type FloorRoomPurpose =
  | "entry"
  | "plate"
  | "riddle"
  | "encounter"
  | "ambush"
  | "boss";

/** One room in the plan. */
export interface FloorRoom {
  id: string;
  name: string;
  purpose: FloorRoomPurpose;
  gridW: number;
  gridH: number;
  /** Doors, declared to match the links (so the manifest's DungeonSpec is valid for layoutDungeon). */
  doors: DoorSpec[];
  /** The room this one hangs off (previous chain room, or the attach room for branches). Used for the ASCII preview layout. */
  branchOf?: string;
  source: PlanSource;
}

/** One end of a room link: a door cell in a room. */
export interface FloorLinkEnd {
  room: string;
  wall: WallSide;
  at: number;
}

/** A door link between two rooms. */
export interface FloorLink {
  from: FloorLinkEnd;
  to: FloorLinkEnd;
}

/** One pressure plate: a room, a distinct effect, and the detail that makes it interesting. */
export interface Plate {
  room: string;
  /** Short effect label, e.g. "opens the iron gate". Distinct within the puzzle. */
  effect: string;
  /** One line: what the party sees when the plate is pressed. May quote a chronicle fact. */
  detail: string;
}

/** The pressure-plate puzzle: N plates in N rooms, all required to unlock the boss door. */
export interface PlatePuzzle {
  id: string;
  kind: string;
  plates: Plate[];
  /** The boss door this puzzle unlocks (the link into the boss room). */
  unlocks: FloorLink;
  source: PlanSource;
}

/** The riddle room: a question with slots filled from the chronicle, answered by a name the party already knows. */
export interface Riddle {
  id: string;
  room: string;
  question: string;
  /** The answer — always a chronicle name (a person or a named event). */
  answer: string;
  /** Where the answer comes from in the chronicle. */
  answerSource: string;
  source: PlanSource;
}

/** One encounter in the plan, with its encounter-generator spec attached. */
export interface FloorEncounter {
  id: string;
  kind: "minor" | "ambush" | "boss";
  room: string;
  /** True for ambushes: this encounter plays as a cutscene, not a plain encounter. */
  cutscene: boolean;
  /** The ambush cutscene script (ambushes only). */
  cutsceneScript?: CutsceneScript;
  /** The compact spec for the encounter generator (FR-11). */
  spec: EncounterSpec;
  source: PlanSource;
}

/** One intrigue beat: something the party discovers that complicates the story. */
export interface IntrigueBeat {
  id: string;
  beat: string;
  room: string;
  /** Chronicle NPCs involved. */
  npcs: string[];
  /** The secret, in one line — composed from a chronicle fact. */
  secret: string;
  source: PlanSource;
}

/** One storyline advance: a thread, how it moves, and where. */
export interface StorylineAdvance {
  id: string;
  thread: string;
  how: string;
  room: string;
  source: PlanSource;
}

/** A complete floor plan. `locked` is false until `lockFloorPlan`. */
export interface FloorPlan {
  version: 1;
  name: string;
  theme: string;
  partyLevel: number;
  seed: number;
  entryRoomId: string;
  bossRoomId: string;
  /** The link into the boss room — the door the plate puzzle unlocks. */
  bossDoor: FloorLink;
  rooms: FloorRoom[];
  links: FloorLink[];
  plates: PlatePuzzle;
  riddle?: Riddle;
  encounters: FloorEncounter[];
  intrigue: IntrigueBeat[];
  storyline: StorylineAdvance[];
  /** Every chronicle name the plan may reference (party + NPCs + dead) — used to validate the riddle answer. */
  chronicleNames: string[];
  locked: boolean;
}

/** One step of the build manifest: an existing-builder call, in order. */
export interface BuildStep {
  order: number;
  /** The builder to call: a CLI name ("buildDungeon", "encounter-gen", "cutscene", "treasure", "trap", "send", "journal", "uploadTilePack"). */
  tool: string;
  /** Arguments for that builder (data — the live wiring is a later step). */
  args: Record<string, unknown>;
  /** What this step does, in one line. */
  note: string;
}

/** A locked plan + the manifest that builds it. */
export interface LockedFloorPlan {
  plan: FloorPlan;
  manifest: BuildStep[];
}

// ---------------------------------------------------------------- name pools (seeded picks, no proper nouns invented)

/** NPC first names for generated encounters. */
const NPC_NAMES = [
  "Morvain", "Anselm", "Ondine", "Kess", "Bram", "Sable",
  "Tomas", "Ilya", "Corvin", "Mara", "Dain", "Wren",
  "Haldor", "Petra", "Osric", "Lena", "Garrick", "Noor",
];

const PLATE_ROOM_NAMES = [
  "Hall of Weights", "Sunken Gallery", "Chapel of Echoes",
  "Vault of Chains", "The Drowned Stair", "Gallery of Teeth",
  "Hall of Still Water", "The Tolling Chamber",
];

const RIDDLE_ROOM_NAMES = [
  "Riddle Vault", "The Whispering Chamber", "Hall of Questions",
];

const ENCOUNTER_ROOM_NAMES = [
  "Guard Post", "Ambush Gallery", "The Barracks", "Sentry Hall",
  "The Muster Room", "Watchman's Rest",
];

const ENCOUNTER_ROLES: NpcRole[] = ["guard", "mage", "rogue", "brute", "priest"];

/** Plate effects: each plate does something distinct. `{boss}` is the boss room name. */
const PLATE_EFFECTS: { effect: string; detail: string }[] = [
  {
    effect: "opens the iron gate",
    detail: "The iron gate barring {boss} groans open a handspan — not enough to pass, but enough to see the dark beyond.",
  },
  {
    effect: "drains the black water",
    detail: "The black water flooding the floor drains away with a long sigh, revealing dry stone and old bones.",
  },
  {
    effect: "reveals a clue",
    detail: "A carving lights up on the wall, spelling out a line the party has heard before: “{fact}”.",
  },
  {
    effect: "lights the braziers",
    detail: "Cold braziers along {boss} door catch green flame, one by one, like something counting.",
  },
  {
    effect: "lowers the portcullis",
    detail: "The portcullis between this hall and the next drops into the floor with a thud the whole floor feels.",
  },
  {
    effect: "wakes the guardian statue",
    detail: "A statue turns its head toward {boss} door and nods once, slowly, as if granting permission.",
  },
  {
    effect: "still the whispering",
    detail: "The whispering in the walls stops mid-word. The silence is worse than the whispering was.",
  },
  {
    effect: "raises the bridge",
    detail: "A stone bridge rises out of the dark below, spanning a gap the party could not have crossed.",
  },
];

/** Riddle templates. `{answer}` is always a chronicle name; `{event}` and `{person}` are chronicle facts/people. */
const RIDDLE_TEMPLATES: { question: string; answerKind: "death" | "npc" | "party" }[] = [
  {
    question: "“I stood where {event}, and I am no longer standing. Speak my name, and the way opens.”",
    answerKind: "death",
  },
  {
    question: "“{person} swore it would never happen again — yet here we are, beneath the dark. Whose name does {person} still whisper?”",
    answerKind: "npc",
  },
  {
    question: "“One of you has already paid the price this floor asks. Say the name of the one who fell, and the door will believe you.”",
    answerKind: "death",
  },
  {
    question: "“{person} remembers {event}. I remember it too. Say the name of the one who was there, and pass.”",
    answerKind: "party",
  },
];

/** Intrigue secret templates. `{npc}` and `{fact}` come from the chronicle. */
const INTRIGUE_TEMPLATES: string[] = [
  "A letter tucked behind a loose stone is signed {npc} — it says “{fact}”, and it was never sent.",
  "{npc} has been here before: “{fact}”. The scratches on the wall are in their hand.",
  "The mark on the door matches the mark {npc} carries. The chronicle says: “{fact}”. Someone in the party has been carrying the same mark ever since.",
  "A ledger in the {room} lists {npc} as a debtor — the debt is “{fact}”, and it is marked unpaid.",
];

/** Storyline advance templates. `{thread}` is the thread being advanced. */
const STORYLINE_TEMPLATES: string[] = [
  "In {room}, the party finds a clue that moves “{thread}” forward: the enemy's plan is finally named.",
  "In {room}, an old name resurfaces — “{thread}” is no longer a rumor, it is a face.",
  "In {room}, the party sees the cost of “{thread}” firsthand, and the choice it forces can no longer be put off.",
];

const THEME_MAP: Record<string, EncounterTheme> = {
  death: "death",
  gothic: "death",
  crypt: "death",
  shadow: "shadow",
  fire: "fire",
  nature: "nature",
  holy: "holy",
  arcane: "arcane",
};

// ---------------------------------------------------------------- helpers (seeded, deterministic)

type Rng = () => number;

/** Seeded pick of one item. */
function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

/** Seeded shuffle (Fisher–Yates), returns a new array. */
function shuffled<T>(rng: Rng, arr: readonly T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Seeded pick of `count` distinct items (throws if the pool is too small). */
function pickDistinct<T>(rng: Rng, arr: readonly T[], count: number): T[] {
  if (count > arr.length) {
    throw new Error(`Cannot pick ${count} distinct items from a pool of ${arr.length}.`);
  }
  return shuffled(rng, arr).slice(0, count);
}

/** Fill `{key}` slots in a template from a record. Unknown slots are left as-is (caught by validation). */
function fill(template: string, slots: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => slots[key] ?? `{${key}}`);
}

/** Middle cell of a wall (doors may not sit in a corner: 1..n-2). */
function middleAt(cells: number): number {
  return Math.max(1, Math.min(cells - 2, Math.floor(cells / 2)));
}

/** "In the Hall of Weights" / "In The Drowned Stair" — room names starting with "The" take no extra article. */
function inRoom(name: string): string {
  return /^the /i.test(name) ? `In ${name}` : `In the ${name}`;
}

/** "the Hall of Weights" / "The Drowned Stair" — the room name with its article, for mid-sentence use. */
function theRoom(name: string): string {
  return /^the /i.test(name) ? name : `the ${name}`;
}

// ---------------------------------------------------------------- planning

/** Validate a brief before planning. Throws with a clear message. */
export function validateBrief(brief: FloorBrief): void {
  const puzzleCount = brief.puzzleCount ?? 3;
  if (!Number.isInteger(puzzleCount) || puzzleCount < 1) {
    throw new Error(`A floor needs at least one pressure-plate room (puzzleCount ${puzzleCount} is not enough).`);
  }
  if (puzzleCount > PLATE_EFFECTS.length) {
    throw new Error(`puzzleCount ${puzzleCount} exceeds the ${PLATE_EFFECTS.length} distinct plate effects — add more effects before planning a floor this big.`);
  }
  const partyLevel = brief.partyLevel ?? 1;
  if (!Number.isFinite(partyLevel) || partyLevel < 1) {
    throw new Error(`Party level must be 1 or higher (got ${partyLevel}).`);
  }
  const minorCount = brief.minorEncounterCount ?? 2;
  if (!Number.isInteger(minorCount) || minorCount < 0) {
    throw new Error(`minorEncounterCount must be 0 or higher (got ${minorCount}).`);
  }
  const intrigueCount = brief.intrigueCount ?? 2;
  if (!Number.isInteger(intrigueCount) || intrigueCount < 0) {
    throw new Error(`intrigueCount must be 0 or higher (got ${intrigueCount}).`);
  }
  if (brief.bossTreasureGp !== undefined && (!Number.isFinite(brief.bossTreasureGp) || brief.bossTreasureGp < 1)) {
    throw new Error(`bossTreasureGp must be 1 or higher (got ${brief.bossTreasureGp}).`);
  }
}

/**
 * Plan a floor from a vague brief + the campaign chronicle.
 * Deterministic for a given (brief, chronicle, seed): same input, same
 * plan — so the convergence loop can re-show a plan, and a re-plan with
 * the same seed reproduces it exactly.
 */
export function planFloor(brief: FloorBrief, chronicle: Chronicle): FloorPlan {
  validateBrief(brief);
  const seed = brief.seed ?? 7;
  const rng = rngFromSeed(seed);
  const theme = brief.theme ?? "dungeon";
  const partyLevel = Math.max(1, Math.floor(brief.partyLevel ?? 1));
  const puzzleCount = brief.puzzleCount ?? 3;
  const minorCount = brief.minorEncounterCount ?? 2;
  const wantAmbush = brief.ambush ?? true;
  const wantRiddle = brief.riddle ?? true;
  const intrigueCount = brief.intrigueCount ?? 2;
  const bossName = brief.boss?.name ?? chronicle.keyNpcs[0] ?? "the Lich";
  const bossKind = brief.boss?.kind ?? "lich";
  const encounterTheme: EncounterTheme = THEME_MAP[theme.toLowerCase()] ?? "generic";
  const name = brief.name ?? "Untitled Floor";

  const chronicleNames = [
    ...chronicle.partyMembers,
    ...chronicle.keyNpcs,
    ...(chronicle.notableDeaths ?? []),
  ];
  const facts = chronicle.pastEvents.filter((f) => f.trim() !== "");
  const people = [...chronicle.keyNpcs, ...chronicle.partyMembers].filter((p) => p.trim() !== "");

  // --- rooms: entry → plate rooms → riddle → boss, minors branching off the chain.
  const rooms: FloorRoom[] = [];
  const links: FloorLink[] = [];
  const doorsByRoom = new Map<string, DoorSpec[]>();
  const addRoom = (room: FloorRoom): void => {
    rooms.push(room);
    doorsByRoom.set(room.id, room.doors);
  };
  const linkRooms = (
    a: { id: string; gridW: number; gridH: number },
    b: { id: string; gridW: number; gridH: number },
    wallA: WallSide,
    wallB: WallSide,
  ): FloorLink => {
    const atA = middleAt(wallA === "north" || wallA === "south" ? a.gridW : a.gridH);
    const atB = middleAt(wallB === "north" || wallB === "south" ? b.gridW : b.gridH);
    doorsByRoom.get(a.id)!.push({ wall: wallA, at: atA });
    doorsByRoom.get(b.id)!.push({ wall: wallB, at: atB });
    const link: FloorLink = {
      from: { room: a.id, wall: wallA, at: atA },
      to: { room: b.id, wall: wallB, at: atB },
    };
    links.push(link);
    return link;
  };

  const entryName = brief.roomNames?.entry ?? "Entry Hall";
  addRoom({
    id: "entry", name: entryName, purpose: "entry", gridW: 6, gridH: 6, doors: [],
    source: { kind: "brief", ref: "brief.name" },
  });

  const plateNames = pickDistinct(rng, PLATE_ROOM_NAMES, puzzleCount).map(
    (n, i) => brief.roomNames?.plates?.[i] ?? n,
  );
  const plateRoomIds: string[] = [];
  let prev = { id: "entry", gridW: 6, gridH: 6 };
  for (let i = 0; i < puzzleCount; i++) {
    const id = `plate-${i + 1}`;
    addRoom({
      id, name: plateNames[i], purpose: "plate", gridW: 6, gridH: 6, doors: [],
      branchOf: prev.id,
      source: { kind: "brief", ref: `brief.puzzleCount (${puzzleCount} pressure-plate rooms)` },
    });
    linkRooms(prev, { id, gridW: 6, gridH: 6 }, "east", "west");
    plateRoomIds.push(id);
    prev = { id, gridW: 6, gridH: 6 };
  }

  let riddleRoomId: string | undefined;
  if (wantRiddle) {
    const riddleName = brief.roomNames?.riddle ?? pick(rng, RIDDLE_ROOM_NAMES);
    addRoom({
      id: "riddle", name: riddleName, purpose: "riddle", gridW: 5, gridH: 5, doors: [],
      branchOf: prev.id,
      source: { kind: "brief", ref: "brief.riddle" },
    });
    linkRooms(prev, { id: "riddle", gridW: 5, gridH: 5 }, "east", "west");
    riddleRoomId = "riddle";
    prev = { id: "riddle", gridW: 5, gridH: 5 };
  }

  const bossName_room = brief.roomNames?.boss ?? `The ${bossName.replace(/^the /i, "")}’s Sanctum`;
  addRoom({
    id: "boss", name: bossName_room, purpose: "boss", gridW: 10, gridH: 10, doors: [],
    branchOf: prev.id,
    source: { kind: "brief", ref: `brief.boss (${bossKind}: ${bossName})` },
  });
  const bossDoor = linkRooms(prev, { id: "boss", gridW: 10, gridH: 10 }, "east", "west");

  // Minor encounters branch off the chain rooms (plate rooms first, then the riddle room).
  const attachRooms = [...plateRoomIds, ...(riddleRoomId ? [riddleRoomId] : [])];
  const encounterRoomIds: string[] = [];
  const encounterNames = pickDistinct(rng, ENCOUNTER_ROOM_NAMES, Math.max(minorCount, 1)).map(
    (n, i) => brief.roomNames?.encounters?.[i] ?? n,
  );
  const usedNpcNames = new Set<string>();
  const nextNpcName = (): string => {
    for (const n of shuffled(rng, NPC_NAMES)) {
      if (!usedNpcNames.has(n)) {
        usedNpcNames.add(n);
        return n;
      }
    }
    throw new Error("Ran out of NPC names for the floor's encounters — add more names to the pool.");
  };

  const encounters: FloorEncounter[] = [];
  const ambushIndex = wantAmbush && minorCount > 0 ? Math.floor(rng() * minorCount) : -1;
  for (let i = 0; i < minorCount; i++) {
    const id = `encounter-${i + 1}`;
    const attachId = attachRooms[i % attachRooms.length];
    const attach = rooms.find((r) => r.id === attachId)!;
    const isAmbush = i === ambushIndex;
    // Branch direction alternates north/south so branches don't collide in the preview.
    const wall: WallSide = i % 2 === 0 ? "north" : "south";
    const opp: WallSide = wall === "north" ? "south" : "north";
    addRoom({
      id, name: encounterNames[i], purpose: isAmbush ? "ambush" : "encounter",
      gridW: 7, gridH: 6, doors: [], branchOf: attachId,
      source: { kind: "brief", ref: `brief.minorEncounterCount (${minorCount} minor encounters${wantAmbush ? ", one an ambush" : ""})` },
    });
    linkRooms(attach, { id, gridW: 7, gridH: 6 }, wall, opp);
    encounterRoomIds.push(id);

    const npcCount = 3 + Math.floor(rng() * 2); // 3–4
    const roles = pickDistinct(rng, ENCOUNTER_ROLES, Math.min(npcCount, ENCOUNTER_ROLES.length));
    while (roles.length < npcCount) roles.push(pick(rng, ENCOUNTER_ROLES));
    const storyFacts = facts.length > 0 ? [pick(rng, facts)] : [];
    const npcs = roles.map((role) => ({
      name: nextNpcName(),
      role,
      oneLiner: storyFacts.length > 0
        ? `Sworn to ${bossName} after ${storyFacts[0]}` // fact verbatim — it may start with a proper noun ("Valeros joined…"), never lowercased
        : undefined,
    }));
    const room = rooms.find((r) => r.id === id)!;
    const center = { x: (room.gridW * 100) / 2, y: (room.gridH * 100) / 2 };
    const spec: EncounterSpec = {
      npcs,
      formation: { type: isAmbush ? "ring" : "line", center, radius: 300 },
      theme: encounterTheme,
      partyLevel,
      story: {
        campaign: chronicle.campaign,
        location: name,
        facts: storyFacts,
        people: people.slice(0, 3),
      },
      seed,
    };
    let cutsceneScript: CutsceneScript | undefined;
    if (isAmbush) {
      // The ambush plays as a cutscene: the NPCs take their ring
      // positions around the party, then the narration lands. Ring
      // positions are computed here (code), never enumerated by Muse.
      const radius = 300;
      const placeSteps = npcs.map((npc, j) => {
        const a = -Math.PI / 2 + (j * 2 * Math.PI) / npcs.length;
        return {
          kind: "place" as const,
          // sceneId is the room id here — the live wiring resolves room →
          // scene id before playing (scene ids are server-assigned).
          sceneId: id,
          actor: npc.name,
          x: Math.round(center.x + radius * Math.cos(a)),
          y: Math.round(center.y + radius * Math.sin(a)),
          name: npc.name,
          key: `ambush-${npc.name.toLowerCase()}`,
        };
      });
      cutsceneScript = {
        version: 1,
        name: `Ambush in ${room.name}`,
        sceneId: id,
        steps: [
          { kind: "chat", content: "Something moves in the dark at the edges of the room — and then, all at once, they are around you." },
          ...placeSteps,
          { kind: "pause", ms: 800 },
          { kind: "chat", content: `${npcs.map((n) => n.name).join(", ")} — spears levelled, no words, no warning.` },
        ],
      };
    }
    encounters.push({
      id, kind: isAmbush ? "ambush" : "minor", room: id,
      cutscene: isAmbush, cutsceneScript, spec,
      source: { kind: "brief", ref: `brief.minorEncounterCount (${minorCount} minor encounters${wantAmbush ? ", one an ambush" : ""})` },
    });
  }

  // The boss encounter: the boss (leader) + two guards, scaled above the party.
  const bossLevel = partyLevel + 2;
  const bossSpec: EncounterSpec = {
    npcs: [
      { name: bossName, role: "leader", oneLiner: `The figure the chronicle has been building toward — ${facts.length > 0 ? facts[0] : "the end of this floor"}.` },
      { name: nextNpcName(), role: "guard" },
      { name: nextNpcName(), role: "guard" },
    ],
    formation: { type: "wedge", center: { x: 500, y: 500 } },
    theme: encounterTheme,
    partyLevel: bossLevel,
    story: {
      campaign: chronicle.campaign,
      location: name,
      facts: facts.slice(0, 2),
      people: people.slice(0, 3),
    },
    seed,
  };
  encounters.push({
    id: "boss", kind: "boss", room: "boss", cutscene: false, spec: bossSpec,
    source: { kind: "brief", ref: `brief.boss (${bossKind}: ${bossName})` },
  });

  // --- the plate puzzle: one plate per plate room, distinct effects, all required for the boss door.
  const effects = pickDistinct(rng, PLATE_EFFECTS, puzzleCount);
  const plates: PlatePuzzle = {
    id: "plates",
    kind: brief.puzzleKind ?? "pressure-plates",
    plates: plateRoomIds.map((roomId, i) => {
      const detail = fill(effects[i].detail, {
        boss: theRoom(bossName_room),
        fact: facts.length > 0 ? facts[i % facts.length] : "the party has been here before",
      });
      return { room: roomId, effect: effects[i].effect, detail };
    }),
    unlocks: bossDoor,
    source: { kind: "brief", ref: `brief.puzzleKind (${brief.puzzleKind ?? "pressure-plates"}) + brief.puzzleCount (${puzzleCount})` },
  };

  // --- the riddle: slots filled from the chronicle; the answer is a name the party already knows.
  let riddle: Riddle | undefined;
  if (wantRiddle) {
    if (chronicleNames.length === 0) {
      throw new Error("A riddle needs a chronicle name to answer it — the chronicle has no party members, key NPCs, or notable deaths. Add chronicle names or set brief.riddle to false.");
    }
    if (!riddleRoomId) throw new Error("Internal error: riddle requested but no riddle room was built.");
    const deaths = (chronicle.notableDeaths ?? []).filter((d) => d.trim() !== "");
    const template = pick(rng, RIDDLE_TEMPLATES);
    let answer: string;
    let answerSource: string;
    if (template.answerKind === "death" && deaths.length > 0) {
      answer = deaths[0];
      answerSource = `chronicle.notableDeaths: ${answer}`;
    } else if (template.answerKind === "npc" && chronicle.keyNpcs.length > 0) {
      answer = chronicle.keyNpcs[0];
      answerSource = `chronicle.keyNpcs: ${answer}`;
    } else if (template.answerKind === "party" && chronicle.partyMembers.length > 0) {
      answer = chronicle.partyMembers[0];
      answerSource = `chronicle.partyMembers: ${answer}`;
    } else {
      // The template's preferred pool is empty — fall back to any chronicle name.
      answer = chronicleNames[0];
      answerSource = `chronicle: ${answer}`;
    }
    const question = fill(template.question, {
      answer,
      event: facts.length > 0 ? facts[0] : "the last battle",
      person: people.length > 0 ? people[0] : "the one who sent you here",
      place: name,
    });
    riddle = {
      id: "riddle", room: riddleRoomId, question, answer, answerSource,
      source: { kind: "chronicle", ref: answerSource },
    };
  }

  // --- intrigue beats: secrets composed from chronicle facts + NPCs, staged in chain rooms.
  const intrigue: IntrigueBeat[] = [];
  const intrigueRooms = [...plateRoomIds, ...(riddleRoomId ? [riddleRoomId] : [])];
  for (let i = 0; i < intrigueCount; i++) {
    const roomId = intrigueRooms[i % intrigueRooms.length];
    const room = rooms.find((r) => r.id === roomId)!;
    const npc = people.length > 0 ? people[i % people.length] : bossName;
    const fact = facts.length > 0 ? facts[i % facts.length] : "something the party did and half forgot";
    const secret = fill(pick(rng, INTRIGUE_TEMPLATES), { npc, fact, room: theRoom(room.name) });
    intrigue.push({
      id: `intrigue-${i + 1}`,
      beat: `A secret surfaces in ${theRoom(room.name)}`,
      room: roomId,
      npcs: [npc],
      secret,
      source: { kind: "chronicle", ref: `chronicle: ${fact}` },
    });
  }

  // --- storyline advances: one per thread (brief first, else the chronicle's open threads).
  const threads = (brief.storylineThreads ?? []).length > 0
    ? brief.storylineThreads!
    : chronicle.openThreads;
  const storylineRooms = [...plateRoomIds, ...(riddleRoomId ? [riddleRoomId] : []), "boss"];
  const storyline: StorylineAdvance[] = threads.map((thread, i) => {
    const roomId = storylineRooms[i % storylineRooms.length];
    const room = rooms.find((r) => r.id === roomId)!;
    const how = fill(pick(rng, STORYLINE_TEMPLATES), { room: theRoom(room.name), thread });
    return {
      id: `story-${i + 1}`,
      thread,
      how,
      room: roomId,
      source: {
        kind: (brief.storylineThreads ?? []).length > 0 ? "brief" : "chronicle",
        ref: (brief.storylineThreads ?? []).length > 0
          ? `brief.storylineThreads: ${thread}`
          : `chronicle.openThreads: ${thread}`,
      },
    };
  });

  const plan: FloorPlan = {
    version: 1,
    name,
    theme,
    partyLevel,
    seed,
    entryRoomId: "entry",
    bossRoomId: "boss",
    bossDoor,
    rooms,
    links,
    plates,
    riddle,
    encounters,
    intrigue,
    storyline,
    chronicleNames,
    locked: false,
  };
  const errors = validateFloorPlan(plan);
  if (errors.length > 0) {
    throw new Error(`Planned floor failed validation: ${errors.join(" | ")}`);
  }
  return plan;
}

// ---------------------------------------------------------------- validation

/** BFS over the links, optionally excluding one link (the boss door). */
function reachableFrom(
  plan: FloorPlan,
  startId: string,
  excludeLink?: FloorLink,
): Set<string> {
  const neighbours = new Map<string, Set<string>>();
  for (const room of plan.rooms) neighbours.set(room.id, new Set());
  const sameLink = (a: FloorLink, b: FloorLink): boolean =>
    a.from.room === b.from.room && a.from.wall === b.from.wall && a.from.at === b.from.at &&
    a.to.room === b.to.room && a.to.wall === b.to.wall && a.to.at === b.to.at;
  for (const link of plan.links) {
    if (excludeLink && sameLink(link, excludeLink)) continue;
    neighbours.get(link.from.room)!.add(link.to.room);
    neighbours.get(link.to.room)!.add(link.from.room);
  }
  const reached = new Set<string>([startId]);
  const queue = [startId];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const next of neighbours.get(cur) ?? []) {
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }
  return reached;
}

/**
 * Validate a floor plan. Returns every error found (empty = valid).
 * Checks: rooms exist and connect; the boss exists and is gated behind
 * its door (unreachable when the boss-door link is removed); every
 * puzzle/encounter/intrigue/storyline element traces to a source; the
 * riddle's answer is a chronicle name; the ambush is a cutscene.
 */
export function validateFloorPlan(plan: FloorPlan): string[] {
  const errors: string[] = [];
  const hasSource = (source: PlanSource | undefined, where: string): void => {
    if (!source || !source.ref?.trim()) errors.push(`${where} has no source — every element must trace to the brief or the chronicle.`);
  };
  if (plan.rooms.length === 0) errors.push("A floor needs at least one room.");
  const roomIds = new Set(plan.rooms.map((r) => r.id));
  if (plan.rooms.length !== roomIds.size) errors.push("Duplicate room ids in the plan.");
  const entry = plan.rooms.find((r) => r.id === plan.entryRoomId);
  if (!entry) errors.push(`Entry room "${plan.entryRoomId}" does not exist.`);
  const boss = plan.rooms.find((r) => r.id === plan.bossRoomId);
  if (!boss) errors.push(`Boss room "${plan.bossRoomId}" does not exist.`);
  for (const link of plan.links) {
    if (!roomIds.has(link.from.room)) errors.push(`Link names unknown room "${link.from.room}".`);
    if (!roomIds.has(link.to.room)) errors.push(`Link names unknown room "${link.to.room}".`);
    if (link.from.room === link.to.room) errors.push(`Link from room "${link.from.room}" to itself.`);
  }
  if (entry && boss) {
    const reached = reachableFrom(plan, plan.entryRoomId);
    const unreachable = plan.rooms.filter((r) => !reached.has(r.id)).map((r) => r.id);
    if (unreachable.length > 0) {
      errors.push(`Rooms unreachable from the entry: ${unreachable.join(", ")}.`);
    }
    // The boss door must gate the boss: without the boss-door link, the boss room is unreachable.
    // (Only the boss-door link is removed — a second link into the boss room is a bypass and must fail.)
    const withoutDoor = reachableFrom(plan, plan.entryRoomId, plan.bossDoor);
    if (withoutDoor.has(plan.bossRoomId)) {
      errors.push(`Boss room "${plan.bossRoomId}" is reachable without its door — the plate puzzle must gate it.`);
    }
  }
  // Plates: rooms exist, effects distinct, all unlock the boss door.
  if (!plan.plates) {
    errors.push("The plan has no pressure-plate puzzle.");
  } else {
    hasSource(plan.plates.source, "Plate puzzle");
    if (plan.plates.plates.length === 0) errors.push("The plate puzzle has no plates.");
    const effects = new Set<string>();
    for (const plate of plan.plates.plates) {
      if (!roomIds.has(plate.room)) errors.push(`Plate names unknown room "${plate.room}".`);
      if (effects.has(plate.effect)) errors.push(`Two plates have the same effect ("${plate.effect}") — each plate must do something distinct.`);
      effects.add(plate.effect);
    }
    const bossDoor = plan.bossDoor;
    if (plan.plates.unlocks.from.room !== bossDoor.from.room || plan.plates.unlocks.to.room !== bossDoor.to.room) {
      errors.push("The plate puzzle does not unlock the boss door.");
    }
  }
  // Riddle: answer is a chronicle name.
  if (plan.riddle) {
    hasSource(plan.riddle.source, "Riddle");
    if (!roomIds.has(plan.riddle.room)) errors.push(`Riddle names unknown room "${plan.riddle.room}".`);
    if (!plan.chronicleNames.includes(plan.riddle.answer)) {
      errors.push(`Riddle answer "${plan.riddle.answer}" is not a chronicle name — the answer must be someone or something the party already knows.`);
    }
  }
  // Encounters: rooms exist, sources present, exactly one boss in the boss room, ambushes are cutscenes.
  const bossEncounters = plan.encounters.filter((e) => e.kind === "boss");
  if (bossEncounters.length !== 1) errors.push(`The plan needs exactly one boss encounter (found ${bossEncounters.length}).`);
  for (const enc of plan.encounters) {
    hasSource(enc.source, `Encounter "${enc.id}"`);
    if (!roomIds.has(enc.room)) errors.push(`Encounter "${enc.id}" names unknown room "${enc.room}".`);
    if (enc.kind === "boss" && enc.room !== plan.bossRoomId) {
      errors.push(`Boss encounter "${enc.id}" is not in the boss room.`);
    }
    if (enc.kind === "ambush") {
      if (!enc.cutscene) errors.push(`Ambush encounter "${enc.id}" is not flagged as a cutscene.`);
      if (!enc.cutsceneScript) errors.push(`Ambush encounter "${enc.id}" has no cutscene script.`);
    }
    if (enc.spec.npcs.length === 0) errors.push(`Encounter "${enc.id}" has no NPCs.`);
  }
  for (const beat of plan.intrigue) {
    hasSource(beat.source, `Intrigue beat "${beat.id}"`);
    if (!roomIds.has(beat.room)) errors.push(`Intrigue beat "${beat.id}" names unknown room "${beat.room}".`);
  }
  for (const adv of plan.storyline) {
    hasSource(adv.source, `Storyline advance "${adv.id}"`);
    if (!roomIds.has(adv.room)) errors.push(`Storyline advance "${adv.id}" names unknown room "${adv.room}".`);
    if (!adv.thread?.trim()) errors.push(`Storyline advance "${adv.id}" has no thread.`);
  }
  return errors;
}

// ---------------------------------------------------------------- preview (the convergence loop)

/** Room positions for the ASCII map: chain rooms go east, branches go north/south of their parent. */
function previewPositions(plan: FloorPlan): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  pos.set(plan.entryRoomId, { x: 0, y: 0 });
  // Chain first (rooms whose branchOf is the previous chain room, in plan order).
  const chain = [plan.entryRoomId];
  let cur = plan.entryRoomId;
  for (const room of plan.rooms) {
    if (room.branchOf === cur && (room.purpose === "plate" || room.purpose === "riddle" || room.purpose === "boss")) {
      pos.set(room.id, { x: pos.get(cur)!.x + 1, y: pos.get(cur)!.y });
      chain.push(room.id);
      cur = room.id;
    }
  }
  // Branches: encounter rooms hang north/south of their attach room, alternating.
  let branchSide = -1;
  for (const room of plan.rooms) {
    if (pos.has(room.id)) continue;
    const parent = pos.get(room.branchOf ?? "") ?? { x: 0, y: 0 };
    pos.set(room.id, { x: parent.x, y: parent.y + branchSide });
    branchSide = -branchSide;
  }
  return pos;
}

/**
 * Render the convergence-loop preview: an ASCII layout sketch of the
 * rooms + links, then one paragraph per beat (puzzle, riddle,
 * encounter, intrigue, storyline). Plain text, no Foundry writes —
 * this is what Muse shows the creator to gauge interest before
 * building anything.
 */
export function renderFloorPreview(plan: FloorPlan): string {
  const pos = previewPositions(plan);
  const CELL_W = 18;
  const CELL_H = 5;
  const GAP_X = 3;
  const GAP_Y = 2;
  let maxX = 0;
  let maxY = 0;
  let minY = 0;
  for (const p of pos.values()) {
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
    minY = Math.min(minY, p.y);
  }
  const rows = (maxY - minY + 1) * (CELL_H + GAP_Y);
  const cols = (maxX + 1) * (CELL_W + GAP_X);
  const canvas: string[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => " "));
  const put = (x: number, y: number, ch: string): void => {
    if (y >= 0 && y < rows && x >= 0 && x < cols) canvas[y][x] = ch;
  };
  const putStr = (x: number, y: number, s: string): void => {
    for (let i = 0; i < s.length; i++) put(x + i, y, s[i]);
  };
  const boxAt = (room: FloorRoom): { x: number; y: number } => {
    const p = pos.get(room.id)!;
    return { x: p.x * (CELL_W + GAP_X), y: (p.y - minY) * (CELL_H + GAP_Y) };
  };
  for (const room of plan.rooms) {
    const { x, y } = boxAt(room);
    const label = room.name.length > CELL_W - 2 ? room.name.slice(0, CELL_W - 5) + "..." : room.name;
    putStr(x, y, "+" + "-".repeat(CELL_W - 2) + "+");
    putStr(x, y + 1, `| ${label.padEnd(CELL_W - 4)} |`);
    putStr(x, y + 2, `| ${room.purpose.padEnd(CELL_W - 4)} |`);
    putStr(x, y + 3, `| ${room.id.padEnd(CELL_W - 4)} |`);
    putStr(x, y + 4, "+" + "-".repeat(CELL_W - 2) + "+");
  }
  for (const link of plan.links) {
    const a = plan.rooms.find((r) => r.id === link.from.room)!;
    const b = plan.rooms.find((r) => r.id === link.to.room)!;
    const pa = boxAt(a);
    const pb = boxAt(b);
    const midRow = pa.y + 2;
    if (pa.y === pb.y) {
      // Horizontal link: fill the gap with dashes at the box middle row.
      const [left, right] = pa.x < pb.x ? [pa, pb] : [pb, pa];
      for (let x = left.x + CELL_W; x < right.x; x++) put(x, midRow, "-");
    } else {
      // Vertical link: a pipe through the gap at the box middle column.
      const midCol = pa.x + Math.floor(CELL_W / 2);
      const top = Math.min(pa.y, pb.y);
      const bottom = Math.max(pa.y, pb.y);
      for (let y = top + CELL_H; y < bottom; y++) put(midCol, y, "|");
    }
  }
  const sketch = canvas.map((row) => row.join("").replace(/\s+$/, "")).join("\n");

  const lines: string[] = [
    `🗺️ **${plan.name}** — ${plan.theme} floor, party level ${plan.partyLevel}`,
    "",
    sketch,
    "",
    `Rooms: ${plan.rooms.map((r) => `${r.name} (${r.purpose})`).join(" → ")}`,
    "",
  ];
  const beat = (heading: string, paragraph: string): void => {
    lines.push(`### ${heading}`, "", paragraph, "");
  };
  beat(
    `Puzzle — ${plan.plates.kind} (${plan.plates.plates.length} plates)`,
    `${plan.plates.plates.map((p) => {
      const room = plan.rooms.find((r) => r.id === p.room)!;
      return `${inRoom(room.name)}, a pressure plate ${p.effect}. ${p.detail}`;
    }).join(" ")} All ${plan.plates.plates.length} plates together unlock the door to ${theRoom(plan.rooms.find((r) => r.id === plan.bossRoomId)!.name)} — no plate alone opens it, and the door stays shut until the last one is pressed.`,
  );
  if (plan.riddle) {
    const room = plan.rooms.find((r) => r.id === plan.riddle!.room)!;
    beat(
      `Riddle — the ${room.name}`,
      `${inRoom(room.name)}, a voice asks: ${plan.riddle.question} The answer is a name the party already knows — ${plan.riddle.answer} — drawn from the campaign chronicle, not invented for this floor.`,
    );
  }
  for (const enc of plan.encounters) {
    const room = plan.rooms.find((r) => r.id === enc.room)!;
    const names = enc.spec.npcs.map((n) => `${n.name} (${n.role})`).join(", ");
    if (enc.kind === "ambush") {
      beat(
        `Ambush — ${room.name}`,
        `The party walks into ${theRoom(room.name)} and the trap springs: ${names} appear in a ring around them, spears levelled, no words, no warning. This one plays as a cutscene — the formation, the entrance, and the narration are scripted, so it lands in seconds instead of being placed one token at a time.`,
      );
    } else if (enc.kind === "boss") {
      beat(
        `Boss battle — ${room.name}`,
        `${inRoom(room.name)}, the floor's boss waits: ${names}. ${enc.spec.npcs[0].oneLiner ?? ""} This is the fight the whole floor has been building toward, and the treasure in the room is budgeted for it.`,
      );
    } else {
      beat(
        `Minor encounter — ${room.name}`,
        `${inRoom(room.name)}, the party meets ${names}. A straight fight — no tricks, just the floor reminding them it is occupied.`,
      );
    }
  }
  for (const beatItem of plan.intrigue) {
    const room = plan.rooms.find((r) => r.id === beatItem.room)!;
    beat(
      `Intrigue — ${room.name}`,
      `${beatItem.beat}. ${beatItem.secret} The party learns something that complicates what they thought they knew — and it traces back to the chronicle, not to a new invention.`,
    );
  }
  for (const adv of plan.storyline) {
    beat(`Storyline — “${adv.thread}”`, adv.how);
  }
  lines.push("---", `Locked: ${plan.locked ? "yes" : "no — show this to the creator first, converge, then lock."}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- locking (manifest, not execution)

/**
 * Lock a plan and produce the build manifest: the ordered list of
 * existing-builder calls the locked plan maps to. The manifest is DATA
 * — the live wiring (calling the builders against a real Foundry) is a
 * later step and is NOT built here.
 */
export function lockFloorPlan(plan: FloorPlan): LockedFloorPlan {
  if (plan.locked) throw new Error(`Floor plan "${plan.name}" is already locked.`);
  const errors = validateFloorPlan(plan);
  if (errors.length > 0) {
    throw new Error(`Cannot lock an invalid floor plan: ${errors.join(" | ")}`);
  }
  const manifest: BuildStep[] = [];
  let order = 0;
  const step = (tool: string, args: Record<string, unknown>, note: string): void => {
    manifest.push({ order: order++, tool, args, note });
  };
  step("uploadTilePack", {}, "Tile pack must be in the world before any room is built.");
  // The dungeon graph: rooms + links as a DungeonSpec (doors already declared to match the links).
  step(
    "buildDungeon",
    {
      dungeon: {
        rooms: plan.rooms.map((r) => ({
          id: r.id, name: r.name, gridW: r.gridW, gridH: r.gridH,
          doors: r.doors, floorStyle: r.purpose === "boss" ? "dark" : "mixed",
        })),
        links: plan.links,
      },
    },
    `Build ${plan.rooms.length} rooms as tile-room scenes, linked by the dungeon graph.`,
  );
  for (const plate of plan.plates.plates) {
    const room = plan.rooms.find((r) => r.id === plate.room)!;
    step(
      "trap",
      { room: plate.room, effect: plate.effect, detail: plate.detail, unlocks: plan.plates.unlocks },
      `Pressure plate in ${theRoom(room.name)}: ${plate.effect}.`,
    );
  }
  if (plan.riddle) {
    const room = plan.rooms.find((r) => r.id === plan.riddle!.room)!;
    step(
      "send",
      { content: plan.riddle.question, room: plan.riddle.room },
      `Riddle reveal in the ${room.name} (answer: ${plan.riddle.answer} — GM-side, not shown to players).`,
    );
  }
  // Encounters in room order: chain order first, then the boss.
  const chainOrder = new Map(plan.rooms.map((r, i) => [r.id, i]));
  const ordered = [...plan.encounters].sort((a, b) => {
    if (a.kind === "boss") return 1;
    if (b.kind === "boss") return -1;
    return (chainOrder.get(a.room) ?? 0) - (chainOrder.get(b.room) ?? 0);
  });
  for (const enc of ordered) {
    const room = plan.rooms.find((r) => r.id === enc.room)!;
    if (enc.kind === "ambush" && enc.cutsceneScript) {
      step(
        "cutscene",
        { script: enc.cutsceneScript, room: enc.room },
        `Ambush cutscene in ${theRoom(room.name)} — ring formation + narration.`,
      );
    } else {
      step(
        "encounter-gen",
        { spec: enc.spec, room: enc.room },
        `${enc.kind === "boss" ? "Boss" : "Minor"} encounter in ${theRoom(room.name)}: ${enc.spec.npcs.map((n) => n.name).join(", ")}.`,
      );
    }
    if (enc.kind === "boss") {
      step(
        "treasure",
        { budgetGp: 500, level: plan.partyLevel, room: enc.room, theme: plan.theme },
        `Boss-room hoard for ${theRoom(room.name)} (value-budgeted treasure).`,
      );
    }
  }
  for (const beatItem of plan.intrigue) {
    step(
      "journal",
      { title: beatItem.beat, content: beatItem.secret, room: beatItem.room },
      `Intrigue beat (GM notes): ${beatItem.beat}. Live journal layer pending.`,
    );
  }
  for (const adv of plan.storyline) {
    step(
      "journal",
      { title: `Storyline: ${adv.thread}`, content: adv.how, room: adv.room },
      `Storyline advance (GM notes): “${adv.thread}”. Live journal layer pending.`,
    );
  }
  return { plan: { ...plan, locked: true }, manifest };
}
