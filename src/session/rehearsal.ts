/**
 * Dress-rehearsal runner harness (BRA-238): "go and check it" runs
 * the live-test suite and reports breakage.
 *
 * The vision doc (Act Seven) and docs/agent-coordination.md say the
 * rehearsal is what the Muses run after a Foundry upgrade or a big
 * MuseGM change: the live-test checklists in BACKLOG.md, executed
 * end to end, each ending pass or fail with the failure evidence, no
 * GM present and no spoon-feeding. Today that is a manual process —
 * the Muses run the checklists by hand. This module is the harness
 * that replaces the hand-run with one command.
 *
 * Shape:
 * - A rehearsal is a list of checks (`defaultRehearsalChecks`).
 *   Each check covers one BACKLOG live-checklist item, named in its
 *   `backlog` field, so a failure maps straight to the item it broke.
 * - `offline` checks run with no connection at all: they exercise
 *   the same logic the live checklist exercises, against the pure
 *   functions (layout, validation, expansion, the build loop, the
 *   dressing planner, the treasure fitter, the rule lookup over the
 *   demo corpus). They prove the code; they do not pretend to prove
 *   the server.
 * - `live` checks run only with a real connection (`ctx.live`).
 *   Without one they are SKIPPED — never reported as a pass, never
 *   faked. A live check's `runLive` calls the same live function the
 *   checklist names (uploadTilePack, buildDressedTileRoom,
 *   playCutscene, lookupRuleLive, addQuestLive, rollForChat,
 *   createCustomEncounter, importPackActor).
 * - `manual` checks need a human eye or hand at the table (click a
 *   torch in the Foundry client, watch a token move in two browsers,
 *   whisper mid-session, run a combat round). They carry the exact
 *   steps in `manualSteps` and report as `manual` — a fourth status,
 *   counted separately, never as a pass. The harness automates what
 *   is automatable and names what is not, instead of pretending.
 *
 * Honesty rules, enforced by the runner:
 * - A failure carries its evidence (the error message, expected vs
 *   actual) — never just "failed".
 * - A skip carries its precondition — the exact live setup the check
 *   needs (which server, which world, what the GM must have done).
 * - The exit code is non-zero iff any check failed. Skips and manual
 *   checks do not fail the run; they are reported, not hidden.
 * - Live checks never run against a fake live. The fake in
 *   tests/rehearsal.test.ts exists only to prove the harness itself
 *   (the runner, the statuses, the report) — the checks' live paths
 *   are exercised only against the real server, when it is up.
 *
 * Run: bun run src/cli/rehearsal.ts --list | --run [--json] | --check <id>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { FoundryLive } from "../live.js";
import {
  layoutDungeon,
  layoutRoom,
  loadPack,
  recordCutsceneProp,
  type DungeonSpec,
  type Pack,
  type RoomSpec,
} from "../worldbuilding/tiles-layout.js";
import { generateMaze, mazeFloorCells, mazeReachableFrom } from "../worldbuilding/maze.js";
import { expandCutscene, playCutscene, validateCutscene } from "./cutscene.js";
import { BuildSession, parseBuildRequest } from "./build-loop.js";
import { planDressing, toggleDressing } from "./dressing.js";
import { generateEncounter, createCustomEncounter, type EncounterSpec } from "./encounter-gen.js";
import { demoLookup, lookupRuleLive } from "./rules.js";
import { parseRollRequest, rollForChat } from "./dice.js";
import { addNote, addQuest, completeQuest, emptyQuestLog, addQuestLive } from "./questlog.js";
import { advanceClocksToRound, createClock, emptyClockStore } from "./clocks.js";
import { generateTreasure, treasureValueGp } from "./treasure.js";
import { getWorldPacks, importPackActor, searchPackIndex } from "./compendium.js";

export const REHEARSAL_SERVER_BASE = "worlds/testbed";
export const REHEARSAL_WORLD = "TestBed";
export const REHEARSAL_SERVER_PRECONDITION =
  "Dave's Foundry server is up (it is session-only — Brandon or Dave says when), the TestBed world is loaded, and Muse is connected as mcp-api.";

/** What a check found: pass/fail plus the evidence, never just a verdict. */
export interface CheckEvidence {
  passed: boolean;
  /** What was checked and the numbers — the evidence, not a label. */
  evidence: string;
  /** Structured evidence for --json (counts, ids, expected/actual). */
  detail?: Record<string, unknown>;
}

export interface RehearsalContext {
  pack: Pack;
  serverBase: string;
  /** Present only for a live run. Live checks without it are skipped. */
  live?: FoundryLive;
}

export type RehearsalCheckKind = "offline" | "live";

export interface RehearsalCheck {
  id: string;
  title: string;
  /** The BACKLOG item (with its issue key where one exists) this covers. */
  backlog: string;
  kind: RehearsalCheckKind;
  /** Exact live setup, for live checks: server, world, what must exist. */
  precondition?: string;
  /** For live checks that need a human eye/hand: the steps, in order. */
  manualSteps?: string[];
  /** Offline checks, and live checks with a live connection, run this. */
  run?: (ctx: RehearsalContext) => Promise<CheckEvidence> | CheckEvidence;
  /** Live checks run this when ctx.live is present and manualSteps is absent. */
  runLive?: (ctx: RehearsalContext & { live: FoundryLive }) => Promise<CheckEvidence> | CheckEvidence;
}

export type RehearsalStatus = "pass" | "fail" | "skip" | "manual";

export interface RehearsalCheckResult {
  id: string;
  title: string;
  backlog: string;
  kind: RehearsalCheckKind;
  status: RehearsalStatus;
  /** The evidence (pass/fail), the precondition (skip), or the steps (manual). */
  evidence: string;
  detail?: Record<string, unknown>;
}

export interface RehearsalReport {
  title: string;
  startedAt: string;
  finishedAt: string;
  ms: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  manual: number;
  results: RehearsalCheckResult[];
}

/** A check result is a pass only when its evidence says it passed. */
export function checkResultFor(
  check: RehearsalCheck,
  evidence: CheckEvidence,
): RehearsalCheckResult {
  return {
    id: check.id,
    title: check.title,
    backlog: check.backlog,
    kind: check.kind,
    status: evidence.passed ? "pass" : "fail",
    evidence: evidence.evidence,
    detail: evidence.detail,
  };
}

/**
 * Run the checks in order, recording one result per check. A check
 * whose run throws fails with the error message as its evidence — a
 * crash is a failure with a reason, never a missing result. Live
 * checks without a connection are skipped with their precondition;
 * manual live checks report as manual with their steps.
 */
export async function runRehearsal(
  checks: RehearsalCheck[],
  ctx: RehearsalContext,
): Promise<RehearsalReport> {
  const started = Date.now();
  const results: RehearsalCheckResult[] = [];
  for (const check of checks) {
    if (check.kind === "live" && !ctx.live) {
      results.push({
        id: check.id,
        title: check.title,
        backlog: check.backlog,
        kind: check.kind,
        status: "skip",
        evidence: check.precondition ?? REHEARSAL_SERVER_PRECONDITION,
      });
      continue;
    }
    if (check.kind === "live" && check.manualSteps) {
      results.push({
        id: check.id,
        title: check.title,
        backlog: check.backlog,
        kind: check.kind,
        status: "manual",
        evidence: `Needs a human eye/hand at the table:\n${check.manualSteps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`,
      });
      continue;
    }
    try {
      const fn = check.kind === "live" ? check.runLive : check.run;
      if (!fn) {
        throw new Error(`Check "${check.id}" has no run function for a ${check.kind} run.`);
      }
      const evidence = await fn(ctx as RehearsalContext & { live: FoundryLive });
      results.push(checkResultFor(check, evidence));
    } catch (err) {
      results.push({
        id: check.id,
        title: check.title,
        backlog: check.backlog,
        kind: check.kind,
        status: "fail",
        evidence: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const finished = Date.now();
  const count = (s: RehearsalStatus): number => results.filter((r) => r.status === s).length;
  return {
    title: "MuseGM dress rehearsal",
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    ms: finished - started,
    total: results.length,
    passed: count("pass"),
    failed: count("fail"),
    skipped: count("skip"),
    manual: count("manual"),
    results,
  };
}

/** Plain-text report: one line per check, evidence under failures. */
export function renderRehearsalReport(report: RehearsalReport): string {
  const lines: string[] = [
    `${report.title} — ${report.passed} pass, ${report.failed} fail, ${report.skipped} skip, ${report.manual} manual (of ${report.total}, ${report.ms} ms)`,
    "",
  ];
  for (const r of report.results) {
    const mark =
      r.status === "pass" ? "PASS" : r.status === "fail" ? "FAIL" : r.status === "skip" ? "SKIP" : "MANUAL";
    lines.push(`[${mark}] ${r.id} — ${r.title} (${r.backlog})`);
    if (r.status === "fail") lines.push(`      ${r.evidence}`);
    if (r.status === "skip") lines.push(`      needs: ${r.evidence}`);
    if (r.status === "manual") {
      for (const line of r.evidence.split("\n")) lines.push(`      ${line}`);
    }
  }
  if (report.failed > 0) {
    lines.push("");
    lines.push(`${report.failed} check(s) failed — fix them (or file them) and re-run.`);
  }
  return lines.join("\n");
}

/** The same report as plain JSON (for --json and for filing failures). */
export function rehearsalReportToJson(report: RehearsalReport): Record<string, unknown> {
  return { ...report };
}

// ---------------------------------------------------------------- helpers

function fail(evidence: string, detail?: Record<string, unknown>): CheckEvidence {
  return { passed: false, evidence, detail };
}

function pass(evidence: string, detail?: Record<string, unknown>): CheckEvidence {
  return { passed: true, evidence, detail };
}

/** Read a PNG's pixel size from its IHDR chunk (no image library). */
export function pngSizePx(file: string): { w: number; h: number } {
  const buf = fs.readFileSync(file);
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error(`${file} is not a PNG.`);
  }
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** The rehearsal's room: 8x6 Entry Hall, south door, seed 1. */
function entryHall(): RoomSpec {
  return { name: "Entry Hall", gridW: 8, gridH: 6, seed: 1, doors: [{ wall: "south", at: 3 }] };
}

function ambushPath(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../examples/ambush.json");
}

function tilesDir(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../tiles");
}

/**
 * Lazy load of the live builders: worldbuilding/tiles.ts pulls in the
 * vendored MCP client (via upload.ts), which validates FOUNDRY_URL at
 * import time — so it loads only inside a live run, after the
 * connection is already established (or the run would have failed
 * honestly at connect). The offline checks never touch it, and the
 * offline CLI stays usable with no env vars at all.
 */
async function liveBuilders(): Promise<typeof import("../worldbuilding/tiles.js")> {
  return await import("../worldbuilding/tiles.js");
}

/** The encounter the live checks build (same as cli/encounter-gen.ts --demo). */
function rehearsalEncounterSpec(): EncounterSpec {
  return {
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
}

// ---------------------------------------------------------------- offline checks

const OFFLINE_CHECKS: RehearsalCheck[] = [
  {
    id: "pack-complete",
    title: "Tile pack is complete: 48 tiles, 0 gaps, every PNG on disk",
    backlog: "BRA-181 tile pack + composer",
    kind: "offline",
    run: (ctx) => {
      const manifestPath = path.join(tilesDir(), "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        tiles: { name: string; file: string; sizePx: number; kind: string }[];
        gaps: string[];
      };
      if (manifest.gaps.length > 0) {
        return fail(`Pack has ${manifest.gaps.length} tile gap(s): ${manifest.gaps.join(", ")}.`, {
          tiles: manifest.tiles.length,
          gaps: manifest.gaps,
        });
      }
      const byKind: Record<string, number> = {};
      for (const t of manifest.tiles) {
        byKind[t.kind] = (byKind[t.kind] ?? 0) + 1;
        const file = path.join(tilesDir(), t.file);
        if (!fs.existsSync(file)) return fail(`Tile "${t.name}" is missing on disk: ${t.file}.`, { tile: t.name });
        const { w, h } = pngSizePx(file);
        if (w !== t.sizePx || h !== t.sizePx) {
          return fail(`Tile "${t.name}" is ${w}x${h}px, manifest says ${t.sizePx}px.`, {
            tile: t.name,
            actual: `${w}x${h}`,
            expected: `${t.sizePx}x${t.sizePx}`,
          });
        }
      }
      if (manifest.tiles.length !== ctx.pack.size) {
        return fail(`Manifest lists ${manifest.tiles.length} tiles, loaded pack has ${ctx.pack.size}.`, {
          manifest: manifest.tiles.length,
          loaded: ctx.pack.size,
        });
      }
      return pass(
        `Pack complete: ${manifest.tiles.length} tiles, 0 gaps (base ${byKind["base"] ?? 0}, prop ${byKind["prop"] ?? 0}, macro ${byKind["macro"] ?? 0}), every PNG on disk at its declared size.`,
        { tiles: manifest.tiles.length, gaps: 0, kinds: byKind },
      );
    },
  },
  {
    id: "tile-room-layout",
    title: "Room composer lays out an 8x6 hall: 48 floor tiles, wall ring, door",
    backlog: "BRA-181 tile pack + composer",
    kind: "offline",
    run: (ctx) => {
      const spec = entryHall();
      const a = layoutRoom(spec, ctx.pack, ctx.serverBase);
      const b = layoutRoom(spec, ctx.pack, ctx.serverBase);
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        return fail("layoutRoom is not deterministic: the same spec laid out twice differs.");
      }
      const floors = a.tiles.filter((t) => t.sort === 0);
      if (floors.length !== 48) {
        return fail(`Expected 48 floor tiles for an 8x6 room, got ${floors.length}.`, {
          expected: 48,
          actual: floors.length,
        });
      }
      if (a.walls.length === 0) return fail("No collision walls in the layout — the room has no ring.");
      const door = a.tiles.find((t) => (t.texture.src ?? "").includes("door"));
      if (!door) return fail("No door tile in the layout for a room with a south door.");
      return pass(
        `8x6 Entry Hall lays out deterministically: ${floors.length} floor tiles, ${a.walls.length} collision walls, door tile present (${a.tiles.length} tiles total).`,
        { floorTiles: floors.length, walls: a.walls.length, tiles: a.tiles.length },
      );
    },
  },
  {
    id: "dungeon-graph-links",
    title: "Dungeon graph links two rooms through a door, both ways",
    backlog: "BRA-182 dungeon graph",
    kind: "offline",
    run: (ctx) => {
      const spec: DungeonSpec = {
        rooms: [
          { ...entryHall(), id: "hall" },
          { name: "Crypt", gridW: 6, gridH: 6, seed: 2, id: "crypt", doors: [{ wall: "north", at: 2 }] },
        ],
        links: [{ from: { room: "hall", wall: "south", at: 3 }, to: { room: "crypt", wall: "north", at: 2 } }],
      };
      const dungeon = layoutDungeon(spec, ctx.pack, ctx.serverBase);
      if (dungeon.rooms.length !== 2) {
        return fail(`Expected 2 rooms in the dungeon layout, got ${dungeon.rooms.length}.`, {
          expected: 2,
          actual: dungeon.rooms.length,
        });
      }
      if (dungeon.links.length !== 1) {
        return fail(`Expected 1 resolved door link, got ${dungeon.links.length}.`, {
          expected: 1,
          actual: dungeon.links.length,
        });
      }
      const link = dungeon.links[0];
      const rooms = new Set(dungeon.rooms.map((r) => r.id));
      if (!rooms.has(link.from.room) || !rooms.has(link.to.room)) {
        return fail(`Door link names a room that is not in the dungeon: ${link.from.room} -> ${link.to.room}.`);
      }
      return pass(
        `Dungeon graph: 2 rooms, 1 door link (${link.from.room} south@3 <-> ${link.to.room} north@2), no stairs.`,
        { rooms: 2, links: 1 },
      );
    },
  },
  {
    id: "maze-connected",
    title: "Maze generator carves a fully connected 5x5 maze",
    backlog: "BRA-183 maze + overlays",
    kind: "offline",
    run: () => {
      const maze = generateMaze(5, 5, 7);
      const floor = mazeFloorCells(maze);
      const reached = mazeReachableFrom(maze, maze.entrance);
      if (reached.size !== floor.length) {
        return fail(`Maze is not fully connected: ${reached.size} of ${floor.length} floor cells reachable from the entrance.`, {
          expected: floor.length,
          actual: reached.size,
        });
      }
      if (!reached.has(`${maze.exit.gx},${maze.exit.gy}`)) {
        return fail("The maze exit is not reachable from the entrance.");
      }
      return pass(`5x5 maze (seed 7): all ${floor.length} floor cells reachable from the entrance, exit included.`, {
        floorCells: floor.length,
        reachable: reached.size,
      });
    },
  },
  {
    id: "ambush-script",
    title: "Ambush cutscene validates and expands to 51 steps",
    backlog: "BRA-184 cutscene ambush (FR-5)",
    kind: "offline",
    run: () => {
      const input = JSON.parse(fs.readFileSync(ambushPath(), "utf8")) as unknown;
      const validated = validateCutscene(input);
      if (!validated.ok) {
        return fail(`examples/ambush.json does not validate:\n- ${validated.errors.join("\n- ")}`, {
          errors: validated.errors,
        });
      }
      const steps = expandCutscene(validated.script, { centerOf: () => ({ x: 800, y: 800 }) });
      if (steps.length !== 51) {
        return fail(`Ambush expands to ${steps.length} steps, expected 51.`, {
          expected: 51,
          actual: steps.length,
        });
      }
      return pass(`Ambush script validates and expands to ${steps.length} steps (9 soldiers, spears, mage, light bloom).`, {
        steps: steps.length,
      });
    },
  },
  {
    id: "cutscene-named-light",
    title: "Cutscene light step accepts {name} for a whole group",
    backlog: "BRA-239 cutscene light {name}",
    kind: "offline",
    run: () => {
      const validated = validateCutscene({
        name: "rehearsal-lights",
        version: 1,
        steps: [{ kind: "light", light: { name: "the braziers" }, dim: 0, bright: 0, durationMs: 1000 }],
      });
      if (!validated.ok) {
        return fail(`Named light step does not validate:\n- ${validated.errors.join("\n- ")}`, {
          errors: validated.errors,
        });
      }
      const bad = validateCutscene({
        name: "rehearsal-lights-bad",
        version: 1,
        steps: [{ kind: "light", light: { name: "the braziers", id: "x" }, dim: 0, durationMs: 1000 }],
      });
      if (bad.ok) {
        return fail("A light step with both {name} and {id} validated — exactly one selector is required.");
      }
      return pass("Named light step validates; {name}+{id} together is rejected, as specified.", {});
    },
  },
  {
    id: "cutscene-prop-record",
    title: "Cutscene prop is recorded in the room spec and survives a rebuild",
    backlog: "BRA-242 cutscene prop recording",
    kind: "offline",
    run: (ctx) => {
      const spec = entryHall();
      const first = recordCutsceneProp(spec, { src: "worlds/testbed/bones.png", x: 200, y: 300 }, ctx.pack);
      if (!first.recorded) {
        return fail(`Bones prop was not recorded: ${first.note ?? "no reason given"}.`);
      }
      const dressing = first.spec.dressing ?? [];
      if (dressing.length !== 1 || dressing[0].tile !== "bones") {
        return fail(`Recorded spec holds ${dressing.length} prop(s), expected 1 bones prop.`, {
          expected: 1,
          actual: dressing.length,
        });
      }
      const replay = recordCutsceneProp(first.spec, { src: "worlds/testbed/bones.png", x: 200, y: 300 }, ctx.pack);
      if (replay.recorded || (replay.spec.dressing ?? []).length !== 1) {
        return fail("Re-playing the same prop recorded it a second time — dedupe failed.");
      }
      return pass(`Bones prop recorded at (2,3) as ${dressing[0].id ?? "a prop"}; re-play dedupes, spec still holds 1 prop.`, {
        props: 1,
        deduped: true,
      });
    },
  },
  {
    id: "build-loop-move-prop",
    title: "Chat build loop moves a prop, and undo puts it back",
    backlog: "BRA-241 build-loop move/remove-prop",
    kind: "offline",
    run: (ctx) => {
      const session = new BuildSession();
      const say = (text: string): string => {
        const parsed = parseBuildRequest(text, { room: session.activeRoomSpec() ?? undefined });
        if (!parsed || parsed.kind !== "build") {
          throw new Error(`"${text}" did not parse as a build op (got ${parsed?.kind ?? "null"}).`);
        }
        if (parsed.op.type === "undo") {
          const entry = session.undo();
          if (!entry) throw new Error("Nothing to undo.");
          return entry.summary;
        }
        if (parsed.op.type === "redo") {
          const entry = session.redo();
          if (!entry) throw new Error("Nothing to redo.");
          return entry.summary;
        }
        return session.apply(parsed.op, text, { pack: ctx.pack }).summary;
      };
      say("build an 8x6 entry hall with a south door");
      say("add some bones");
      const before = session.activeRoomSpec();
      const bonesBefore = (before?.dressing ?? []).find((p) => p.tile === "bones");
      if (!bonesBefore) return fail("add-dressing did not place a bones prop in the room.");
      const moved = say("move the bones to the middle");
      const after = session.activeRoomSpec();
      const bonesAfter = (after?.dressing ?? []).find((p) => p.tile === "bones");
      if (!bonesAfter || (bonesAfter.gx === bonesBefore.gx && bonesAfter.gy === bonesBefore.gy)) {
        return fail(`"move the bones to the middle" did not move the prop (${moved}).`, {
          from: `(${bonesBefore.gx},${bonesBefore.gy})`,
          to: bonesAfter ? `(${bonesAfter.gx},${bonesAfter.gy})` : "gone",
        });
      }
      say("undo that");
      const undone = session.activeRoomSpec();
      const bonesUndone = (undone?.dressing ?? []).find((p) => p.tile === "bones");
      if (!bonesUndone || bonesUndone.gx !== bonesBefore.gx || bonesUndone.gy !== bonesBefore.gy) {
        return fail("Undo did not return the bones to their original cell.", {
          expected: `(${bonesBefore.gx},${bonesBefore.gy})`,
          actual: bonesUndone ? `(${bonesUndone.gx},${bonesUndone.gy})` : "gone",
        });
      }
      return pass(
        `Build loop: bones placed at (${bonesBefore.gx},${bonesBefore.gy}), moved to (${bonesAfter.gx},${bonesAfter.gy}), undo restored them.`,
        { from: `(${bonesBefore.gx},${bonesBefore.gy})`, to: `(${bonesAfter.gx},${bonesAfter.gy})` },
      );
    },
  },
  {
    id: "dressing-toggle",
    title: "Dressing pass plans 14 items and a torch toggles off and on",
    backlog: "BRA-192 interactive dressing (FR-16)",
    kind: "offline",
    run: () => {
      const spec: RoomSpec = { name: "Test Room", gridW: 8, gridH: 8, seed: 1 };
      const plan = planDressing(spec, {});
      if (plan.items.length !== 14) {
        return fail(`Dressing plan has ${plan.items.length} items, expected 14 (8 torches + 4 braziers + 2 candles).`, {
          expected: 14,
          actual: plan.items.length,
        });
      }
      if (plan.tileGaps.length > 0) {
        return fail(`Dressing plan has tile gaps: ${plan.tileGaps.join(", ")} — the hook never builds what it cannot draw.`, {
          gaps: plan.tileGaps,
        });
      }
      const torch = plan.items.find((i) => i.kind === "torch");
      if (!torch) return fail("No torch in the dressing plan.");
      const off = toggleDressing(torch, "unlit");
      if (off.update.hidden !== true || off.update["config.alpha"] !== 0 || !off.chatLine) {
        return fail(`Putting the torch out did not hide it + zero its alpha (got ${JSON.stringify(off.update)}).`, {
          update: off.update,
        });
      }
      const on = toggleDressing(torch, "lit");
      if (on.update.hidden !== false || on.update["config.alpha"] !== torch.light.alpha) {
        return fail(`Relighting the torch did not restore its own alpha (got ${JSON.stringify(on.update)}, expected ${torch.light.alpha}).`, {
          update: on.update,
          expectedAlpha: torch.light.alpha,
        });
      }
      return pass(
        `Dressing plan: 14 items, 0 tile gaps; torch ${torch.id} toggles out (hidden, alpha 0, "${off.chatLine}") and back (alpha ${torch.light.alpha}, "${on.chatLine}").`,
        { items: 14, gaps: 0 },
      );
    },
  },
  {
    id: "treasure-budget",
    title: "Treasure fitter lands exactly on a 500 gp budget with signature items",
    backlog: "BRA-200 treasure live layer + art step (FR-14)",
    kind: "offline",
    run: () => {
      const hoard = generateTreasure({ budgetGp: 500, level: 3, seed: 7, theme: "dungeon" });
      // The fitter's real guarantee is exact by construction (coins fill
      // the remainder — verified by the lead over 5,600 hoards, budgets
      // 1-50,000 gp, levels 1-12, 200 seeds each: value(items) + coins
      // always equals totalGp equals the budget). Items already include
      // the signatures, so the accounting identity is value(items) +
      // coins == totalGp.
      if (hoard.totalGp !== 500) {
        return fail(`Treasure totals ${hoard.totalGp} gp, expected exactly 500 gp.`, {
          expected: 500,
          actual: hoard.totalGp,
        });
      }
      const accounted = treasureValueGp(hoard.items) + hoard.coinsGp;
      if (accounted !== hoard.totalGp) {
        return fail(`Treasure accounting does not add up: items ${treasureValueGp(hoard.items)} + coins ${hoard.coinsGp} = ${accounted}, totalGp says ${hoard.totalGp}.`, {
          expected: hoard.totalGp,
          actual: accounted,
        });
      }
      if (hoard.signatureItems.length < 1) {
        return fail("Treasure has no signature item — the budget fitter should place 1-2.");
      }
      return pass(
        `Treasure (budget 500, level 3, seed 7): ${hoard.totalGp} gp exactly on budget, items + coins account exactly, ${hoard.signatureItems.length} signature item(s), ${hoard.items.length} item(s) total.`,
        { total: hoard.totalGp, signature: hoard.signatureItems.length, items: hoard.items.length },
      );
    },
  },
  {
    id: "rules-lookup",
    title: "Rule lookup answers from the books and says so when it cannot",
    backlog: "BRA-205 real rule lookup",
    kind: "offline",
    run: () => {
      const found = demoLookup("What does flat-footed do?");
      if (!found.found) {
        return fail(`Flat-footed lookup did not find an answer (got: ${found.answer}).`);
      }
      if (found.citations.length === 0) {
        return fail("Flat-footed lookup found an answer with no citation.");
      }
      const missing = demoLookup("How do I ride a dragon to the moon?");
      if (missing.found) {
        return fail(`A question absent from the books returned a "found" answer: ${missing.answer}.`);
      }
      if (!missing.answer.startsWith("Not found in the installed books")) {
        return fail(`Absent-rule answer does not say "not found" plainly (got: ${missing.answer}).`);
      }
      return pass(
        `Rule lookup: flat-footed found with ${found.citations.length} citation(s); dragon-to-the-moon plainly not found.`,
        { foundCitations: found.citations.length },
      );
    },
  },
  {
    id: "questlog-honesty",
    title: "Quest log requires a source on every note and completes cleanly",
    backlog: "BRA-203 quest log",
    kind: "offline",
    run: () => {
      let log = emptyQuestLog();
      const added = addQuest(log, {
        title: "Prove the rehearsal works",
        objectives: ["Run the offline checks"],
      });
      log = added.log;
      let threw = false;
      try {
        addNote(log, added.quest.id, "saw something", "");
      } catch {
        threw = true;
      }
      if (!threw) {
        return fail("addNote without a source did not throw — the honesty rule requires a source on every note.");
      }
      const noted = addNote(log, added.quest.id, "saw something", "the rehearsal");
      const completed = completeQuest(noted.log, added.quest.id);
      if (completed.quest.status !== "completed") {
        return fail(`completeQuest left the quest "${completed.quest.status}", expected "completed".`, {
          expected: "completed",
          actual: completed.quest.status,
        });
      }
      return pass(
        `Quest log: quest "${added.quest.title}" added, sourceless note rejected, note with source accepted, quest completed.`,
        { quest: added.quest.id },
      );
    },
  },
  {
    id: "dice-parse",
    title: "Dice parser reads roll requests and ignores plain chat",
    backlog: "BRA-187 dice",
    kind: "offline",
    run: () => {
      const req = parseRollRequest("roll 1d20+5");
      if (!req) return fail('"roll 1d20+5" did not parse as a roll request.');
      const plain = parseRollRequest("nice hit!");
      if (plain) return fail('"nice hit!" parsed as a roll request — plain chat must not wake the roller.');
      return pass(`Dice parser: "roll 1d20+5" parses (formula ${req.formula}); plain chat returns null.`, {
        formula: req.formula,
      });
    },
  },
  {
    id: "theme-reskin",
    title: "Theme re-skin changes the look, not the room",
    backlog: "BRA-194 themes (FR-2)",
    kind: "offline",
    run: (ctx) => {
      const spec = entryHall();
      const dungeon = layoutRoom(spec, ctx.pack, ctx.serverBase, "dungeon");
      const western = layoutRoom(spec, ctx.pack, ctx.serverBase, "western");
      if (dungeon.tiles.length !== western.tiles.length) {
        return fail(`Re-skin changed the tile count (${dungeon.tiles.length} dungeon vs ${western.tiles.length} western) — a theme is a look, not a rebuild.`, {
          dungeon: dungeon.tiles.length,
          western: western.tiles.length,
        });
      }
      const floorSrc = (tiles: { sort: number; texture: { src: string } }[]): string =>
        tiles.find((t) => t.sort === 0)?.texture.src ?? "";
      const dFloor = floorSrc(dungeon.tiles);
      const wFloor = floorSrc(western.tiles);
      if (dFloor === wFloor) {
        return fail(`Western re-skin did not change the floor tile (both ${dFloor}).`);
      }
      if (!wFloor.includes("sand")) {
        return fail(`Western floor tile does not read as sandstone (got ${wFloor}).`, { actual: wFloor });
      }
      return pass(
        `Re-skin: same ${dungeon.tiles.length} tiles both themes; floor ${dFloor.split("/").pop()} -> ${wFloor.split("/").pop()}.`,
        { tiles: dungeon.tiles.length, dungeonFloor: dFloor, westernFloor: wFloor },
      );
    },
  },
  {
    id: "clocks-tick",
    title: "Clocks tick once per combat round and fire at zero, once",
    backlog: "BRA-228 clocks",
    kind: "offline",
    run: () => {
      let store = emptyClockStore();
      const created = createClock(store, {
        name: "The ritual completes",
        total: 4,
        source: "rehearsal",
        consequence: "the lich rises",
      });
      store = created.store;
      const firedAt: number[] = [];
      for (let round = 1; round <= 5; round++) {
        const advanced = advanceClocksToRound(store, { combatId: "rehearsal-combat", round, source: "rehearsal" });
        store = advanced.store;
        for (const e of advanced.events) if (e.fired) firedAt.push(round);
      }
      if (firedAt.length !== 1 || firedAt[0] !== 4) {
        return fail(`Clock fired at rounds [${firedAt.join(", ")}], expected exactly once at round 4.`, {
          expected: [4],
          actual: firedAt,
        });
      }
      return pass("Clock (total 4) fired exactly once, at round 4; round 5 did not re-fire.", {
        firedAt,
      });
    },
  },
  {
    id: "encounter-gen",
    title: "Encounter generator gives every NPC a living kit and a signature item",
    backlog: "BRA-189 encounter-gen --build (FR-11)",
    kind: "offline",
    run: () => {
      const enc = generateEncounter(rehearsalEncounterSpec());
      if (enc.npcs.length !== 6) {
        return fail(`Encounter has ${enc.npcs.length} NPCs, expected 6.`, { expected: 6, actual: enc.npcs.length });
      }
      const signatures = new Set<string>();
      for (const npc of enc.npcs) {
        if (!npc.signature) return fail(`NPC ${npc.name} has no signature item.`);
        signatures.add(npc.signature.name);
        if (npc.livingKit.length === 0) {
          return fail(`NPC ${npc.name} has no living kit.`);
        }
      }
      if (signatures.size !== 6) {
        return fail(`Signature items are not unique: ${signatures.size} distinct names for 6 NPCs.`, {
          expected: 6,
          actual: signatures.size,
        });
      }
      if (enc.placements.length !== 6) {
        return fail(`Encounter has ${enc.placements.length} placements, expected 6.`, {
          expected: 6,
          actual: enc.placements.length,
        });
      }
      return pass(
        `Encounter (death theme, party level 2): 6 NPCs, 6 unique signature items, every NPC with a living kit, 6 wedge placements.`,
        { npcs: 6, signatures: signatures.size, placements: 6 },
      );
    },
  },
];

// ---------------------------------------------------------------- live checks

const LIVE_CHECKS: RehearsalCheck[] = [
  {
    id: "live-tile-pack-upload",
    title: "Tile pack uploads to TestBed",
    backlog: "BRA-181 tile pack + composer",
    kind: "live",
    precondition: `${REHEARSAL_SERVER_PRECONDITION} The pack uploads to worlds/testbed/.`,
    runLive: async (ctx) => {
      const { uploadTilePack } = await liveBuilders();
      const summary = await uploadTilePack(ctx.live, tilesDir(), "worlds/testbed");
      return pass(`uploadTilePack finished: ${summary}`, { summary });
    },
  },
  {
    id: "live-dressed-room",
    title: "Dressed room builds on TestBed with its click flags",
    backlog: "BRA-192 interactive dressing (FR-16)",
    kind: "live",
    precondition: `${REHEARSAL_SERVER_PRECONDITION} The meroki-dressing module is installed in the world for the click check that follows.`,
    runLive: async (ctx) => {
      const { buildDressedTileRoom } = await liveBuilders();
      const spec: RoomSpec = { name: "Rehearsal Room", gridW: 8, gridH: 8, seed: 1 };
      const built = await buildDressedTileRoom(ctx.live, spec, ctx.pack, ctx.serverBase);
      if (built.dressingPairs.length !== 14) {
        return fail(`Dressed room paired ${built.dressingPairs.length} dressing items, expected 14.`, {
          expected: 14,
          actual: built.dressingPairs.length,
        });
      }
      const raw = ctx.live.raw() as unknown as {
        getScenes(): { _id: string; name: string }[];
      };
      const scene = raw.getScenes().find((s) => s._id === built.sceneId);
      if (!scene) {
        return fail(`Scene ${built.sceneId} is not visible on a fresh read of the world.`, {
          sceneId: built.sceneId,
        });
      }
      return pass(
        `Dressed room built live: scene ${built.sceneId} ("${scene.name}"), 14 dressing pairs, ${built.tileIds.length} tiles, ${built.lightIds.length} lights. (Tile flags need a fresh-connection read to confirm — the vendored client does not track its own Tile creates.)`,
        { sceneId: built.sceneId, pairs: 14, tiles: built.tileIds.length, lights: built.lightIds.length },
      );
    },
  },
  {
    id: "live-ambush-play",
    title: "Ambush cutscene plays end to end on TestBed",
    backlog: "BRA-184 cutscene ambush (FR-5)",
    kind: "live",
    precondition: `${REHEARSAL_SERVER_PRECONDITION} Soldier and Mage actors exist in TestBed, and the spear prop tile is uploaded to worlds/testbed/.`,
    runLive: async (ctx) => {
      const input = JSON.parse(fs.readFileSync(ambushPath(), "utf8")) as unknown;
      const result = await playCutscene(ctx.live, input, { continueOnError: false });
      const failed = result.steps.filter((s) => !s.ok);
      if (failed.length > 0) {
        return fail(
          `Ambush stopped at step ${failed[0].index} (${failed[0].kind}): ${failed[0].error ?? "no error given"}.`,
          { failedStep: failed[0].index, kind: failed[0].kind, error: failed[0].error },
        );
      }
      if (result.expandedSteps !== 51) {
        return fail(`Ambush played ${result.expandedSteps} steps, expected 51.`, {
          expected: 51,
          actual: result.expandedSteps,
        });
      }
      return pass(
        `Ambush played live: ${result.expandedSteps} steps, all ok, in ${result.durationMs} ms.`,
        { steps: result.expandedSteps, ms: result.durationMs },
      );
    },
  },
  {
    id: "live-rule-lookup",
    title: "Rule lookup answers from the installed books, live",
    backlog: "BRA-205 real rule lookup",
    kind: "live",
    precondition: `${REHEARSAL_SERVER_PRECONDITION} The PF2e compendium packs are installed (the world payload carries their indexes).`,
    runLive: async (ctx) => {
      const answer = await lookupRuleLive(ctx.live, "What does flat-footed do?");
      if (!answer.found) {
        return fail(`Live flat-footed lookup found nothing (answer: ${answer.answer}).`);
      }
      if (answer.citations.length === 0) {
        return fail("Live flat-footed lookup found an answer with no citation.");
      }
      const missing = await lookupRuleLive(ctx.live, "How do I ride a dragon to the moon?");
      if (missing.found) {
        return fail(`Live lookup returned a "found" answer for a question absent from the books: ${missing.answer}.`);
      }
      return pass(
        `Live rule lookup: flat-footed found with ${answer.citations.length} citation(s) (${answer.citations.map((c) => c.packLabel).join(", ")}); dragon-to-the-moon plainly not found.`,
        { foundCitations: answer.citations.length },
      );
    },
  },
  {
    id: "live-questlog",
    title: "Quest log writes to the TestBed journal and reads back",
    backlog: "BRA-203 quest log",
    kind: "live",
    precondition: `${REHEARSAL_SERVER_PRECONDITION} No "Quest Log" journal entry is required to exist first — the check creates it.`,
    runLive: async (ctx) => {
      const added = await addQuestLive(ctx.live, {
        title: "Rehearsal Quest",
        objectives: ["Prove the rehearsal works"],
      });
      return pass(
        `Quest log live: "Rehearsal Quest" written to journal entry ${added.entryId}, page ${added.pageId}.`,
        { entryId: added.entryId, pageId: added.pageId, questId: added.quest.id },
      );
    },
  },
  {
    id: "live-dice-roll",
    title: "Dice roll lands in TestBed chat",
    backlog: "BRA-187 dice",
    kind: "live",
    precondition: `${REHEARSAL_SERVER_PRECONDITION} The roll posts to TestBed chat (visible to the table).`,
    runLive: async (ctx) => {
      const messageId = await rollForChat(ctx.live, "roll 1d20+5", { dedupeKey: "rehearsal:dice" });
      if (!messageId) {
        return fail('"roll 1d20+5" returned no message id — the roll did not post.');
      }
      return pass(`Dice roll live: "roll 1d20+5" posted as chat message ${messageId}.`, {
        messageId,
      });
    },
  },
  {
    id: "live-encounter-build",
    title: "Encounter builds on TestBed: actors, tokens in formation, combat starts",
    backlog: "BRA-189 encounter-gen --build (FR-11)",
    kind: "live",
    precondition: `${REHEARSAL_SERVER_PRECONDITION} The check builds its own dressed rehearsal room and runs the death-theme demo encounter in it.`,
    runLive: async (ctx) => {
      const { buildDressedTileRoom } = await liveBuilders();
      const room = await buildDressedTileRoom(
        ctx.live,
        { name: "Rehearsal Encounter Room", gridW: 10, gridH: 8, seed: 3 },
        ctx.pack,
        ctx.serverBase,
      );
      const built = await createCustomEncounter(ctx.live, rehearsalEncounterSpec(), {
        sceneId: room.sceneId,
        announce: false,
      });
      if (built.tokens.length !== 6) {
        return fail(`Encounter placed ${built.tokens.length} tokens, expected 6.`, {
          expected: 6,
          actual: built.tokens.length,
        });
      }
      if (!built.combatId) {
        return fail("Encounter created no combat — combat did not start.");
      }
      return pass(
        `Encounter live: 6 tokens in wedge formation in scene ${room.sceneId}, combat ${built.combatId} started.`,
        { sceneId: room.sceneId, combatId: built.combatId, tokens: built.tokens.length },
      );
    },
  },
  {
    id: "live-compendium-import",
    title: "Compendium import brings a Lich into TestBed",
    backlog: "BRA-190 compendium import",
    kind: "live",
    precondition: `${REHEARSAL_SERVER_PRECONDITION} A pack in the world index contains a "Lich" actor entry (the check finds it by name — no pack id is assumed).`,
    runLive: async (ctx) => {
      const packs = getWorldPacks(ctx.live);
      const hits = searchPackIndex(packs, "Lich", { limit: 10 }).filter(
        (h) => h.packType === "Actor" && h.entry.name === "Lich",
      );
      if (hits.length === 0) {
        return fail('No "Lich" actor entry in any installed pack index — nothing to import.', {
          packs: packs.map((p) => p.id),
        });
      }
      const hit = hits[0];
      const result = await importPackActor(ctx.live, hit.packId, hit.entry._id);
      return pass(
        `Compendium import live: "Lich" imported from ${hit.packLabel} as actor ${result.actorId} (${result.itemIds?.length ?? 0} items).`,
        { packId: hit.packId, actorId: result.actorId, items: result.itemIds?.length ?? 0 },
      );
    },
  },
  {
    id: "live-dressing-click",
    title: "Clicking a torch in the Foundry client flips its light",
    backlog: "BRA-192 interactive dressing (FR-16)",
    kind: "live",
    precondition: `${REHEARSAL_SERVER_PRECONDITION} The meroki-dressing module is installed and enabled; a dressed room exists (see live-dressed-room).`,
    manualSteps: [
      "Open the rehearsal room in the Foundry client as the GM and click a torch tile.",
      "Confirm the light visibly flips and the chat line posts (\"The torch gutters out.\" / \"The torch sputters to life.\").",
      "Click it again — it relights and stays lit.",
      "As a player (second browser), click a torch — confirm the GM client executes it and the light flips for everyone.",
      "Have the GM run a cutscene that dims the torches, then click one — it reads the real (dimmed) state, not a stale flag.",
    ],
  },
  {
    id: "live-token-sync",
    title: "MCP-moved tokens show live in browsers (no reload)",
    backlog: "BRA-206 token sync (High)",
    kind: "live",
    precondition: `${REHEARSAL_SERVER_PRECONDITION} Two browser clients open on the same scene (one GM, one player).`,
    manualSteps: [
      "Move a token with the MCP (moveTokenTo) while both browsers watch the scene.",
      "Confirm BOTH browsers show the token in its new position without a reload.",
      "If a browser needs a reload to see the move, the check FAILS — record which client and the exact repro (this is the known BRA-206 issue).",
    ],
  },
  {
    id: "live-zone-cutscene",
    title: "Walking into a zone plays its cutscene once, then re-arms per token",
    backlog: "BRA-196 zone→cutscene (FR-4)",
    kind: "live",
    precondition: `${REHEARSAL_SERVER_PRECONDITION} A zones file is watched by the trap CLI against TestBed (examples/trapdoor-zones.json shape).`,
    manualSteps: [
      "Move a token into a cutscene zone — the cutscene plays once.",
      "Move the token out and back in — with `once` arming it does NOT replay.",
      "Move a second token into a per-token zone — it fires for the second token.",
      "Disarm the zone, walk in — nothing plays; arm it again — it plays.",
    ],
  },
  {
    id: "live-whisper",
    title: "Mid-session GM whisper is handled within the speed budget",
    backlog: "BRA-185 monitor GM-whisper handling (FR-18)",
    kind: "live",
    precondition: `${REHEARSAL_SERVER_PRECONDITION} The monitor is running against TestBed and the GM whispers it mid-session.`,
    manualSteps: [
      "As the GM, whisper the monitor a build request mid-session.",
      "Confirm the first visible effect lands within the 120,000 ms whisper-first-effect budget (check the monitor latency log lines).",
      "Confirm the reply goes to the GM as a whisper, not to public chat.",
    ],
  },
  {
    id: "live-treasure-fill",
    title: "Treasure hoard fills a real chest and reads back as a player",
    backlog: "BRA-200 treasure live layer + art step (FR-14)",
    kind: "live",
    precondition: `${REHEARSAL_SERVER_PRECONDITION} A loot chest actor exists in TestBed (create one with the loot CLI first if needed).`,
    manualSteps: [
      "Run treasure --fill --chest <loot-actor-id> --budget 500 --level 3 against TestBed.",
      "Confirm placement.failed is empty and placedValueGp equals 500.",
      "Open the chest as a player: the story is in each description and the signature ability is labeled homebrew.",
      "Run --fill against a bad chest id — every item is named with the reason.",
    ],
  },
  {
    id: "live-clock-watch",
    title: "Clocks tick once per combat round and fire at zero, live",
    backlog: "BRA-228 clocks",
    kind: "live",
    precondition: `${REHEARSAL_SERVER_PRECONDITION} A combat is running in TestBed; the clocks CLI --watch is running against it.`,
    manualSteps: [
      "Start a clock (--start) and confirm the announcement posts.",
      "Advance combat rounds — confirm the clock ticks exactly once per round.",
      "At zero, confirm the consequence fires exactly once (and not again next round).",
      "Restart the watch — confirm it restores the clock state from its state file.",
    ],
  },
  {
    id: "live-scoreboard",
    title: "Scoreboard posts goals and fouls and declares a winner at three",
    backlog: "BRA-237 scoreboard",
    kind: "live",
    precondition: `${REHEARSAL_SERVER_PRECONDITION} A dragon-soccer board exists in TestBed (scoreboard CLI --start).`,
    manualSteps: [
      "Confirm the journal page and chat line exist for the board.",
      "Score a goal, then a foul — both post.",
      "Score a third goal — the winner is declared.",
      "Start a second board — confirm the two boards stay separate.",
    ],
  },
  {
    id: "live-floor-plan",
    title: "Locked floor plan executes end to end and walks clean",
    backlog: "BRA-191 floor plan live (FR-15)",
    kind: "live",
    precondition: `${REHEARSAL_SERVER_PRECONDITION} A locked floor-plan manifest exists (floor-plan CLI --demo, then lock).`,
    manualSteps: [
      "Execute the locked manifest against TestBed (uploadTilePack → buildDungeon → trap wiring → riddle reveal → encounters → treasure → GM notes).",
      "Walk the built floor end to end: every room reachable, boss door locked until its plates are done.",
      "Run the chat convergence loop: show the preview, react, re-plan — confirm it converges and locks only when the ideas do.",
    ],
  },
];

/** The full rehearsal: every offline check, then every live check. */
export function defaultRehearsalChecks(): RehearsalCheck[] {
  return [...OFFLINE_CHECKS, ...LIVE_CHECKS];
}

/** Find one check by id, or undefined. */
export function findRehearsalCheck(id: string): RehearsalCheck | undefined {
  return defaultRehearsalChecks().find((c) => c.id === id);
}
