/**
 * Tests for the two cutscene-player gaps (BRA-239 + BRA-242).
 *
 * - BRA-239: a cutscene `light` step accepts {name} and animates the
 *   whole group via animateNamedLights — each light from its own
 *   current state (the plan carries `from`), never a guessed one.
 * - BRA-242: a played `prop` step is recorded into the room spec
 *   via placeProp, so a rebuild puts it back at the same cell.
 *
 * Both halves run against a fake live (no Foundry connection): the
 * light half checks the AmbientLight updates the player sends, the
 * prop half checks the spec the player hands back through onSpec.
 * Run: bun test tests/cutscene-player.test.ts
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { playCutscene } from "../src/session/cutscene.js";
import { runSequence } from "../src/session/sequence.js";
import type { FoundryLive } from "../src/live.js";
import {
  listProps,
  loadPack,
  propTileNameForSrc,
  recordCutsceneProp,
  type Pack,
  type RoomSpec,
} from "../src/worldbuilding/tiles-layout.js";

const pack: Pack = loadPack(path.resolve(import.meta.dir, "../tiles/manifest.json"));

// ---------------------------------------------------------------- fake live

interface DocCall {
  type: string;
  op: string;
  args: unknown;
}

function fakeLive() {
  const calls: DocCall[] = [];
  const scenes = [
    {
      _id: "scene-1",
      name: "Entry Hall",
      lights: [
        {
          _id: "l1",
          x: 100,
          y: 100,
          config: { dim: 300, bright: 100, color: "#ff9a3c", alpha: 0.5 },
          flags: { "foundry-live": { lightName: "the braziers" } },
        },
        {
          _id: "l2",
          x: 300,
          y: 100,
          config: { dim: 100, bright: 50, color: "#ff9a3c", alpha: 0.5 },
          flags: { "foundry-live": { lightName: "the braziers" } },
        },
        {
          _id: "l3",
          x: 200,
          y: 200,
          config: { dim: 200, bright: 80, color: "#ffd27a", alpha: 0.4 },
          flags: { "foundry-live": { lightName: "the altar candles" } },
        },
      ],
      tokens: [],
    },
  ];
  let tileSeq = 0;
  const live = {
    raw: () => ({ getWorldData: () => ({ scenes }) }),
    modifyDocument: async (type: string, op: string, args: unknown) => {
      calls.push({ type, op, args });
      if (type === "Tile" && op === "create") return [{ _id: `tile-${++tileSeq}` }];
      return [{ _id: "ok" }];
    },
  };
  return { live, calls, scenes };
}

const lightUpdates = (calls: DocCall[]) =>
  calls
    .filter((c) => c.type === "AmbientLight")
    .map((c) => (c.args as { updates: Record<string, unknown>[] }).updates[0]);

/** 8x6 room with one door, no props — the rebuild source of truth. */
const roomSpec = (): RoomSpec => ({
  name: "Test Room",
  gridW: 8,
  gridH: 6,
  seed: 42,
  doors: [{ wall: "south", at: 3 }],
});

// ---------------------------------------------------------------- BRA-239

describe("runSequence: named light steps (BRA-239)", () => {
  it("animates every light in the group, and only those", async () => {
    const { live, calls } = fakeLive();
    const out = await runSequence(live as unknown as FoundryLive, [
      { kind: "light", sceneId: "scene-1", light: { name: "the braziers" }, dim: 0, durationMs: 100, steps: 1 },
    ]);
    expect(out.ok).toBe(true);
    const step = out.steps[0];
    expect(step.ok).toBe(true);
    const result = step.result as { name: string; lightIds: string[] };
    expect(result.name).toBe("the braziers");
    expect(result.lightIds.sort()).toEqual(["l1", "l2"]);
    const updated = lightUpdates(calls);
    expect(updated).toHaveLength(2);
    expect(updated.map((u) => u._id).sort()).toEqual(["l1", "l2"]);
    expect(updated.every((u) => u["config.dim"] === 0)).toBe(true);
  });

  it("starts each light from its own current state — the plan carries from", async () => {
    const { live, calls } = fakeLive();
    // l1 sits at dim 300, l2 at dim 100; both fade to 0 in 2 steps.
    // The halfway update must differ per light (150 vs 50) — a
    // single shared `from` would land both at the same value.
    const out = await runSequence(live as unknown as FoundryLive, [
      { kind: "light", sceneId: "scene-1", light: { name: "braziers" }, dim: 0, durationMs: 100, steps: 2 },
    ]);
    expect(out.ok).toBe(true);
    const updated = lightUpdates(calls);
    expect(updated).toHaveLength(4);
    const dimsByLight = new Map<string, number[]>();
    for (const u of updated) {
      const id = String(u._id);
      dimsByLight.set(id, [...(dimsByLight.get(id) ?? []), Number(u["config.dim"])]);
    }
    expect(dimsByLight.get("l1")?.sort((a, b) => a - b)).toEqual([0, 150]);
    expect(dimsByLight.get("l2")?.sort((a, b) => a - b)).toEqual([0, 50]);
  });

  it("an unknown name fails the step, lists the names that exist, and sends no updates", async () => {
    const { live, calls } = fakeLive();
    const out = await runSequence(live as unknown as FoundryLive, [
      { kind: "light", sceneId: "scene-1", light: { name: "the chandelier" }, dim: 0, durationMs: 100, steps: 1 },
    ]);
    expect(out.ok).toBe(false);
    expect(out.steps[0].error).toContain('No light named "the chandelier"');
    expect(out.steps[0].error).toContain("the braziers");
    expect(out.steps[0].error).toContain("the altar candles");
    expect(lightUpdates(calls)).toHaveLength(0);
  });

  it("a named step carrying from fails before any update — from does not apply to a group", async () => {
    const { live, calls } = fakeLive();
    const out = await runSequence(live as unknown as FoundryLive, [
      {
        kind: "light",
        sceneId: "scene-1",
        light: { name: "the braziers" },
        dim: 0,
        from: { dim: 300 },
        durationMs: 100,
        steps: 1,
      },
    ]);
    expect(out.ok).toBe(false);
    expect(out.steps[0].error).toContain("does not apply to a group");
    expect(lightUpdates(calls)).toHaveLength(0);
  });

  it("the {id} path still works, from and all", async () => {
    const { live, calls } = fakeLive();
    const out = await runSequence(live as unknown as FoundryLive, [
      {
        kind: "light",
        sceneId: "scene-1",
        light: { id: "l3" },
        dim: 0,
        from: { dim: 200, bright: 80, color: "#ffd27a", alpha: 0.4 },
        durationMs: 100,
        steps: 1,
      },
    ]);
    expect(out.ok).toBe(true);
    const updated = lightUpdates(calls);
    expect(updated).toHaveLength(1);
    expect(updated[0]._id).toBe("l3");
    expect(updated[0]["config.dim"]).toBe(0);
  });
});

// ---------------------------------------------------------------- BRA-242 pure

describe("recordCutsceneProp — pure recorder (BRA-242)", () => {
  it("resolves a played src to its pack tile by basename", () => {
    expect(propTileNameForSrc(pack, "worlds/testbed/bones.png")).toBe("bones");
    expect(propTileNameForSrc(pack, "bones.png")).toBe("bones");
  });

  it("an unknown src throws, listing the known props", () => {
    expect(() => propTileNameForSrc(pack, "worlds/testbed/dragon.png")).toThrow(
      /not a prop tile.*Known props: .*bones/,
    );
  });

  it("a floor tile src throws — it is not a prop", () => {
    expect(() => propTileNameForSrc(pack, "worlds/testbed/floor-plain.png")).toThrow(
      /not a prop tile/,
    );
  });

  it("records the prop at the exact cell, fractional included", () => {
    const spec = roomSpec();
    const rec = recordCutsceneProp(
      spec,
      { src: "worlds/testbed/bones.png", x: 250, y: 250, width: 200, height: 200, rotation: 90 },
      pack,
    );
    expect(rec.recorded).toBe(true);
    expect(rec.tile).toBe("bones");
    expect(rec.gx).toBe(2.5);
    expect(rec.gy).toBe(2.5);
    expect(rec.propId).toBe("prop-1");
    expect(listProps(rec.spec)).toEqual([
      { id: "prop-1", tile: "bones", gx: 2.5, gy: 2.5, rotation: 90, w: 2, h: 2 },
    ]);
    // Pure: the input spec is untouched.
    expect(listProps(spec)).toEqual([]);
  });

  it("rounds the footprint to whole cells — a 150px prop records 2 wide", () => {
    const rec = recordCutsceneProp(
      roomSpec(),
      { src: "worlds/testbed/chest.png", x: 100, y: 100, width: 150, height: 100 },
      pack,
    );
    expect(rec.recorded).toBe(true);
    expect(listProps(rec.spec)).toEqual([
      { id: "prop-1", tile: "chest", gx: 1, gy: 1, w: 2, h: 1 },
    ]);
  });

  it("a re-play of the same prop is a no-op for the spec", () => {
    const first = recordCutsceneProp(
      roomSpec(),
      { src: "worlds/testbed/bones.png", x: 200, y: 200, width: 200, height: 200 },
      pack,
    );
    expect(first.recorded).toBe(true);
    const second = recordCutsceneProp(
      first.spec,
      { src: "worlds/testbed/bones.png", x: 200, y: 200, width: 200, height: 200 },
      pack,
    );
    expect(second.recorded).toBe(false);
    expect(second.note).toContain("already in the room spec");
    expect(listProps(second.spec)).toHaveLength(1);
  });

  it("a prop outside the room throws — it cannot be recorded", () => {
    expect(() =>
      recordCutsceneProp(
        roomSpec(),
        { src: "worlds/testbed/bones.png", x: 750, y: 100, width: 200, height: 200 },
        pack,
      ),
    ).toThrow(/does not fit in a 8x6 room/);
  });
});

// ---------------------------------------------------------------- BRA-242 player

describe("runSequence: prop recording (BRA-242)", () => {
  it("records a played prop into the spec and hands it back through onSpec", async () => {
    const { live } = fakeLive();
    const seen: RoomSpec[] = [];
    const out = await runSequence(
      live as unknown as FoundryLive,
      [
        { kind: "prop", sceneId: "scene-1", src: "worlds/testbed/bones.png", x: 200, y: 200, width: 200, height: 200 },
      ],
      { roomSpec: { spec: roomSpec(), pack, onSpec: (next) => seen.push(next) } },
    );
    expect(out.ok).toBe(true);
    const result = out.steps[0].result as { tileId: string; recorded: boolean; propId?: string };
    expect(result.tileId).toBe("tile-1");
    expect(result.recorded).toBe(true);
    expect(result.propId).toBe("prop-1");
    expect(seen).toHaveLength(1);
    expect(listProps(seen[0])).toEqual([
      { id: "prop-1", tile: "bones", gx: 2, gy: 2, w: 2, h: 2 },
    ]);
  });

  it("a re-play does not duplicate the prop in the spec", async () => {
    const { live } = fakeLive();
    let current = roomSpec();
    const opts = {
      roomSpec: {
        spec: current,
        pack,
        onSpec: (next: RoomSpec) => {
          current = next;
        },
      },
    };
    const step = {
      kind: "prop" as const,
      sceneId: "scene-1",
      src: "worlds/testbed/bones.png",
      x: 200,
      y: 200,
      width: 200,
      height: 200,
    };
    const first = await runSequence(live as unknown as FoundryLive, [step], opts);
    expect((first.steps[0].result as { recorded: boolean }).recorded).toBe(true);
    // The caller passes the updated spec back in for the re-run.
    const second = await runSequence(live as unknown as FoundryLive, [step], {
      roomSpec: { spec: current, pack, onSpec: (next) => {
        current = next;
      } },
    });
    expect(second.ok).toBe(true);
    const result = second.steps[0].result as { recorded: boolean; recordNote?: string };
    expect(result.recorded).toBe(false);
    expect(result.recordNote).toContain("already in the room spec");
    expect(listProps(current)).toHaveLength(1);
  });

  it("an unrecordable src still plays — the step succeeds and reports the miss", async () => {
    const { live } = fakeLive();
    const seen: RoomSpec[] = [];
    const out = await runSequence(
      live as unknown as FoundryLive,
      [
        { kind: "prop", sceneId: "scene-1", src: "worlds/testbed/dragon.png", x: 200, y: 200 },
      ],
      { roomSpec: { spec: roomSpec(), pack, onSpec: (next) => seen.push(next) } },
    );
    expect(out.ok).toBe(true);
    const result = out.steps[0].result as { recorded: boolean; recordError?: string };
    expect(result.recorded).toBe(false);
    expect(result.recordError).toContain("not a prop tile");
    expect(result.recordError).toContain("Known props:");
    expect(seen).toHaveLength(0);
  });

  it("without a spec the prop plays but is not recorded — and the result says so", async () => {
    const { live } = fakeLive();
    const out = await runSequence(live as unknown as FoundryLive, [
      { kind: "prop", sceneId: "scene-1", src: "worlds/testbed/bones.png", x: 200, y: 200 },
    ]);
    expect(out.ok).toBe(true);
    const result = out.steps[0].result as { recorded: boolean; recordNote?: string };
    expect(result.recorded).toBe(false);
    expect(result.recordNote).toContain("No room spec supplied");
    expect(result.recordNote).toContain("will not survive a rebuild");
  });
});

// ---------------------------------------------------------------- both, via playCutscene

describe("playCutscene: named light + recorded prop, end to end", () => {
  it("plays a script with a {name} light step and a prop step, recording the prop", async () => {
    const { live, calls } = fakeLive();
    const seen: RoomSpec[] = [];
    const out = await playCutscene(
      live as unknown as FoundryLive,
      {
        version: 1,
        name: "Braziers flare, bones appear",
        sceneId: "scene-1",
        steps: [
          { kind: "light", light: { name: "the braziers" }, dim: 600, durationMs: 100, steps: 1 },
          { kind: "prop", src: "worlds/testbed/bones.png", x: 300, y: 300, width: 200, height: 200 },
        ],
      },
      { roomSpec: { spec: roomSpec(), pack, onSpec: (next) => seen.push(next) } },
    );
    expect(out.ok).toBe(true);
    expect(out.expandedSteps).toBe(2);
    const lightStep = out.steps[0].result as { name: string; lightIds: string[] };
    expect(lightStep.name).toBe("the braziers");
    expect(lightStep.lightIds.sort()).toEqual(["l1", "l2"]);
    const propStep = out.steps[1].result as { recorded: boolean; propId?: string };
    expect(propStep.recorded).toBe(true);
    expect(propStep.propId).toBe("prop-1");
    expect(seen).toHaveLength(1);
    expect(listProps(seen[0])).toEqual([
      { id: "prop-1", tile: "bones", gx: 3, gy: 3, w: 2, h: 2 },
    ]);
    // The light updates went to the braziers only — not the candles.
    const updated = lightUpdates(calls);
    expect(updated.map((u) => u._id).sort()).toEqual(["l1", "l2"]);
  });

  it("refuses a script whose named light step carries from", async () => {
    const { live } = fakeLive();
    await expect(
      playCutscene(live as unknown as FoundryLive, {
        version: 1,
        name: "Bad script",
        sceneId: "scene-1",
        steps: [{ kind: "light", light: { name: "the braziers" }, dim: 0, from: { dim: 300 } }],
      }),
    ).rejects.toThrow(/does not apply to a group/);
  });
});
