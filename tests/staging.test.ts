/**
 * Stage-then-fire gate tests (BRA-231) — pure staging, the beat store,
 * and firing a staged beat against a fake live. No Foundry connection:
 * the world is a fixture snapshot; the player itself is live-tested
 * next session.
 */
import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import {
  stageCutscene,
  scriptHash,
  isStagedBeat,
  emptyBeatStore,
  stageBeatInStore,
  fireBeat,
  dropBeat,
  editBeat,
  listBeats,
  serializeBeatStore,
  parseBeatStore,
  playStagedCutscene,
  emptySnapshot,
} from "../src/session/staging.js";
import type { WorldSnapshot, StagedBeat } from "../src/session/staging.js";
import type { FoundryLive } from "../src/live.js";

const HALL_ID = "nOLHIrSgSICQcX0s";
const HALL_NAME = "Lich's Lair — Entry Hall";

/** Fixture world: the Entry Hall as the Nov 19 session left it, plus
 *  the actors the demo scripts need. */
function fixtureWorld(opts: { combat?: boolean } = {}): WorldSnapshot {
  return {
    actors: [
      { id: "Ezren000000000001", name: "Ezren" },
      { id: "Kyra000000000002", name: "Kyra" },
      { id: "Merisiel000000003", name: "Merisiel" },
      { id: "Valeros0000000004", name: "Valeros" },
      { id: "Mouse000000000005", name: "Mouse" },
      { id: "Ogre0000000000006", name: "Ogre" },
      { id: "TentacleCreature0", name: "Tentacle Creature" },
    ],
    scenes: [
      {
        id: HALL_ID,
        name: HALL_NAME,
        tokens: [
          { id: "tok-ezren", name: "Ezren", x: 750, y: 750 },
          { id: "tok-kyra", name: "Kyra", x: 850, y: 750 },
          { id: "tok-merisiel", name: "Merisiel", x: 750, y: 850 },
          { id: "tok-valeros", name: "Valeros", x: 850, y: 850 },
        ],
        lights: [{ id: "torch-1", x: 800, y: 800 }],
        tiles: [
          { id: "tile-floor-1", x: 1300, y: 700 },
          { id: "tile-floor-2", x: 300, y: 400 },
        ],
        walls: [
          { id: "wall-south", x1: 0, y1: 1600, x2: 1600, y2: 1600 },
          { id: "wall-north", x1: 0, y1: 0, x2: 1600, y2: 0 },
        ],
      },
    ],
    combat: opts.combat === false ? null : { round: 1 },
  };
}

function validScript(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    name: "Test Beat",
    sceneId: HALL_NAME,
    steps: [{ kind: "chat", content: "Something stirs in the dark." }],
    ...overrides,
  };
}

describe("stageCutscene", () => {
  it("stages a minimal valid script: deterministic id, preview, hash", () => {
    const world = fixtureWorld();
    const r = stageCutscene(validScript(), world, { stagedAt: "2026-11-20T20:00:00.000Z" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.beat.name).toBe("Test Beat");
    expect(r.beat.stagedAt).toBe("2026-11-20T20:00:00.000Z");
    expect(r.beat.scriptHash).toBe(scriptHash(r.beat.script));
    expect(r.beat.id).toBe(`staged-test-beat-${r.beat.scriptHash}`);
    expect(r.beat.expandedSteps).toHaveLength(1);
    expect(r.beat.preview).toEqual(['1. say "Something stirs in the dark."']);
    expect(r.beat.warnings).toEqual([]);
    // Same input, same id — staging is deterministic.
    const r2 = stageCutscene(validScript(), world, { stagedAt: "2026-11-21T00:00:00.000Z" });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.beat.id).toBe(r.beat.id);
  });

  it("stages the real mice-ogre demo against the fixture world", () => {
    const raw: unknown = JSON.parse(fs.readFileSync("examples/mice-ogre.json", "utf-8"));
    const r = stageCutscene(raw, fixtureWorld());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // chat(1) + rush: 6 mice x (place, move, roll, move) + 5 stagger pauses (29)
    // + waitRound, place, move, face, chat, breakWall, lightsOut, chat (8) = 38.
    expect(r.beat.expandedSteps).toHaveLength(38);
    expect(r.beat.warnings).toEqual([]);
    expect(r.beat.preview[1]).toContain("rush 6 Mouse");
    expect(r.beat.preview[2]).toContain("wait until round 5");
  });

  it("stages the tentacle twist once the ogre token is on the scene", () => {
    const raw: unknown = JSON.parse(fs.readFileSync("examples/tentacle-twist.json", "utf-8"));
    const world = fixtureWorld();
    const noOgre = stageCutscene(raw, world);
    expect(noOgre.ok).toBe(false);
    if (noOgre.ok) return;
    expect(noOgre.errors.some((e) => e.includes('emerge') && e.includes('"Ogre"'))).toBe(true);
    // The ogre token is on the scene after the mice-ogre beat played.
    world.scenes[0].tokens.push({ id: "tok-ogre", name: "Ogre", x: 800, y: 1200 });
    const withOgre = stageCutscene(raw, world);
    expect(withOgre.ok).toBe(true);
    if (!withOgre.ok) return;
    expect(withOgre.beat.expandedSteps).toHaveLength(7);
    expect(withOgre.beat.preview[4]).toContain("Tentacle Creature emerges from Ogre");
  });

  it("lists every error, not just the first", () => {
    const r = stageCutscene(
      validScript({
        version: 3,
        steps: [
          { kind: "teleport", x: 1 },
          { kind: "move", token: "Nobody", x: 1, y: 2 },
          { kind: "pause", ms: -5 },
        ],
      }),
      fixtureWorld(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });

  it("reports every unresolved reference in one script", () => {
    const r = stageCutscene(
      validScript({
        steps: [
          { kind: "place", actor: "No Such Actor", x: 100, y: 100 },
          { kind: "move", token: "Ghost Token", x: 200, y: 200 },
          { kind: "light", light: { id: "no-such-light" }, dim: 100 },
          { kind: "swapTile", tile: "no-such-tile", to: "a.png" },
          { kind: "breakWall", wallId: "no-such-wall" },
          { kind: "damage", actorId: "NoSuchActor00001", amount: 5 },
          { kind: "reveal", what: "scene", id: "No Such Scene" },
        ],
      }),
      fixtureWorld(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toHaveLength(7);
    expect(r.errors[0]).toContain('actor not found: "No Such Actor"');
    expect(r.errors[1]).toContain('token not found');
    expect(r.errors[2]).toContain('light not found');
    expect(r.errors[3]).toContain('tile not found');
    expect(r.errors[4]).toContain('wall not found');
    expect(r.errors[5]).toContain('actor not found: "NoSuchActor00001"');
    expect(r.errors[6]).toContain('scene not found: "No Such Scene"');
  });

  it("rejects an unknown scene, a missing sceneId, and a cell with no tile", () => {
    const badScene = stageCutscene(
      validScript({ sceneId: "No Such Scene" }),
      fixtureWorld(),
    );
    expect(badScene.ok).toBe(false);
    if (!badScene.ok) expect(badScene.errors[0]).toContain('not found: "No Such Scene"');

    const noScene = stageCutscene(
      {
        version: 1,
        name: "No Scene",
        steps: [{ kind: "move", token: "Ezren", x: 1, y: 2 }],
      },
      fixtureWorld(),
    );
    expect(noScene.ok).toBe(false);
    if (!noScene.ok) expect(noScene.errors[0]).toContain("no sceneId");

    const noTile = stageCutscene(
      validScript({
        steps: [{ kind: "swapTile", cell: { x: 9999, y: 9999 }, to: "a.png" }],
      }),
      fixtureWorld(),
    );
    expect(noTile.ok).toBe(false);
    if (!noTile.ok) expect(noTile.errors[0]).toContain("no tile at cell (9999, 9999)");

    const wallFar = stageCutscene(
      validScript({
        steps: [{ kind: "breakWall", at: { x: 800, y: 800 } }],
      }),
      fixtureWorld(),
    );
    expect(wallFar.ok).toBe(false);
    if (!wallFar.ok) expect(wallFar.errors[0]).toContain("no wall within 150px of (800, 800)");

    const lightAtEmpty = stageCutscene(
      validScript({
        steps: [{ kind: "light", light: { at: { x: 100, y: 100 } }, dim: 50 }],
      }),
      { actors: [], scenes: [{ id: HALL_ID, name: HALL_NAME, tokens: [], lights: [], tiles: [], walls: [] }] },
    );
    expect(lightAtEmpty.ok).toBe(false);
    if (!lightAtEmpty.ok) expect(lightAtEmpty.errors[0]).toContain("has no lights to select");
  });

  it("a token the script places resolves for later steps in the same script", () => {
    const r = stageCutscene(
      validScript({
        steps: [
          { kind: "place", actor: "Ogre", name: "Ogre", x: 800, y: 1500 },
          { kind: "move", token: "Ogre", x: 800, y: 1200 },
          { kind: "face", token: "Ogre", towardToken: "Ezren" },
          { kind: "deleteToken", token: "Ogre" },
        ],
      }),
      fixtureWorld(),
    );
    expect(r.ok).toBe(true);
  });

  it("warns (does not fail) on waitRound with no combat in the snapshot", () => {
    const r = stageCutscene(
      validScript({ steps: [{ kind: "waitRound", relative: true, round: 5 }] }),
      fixtureWorld({ combat: false }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.beat.warnings).toHaveLength(1);
    expect(r.beat.warnings[0]).toContain("waitRound");
    expect(r.beat.warnings[0]).toContain("no combat in the snapshot");
  });

  it("resolves a formation ring around a token, and errors on an unknown one", () => {
    const ok = stageCutscene(
      validScript({
        steps: [
          { kind: "formation", shape: "ring", count: 3, actor: "Mouse", center: { token: "Valeros" }, radius: 100 },
        ],
      }),
      fixtureWorld(),
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.beat.expandedSteps).toHaveLength(6); // 3 x (place, face)

    const bad = stageCutscene(
      validScript({
        steps: [
          { kind: "formation", shape: "ring", count: 3, actor: "Mouse", center: { token: "Ghost" }, radius: 100 },
        ],
      }),
      fixtureWorld(),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]).toContain('Token not found on scene');
  });

  it("staging touches nothing: world and script are unchanged", () => {
    const world = fixtureWorld();
    const script = validScript({
      steps: [
        { kind: "place", actor: "Ogre", name: "Ogre", x: 800, y: 1500 },
        { kind: "chat", content: "Roar." },
      ],
    });
    const worldBefore = JSON.stringify(world);
    const scriptBefore = JSON.stringify(script);
    const r = stageCutscene(script, world);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(world)).toBe(worldBefore);
    expect(JSON.stringify(script)).toBe(scriptBefore);
  });

  it("an empty snapshot stages nothing with references", () => {
    const r = stageCutscene(validScript(), emptySnapshot());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain('Script sceneId not found');
  });
});

describe("beat store", () => {
  it("staging the same script twice is an idempotent no-op", () => {
    const world = fixtureWorld();
    const staged = stageCutscene(validScript(), world);
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    const s1 = stageBeatInStore(emptyBeatStore(), staged.beat);
    expect(s1.duplicate).toBe(false);
    const s2 = stageBeatInStore(s1.store, staged.beat);
    expect(s2.duplicate).toBe(true);
    expect(s2.beat.id).toBe(s1.beat.id);
    expect(listBeats(s2.store)).toHaveLength(1);
  });

  it("fire marks fired and refuses a second fire; drop refuses a fire", () => {
    const world = fixtureWorld();
    const staged = stageCutscene(validScript(), world);
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    let store = stageBeatInStore(emptyBeatStore(), staged.beat).store;
    const fired = fireBeat(store, staged.beat.id);
    expect(fired.ok).toBe(true);
    if (!fired.ok) return;
    expect(fired.beat.id).toBe(staged.beat.id);
    store = fired.store;
    const again = fireBeat(store, staged.beat.id);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toContain("already fired");

    const dropped = dropBeat(store, staged.beat.id);
    expect(dropped.ok).toBe(false);
    if (!dropped.ok) expect(dropped.error).toContain("already fired");

    const missing = fireBeat(store, "staged-nope-00000000");
    expect(missing.ok).toBe(false);
  });

  it("drop then fire refuses; a dropped beat can be staged again", () => {
    const world = fixtureWorld();
    const staged = stageCutscene(validScript(), world);
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    let store = stageBeatInStore(emptyBeatStore(), staged.beat).store;
    const dropped = dropBeat(store, staged.beat.id);
    expect(dropped.ok).toBe(true);
    if (!dropped.ok) return;
    store = dropped.store;
    expect(fireBeat(store, staged.beat.id).ok).toBe(false);
    const restaged = stageBeatInStore(store, staged.beat);
    expect(restaged.duplicate).toBe(false);
    expect(listBeats(restaged.store)[0].status).toBe("staged");
  });

  it("edit re-stages: success drops the old beat and adds the new one", () => {
    const world = fixtureWorld();
    const staged = stageCutscene(validScript(), world);
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    let store = stageBeatInStore(emptyBeatStore(), staged.beat).store;
    const edited = editBeat(
      store,
      staged.beat.id,
      validScript({ name: "Edited Beat", steps: [{ kind: "chat", content: "Changed." }] }),
      world,
    );
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.beat.id).not.toBe(staged.beat.id);
    expect(edited.beat.name).toBe("Edited Beat");
    const beats = listBeats(edited.store);
    expect(beats).toHaveLength(2);
    expect(beats[0].status).toBe("staged"); // the new beat sorts first
    expect(beats[1].status).toBe("dropped");
    expect(fireBeat(edited.store, staged.beat.id).ok).toBe(false);
    store = edited.store;
    expect(fireBeat(store, edited.beat.id).ok).toBe(true);
  });

  it("edit with a bad script leaves the old beat staged", () => {
    const world = fixtureWorld();
    const staged = stageCutscene(validScript(), world);
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    const store = stageBeatInStore(emptyBeatStore(), staged.beat).store;
    const edited = editBeat(
      store,
      staged.beat.id,
      validScript({ steps: [{ kind: "place", actor: "No Such Actor", x: 1, y: 1 }] }),
      world,
    );
    expect(edited.ok).toBe(false);
    if (edited.ok) return;
    expect(edited.errors[0]).toContain("actor not found");
    expect(listBeats(store)[0].status).toBe("staged");
    expect(fireBeat(store, staged.beat.id).ok).toBe(true);
  });

  it("serializes and parses round-trip; bad stores are rejected", () => {
    const world = fixtureWorld();
    const staged = stageCutscene(validScript(), world);
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    const store = stageBeatInStore(emptyBeatStore(), staged.beat).store;
    const parsed = parseBeatStore(serializeBeatStore(store));
    expect(parsed.beats[staged.beat.id].beat.id).toBe(staged.beat.id);
    expect(() => parseBeatStore("not json")).toThrow(/not valid JSON/);
    expect(() => parseBeatStore(JSON.stringify({ version: 2, beats: {} }))).toThrow(/version must be 1/);
    expect(() =>
      parseBeatStore(JSON.stringify({ version: 1, beats: { x: { beat: {}, status: "staged", updatedAt: "t" } } })),
    ).toThrow(/not a staged beat/);
  });

  it("isStagedBeat rejects bad shapes", () => {
    expect(isStagedBeat(null)).toBe(false);
    expect(isStagedBeat({ id: "x" })).toBe(false);
    const world = fixtureWorld();
    const staged = stageCutscene(validScript(), world);
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(isStagedBeat(staged.beat)).toBe(true);
    expect(isStagedBeat({ ...staged.beat, scriptHash: 42 })).toBe(false);
  });
});

describe("playStagedCutscene", () => {
  function fakeLive() {
    const sent: string[] = [];
    return {
      sent,
      sendChat: async (content: string) => {
        sent.push(content);
        return "msg-1";
      },
    };
  }

  it("fires a staged chat-only beat through the player", async () => {
    const world = fixtureWorld();
    const staged = stageCutscene(
      validScript({
        steps: [
          { kind: "chat", content: "The ogre ROARS." },
          { kind: "pause", ms: 1 },
          { kind: "chat", content: "The torches gutter and die." },
        ],
      }),
      world,
    );
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    const live = fakeLive();
    const result = await playStagedCutscene(live as unknown as FoundryLive, staged.beat);
    expect(result.ok).toBe(true);
    expect(result.name).toBe("Test Beat");
    expect(result.beatId).toBe(staged.beat.id);
    expect(result.expandedSteps).toBe(3);
    expect(live.sent).toEqual(["The ogre ROARS.", "The torches gutter and die."]);
  });

  it("refuses a beat whose script was edited after staging — and posts nothing", async () => {
    const world = fixtureWorld();
    const staged = stageCutscene(validScript(), world);
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    const tampered = JSON.parse(JSON.stringify(staged.beat)) as StagedBeat;
    tampered.script.steps = [
      { kind: "chat", content: "A DIFFERENT line the GM never approved." },
    ];
    const live = fakeLive();
    await expect(
      playStagedCutscene(live as unknown as FoundryLive, tampered),
    ).rejects.toThrow(/edited after staging/);
    expect(live.sent).toEqual([]);
  });
});
