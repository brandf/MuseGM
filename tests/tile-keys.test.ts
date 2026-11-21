/**
 * Tests for the tile-room idempotency-key treatment (BRA-202).
 *
 * Two halves, like the implementation:
 * - Pure (src/worldbuilding/tile-keys.ts): key builders, the converge
 *   planner, and the scene-doc extractor. No Foundry, no network.
 * - Live (src/worldbuilding/tiles.ts + src/session/build-exec.ts)
 *   against an in-memory fake world: same key twice = one scene,
 *   different key = a second scene, crash mid-build + retry =
 *   convergence, and the build loop's crash-retry through
 *   executeBuild.
 *
 * Import wrinkle: tiles.ts pulls in the vendored MCP client (via
 * upload.ts), which validates FOUNDRY_URL at import time — so the
 * live modules are imported dynamically below, after dummy values
 * are set, and the environment is restored right after. No
 * connection is ever made: every live test uses the FakeLive below.
 * Run: bun test tests/tile-keys.test.ts
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
  extractTileRoomEmbeds,
  parseTileEmbedKey,
  planTileRoomConverge,
  sceneHasTileRoomKey,
  tileEmbedKey,
  tileRoomBuildKey,
  type KeyedEmbed,
  type PlannedTile,
  type TileRoomEmbeds,
} from "../src/worldbuilding/tile-keys.js";
import {
  layoutRoom,
  loadPack,
  widenRoom,
  type Pack,
  type RoomSpec,
  type TileDoc,
} from "../src/worldbuilding/tiles-layout.js";
import type { FoundryLive } from "../src/live.js";

// --- dynamic import of the live modules (see header) ----------------
const prevEnv = {
  url: process.env.FOUNDRY_URL,
  user: process.env.FOUNDRY_USERNAME,
  pass: process.env.FOUNDRY_PASSWORD,
};
process.env.FOUNDRY_URL ??= "http://localhost:30000";
process.env.FOUNDRY_USERNAME ??= "dummy";
process.env.FOUNDRY_PASSWORD ??= "dummy";
const { buildDungeon, buildTileRoom, rebuildTileRoom } = await import(
  "../src/worldbuilding/tiles.js"
);
const { executeBuild } = await import("../src/session/build-exec.js");
const { BuildSession } = await import("../src/session/build-loop.js");
if (prevEnv.url === undefined) delete process.env.FOUNDRY_URL;
else process.env.FOUNDRY_URL = prevEnv.url;
if (prevEnv.user === undefined) delete process.env.FOUNDRY_USERNAME;
else process.env.FOUNDRY_USERNAME = prevEnv.user;
if (prevEnv.pass === undefined) delete process.env.FOUNDRY_PASSWORD;
else process.env.FOUNDRY_PASSWORD = prevEnv.pass;

const pack: Pack = loadPack(path.resolve(import.meta.dir, "../tiles/manifest.json"));
const BASE = "worlds/testbed";

const baseSpec: RoomSpec = {
  name: "Test Room",
  gridW: 8,
  gridH: 6,
  seed: 42,
  doors: [{ wall: "south", at: 3 }],
  dressing: [{ tile: "bones", gx: 2, gy: 2 }],
  fog: [{ tile: "fog-wisp-large", gx: 1, gy: 1 }],
  torches: [{ gx: 1, gy: 1 }],
  description: "A dusty test room.",
};

const KEY = "tile-room:test-room";

// ---------------------------------------------------------------- pure

describe("tileRoomBuildKey / tileEmbedKey / parseTileEmbedKey", () => {
  it("derives a stable key from a room id", () => {
    expect(tileRoomBuildKey("entry-hall")).toBe("tile-room:entry-hall");
    expect(tileRoomBuildKey("entry-hall")).toBe(tileRoomBuildKey("entry-hall"));
    expect(tileRoomBuildKey("crypt")).not.toBe(tileRoomBuildKey("entry-hall"));
  });

  it("builds distinct per-embed keys", () => {
    expect(tileEmbedKey(KEY, "tile", 0)).toBe(`${KEY}:tile:0`);
    expect(tileEmbedKey(KEY, "tile", 0)).not.toBe(tileEmbedKey(KEY, "wall", 0));
    expect(tileEmbedKey(KEY, "tile", 0)).not.toBe(tileEmbedKey(KEY, "tile", 1));
    expect(tileEmbedKey(KEY, "tile", 0)).not.toBe(tileEmbedKey("tile-room:other", "tile", 0));
  });

  it("round-trips keys whose build key itself contains colons", () => {
    const key = tileEmbedKey("dungeon-1:hall", "wall", 2);
    expect(parseTileEmbedKey(key)).toEqual({ buildKey: "dungeon-1:hall", kind: "wall", index: 2 });
    expect(parseTileEmbedKey("not-a-key")).toBeNull();
    expect(parseTileEmbedKey(`${KEY}:tile:`)).toBeNull();
    expect(parseTileEmbedKey(`${KEY}:token:0`)).toBeNull();
  });
});

describe("planTileRoomConverge", () => {
  // A planned tile: position + look. Distinct cells so each slot is
  // distinguishable by position alone.
  const T = (x: number, y: number, src = "worlds/testbed/floor-plain.png", sort = 0): PlannedTile => ({
    sort,
    elevation: 0,
    x,
    y,
    src,
    rotation: 0,
  });
  const keyedTile = (i: number, t: PlannedTile, id: string): KeyedEmbed => ({
    key: tileEmbedKey(KEY, "tile", i),
    id,
    ...t,
  });
  const keyed = (kind: "wall" | "light", i: number, id: string): KeyedEmbed => ({
    key: tileEmbedKey(KEY, kind, i),
    id,
  });
  const present = (
    tiles: KeyedEmbed[],
    walls: KeyedEmbed[] = [],
    lights: KeyedEmbed[] = [],
  ): TileRoomEmbeds => ({ tiles, walls, lights, levelIds: [], initialLevel: null });

  /** A fake scene doc holding one layout's tiles as keyed embeds. */
  const sceneFromTiles = (tiles: TileDoc[], buildKey: string): TileRoomEmbeds =>
    extractTileRoomEmbeds({
      tiles: tiles.map((t, i) => ({
        ...t,
        _id: `tile-${i}`,
        flags: { "foundry-live": { tileRoomKey: tileEmbedKey(buildKey, "tile", i) } },
      })),
      walls: [],
      lights: [],
    });
  const plannedFromLayout = (layout: ReturnType<typeof layoutRoom>) => ({
    tiles: layout.tiles.map((t) => ({
      sort: t.sort,
      elevation: t.elevation,
      x: t.x,
      y: t.y,
      src: t.texture.src,
      rotation: t.rotation,
    })),
    walls: layout.walls.length,
    lights: layout.lights.length,
  });

  it("creates everything when the scene is empty", () => {
    const plan = planTileRoomConverge(
      { tiles: [T(0, 0), T(100, 0), T(200, 0)], walls: 2, lights: 1 },
      present([], [], []),
      KEY,
    );
    expect(plan.createTiles).toEqual([0, 1, 2]);
    expect(plan.createWalls).toEqual([0, 1]);
    expect(plan.createLights).toEqual([0]);
    expect(plan.deleteTileIds).toEqual([]);
    expect(plan.keepTileIds).toEqual([null, null, null]);
  });

  it("creates nothing when everything is already in place", () => {
    const tiles = [T(0, 0), T(100, 0), T(200, 0)];
    const plan = planTileRoomConverge(
      { tiles, walls: 2, lights: 1 },
      present(
        tiles.map((t, i) => keyedTile(i, t, `t${i}`)),
        [keyed("wall", 0, "w0"), keyed("wall", 1, "w1")],
        [keyed("light", 0, "l0")],
      ),
      KEY,
    );
    expect(plan.createTiles).toEqual([]);
    expect(plan.createWalls).toEqual([]);
    expect(plan.createLights).toEqual([]);
    expect(plan.deleteTileIds).toEqual([]);
    expect(plan.keepTileIds).toEqual(["t0", "t1", "t2"]);
    expect(plan.keepWallIds).toEqual(["w0", "w1"]);
    expect(plan.keepLightIds).toEqual(["l0"]);
  });

  it("creates only the missing tiles and keeps the rest in order", () => {
    const tiles = [T(0, 0), T(100, 0), T(200, 0)];
    const plan = planTileRoomConverge(
      { tiles, walls: 2, lights: 1 },
      present([keyedTile(0, tiles[0], "t0"), keyedTile(2, tiles[2], "t2")], [], [keyed("light", 0, "l0")]),
      KEY,
    );
    expect(plan.createTiles).toEqual([1]);
    expect(plan.keepTileIds).toEqual(["t0", null, "t2"]);
    expect(plan.createWalls).toEqual([0, 1]);
    expect(plan.createLights).toEqual([]);
  });

  it("deletes surplus keyed tiles when the spec shrank", () => {
    const plan = planTileRoomConverge(
      { tiles: [T(0, 0)], walls: 1, lights: 0 },
      present(
        [keyedTile(0, T(0, 0), "t0"), keyedTile(1, T(100, 0), "t1"), keyedTile(5, T(500, 0), "t5")],
        [keyed("wall", 0, "w0")],
        [keyed("light", 0, "l0"), keyed("light", 1, "l1")],
      ),
      KEY,
    );
    expect(plan.deleteTileIds).toEqual(["t1", "t5"]);
    expect(plan.deleteLightIds).toEqual(["l0", "l1"]);
    expect(plan.keepTileIds).toEqual(["t0"]);
  });

  it("never touches another build's embeds or unkeyed ones", () => {
    const plan = planTileRoomConverge(
      { tiles: [T(0, 0), T(100, 0), T(200, 0)], walls: 2, lights: 1 },
      present(
        [
          // Same position as the first planned tile, but another
          // build's key — must not match.
          { key: tileEmbedKey("tile-room:other-room", "tile", 0), id: "other-t0", ...T(0, 0) },
          // Our key but no position/look fields — matches nothing.
          { key: tileEmbedKey(KEY, "tile", 9), id: "ours-t9" },
        ],
        [{ key: "gm-hand-placed", id: "gm-wall" }],
        [],
      ),
      KEY,
    );
    expect(plan.deleteTileIds).toEqual(["ours-t9"]);
    expect(plan.createTiles).toEqual([0, 1, 2]);
    expect(plan.keepTileIds).toEqual([null, null, null]);
  });

  it("keeps the first of two identical-position tiles and deletes the second", () => {
    const tiles = [T(0, 0), T(100, 0), T(200, 0)];
    const plan = planTileRoomConverge(
      { tiles, walls: 2, lights: 1 },
      present([keyedTile(0, tiles[0], "t0-a"), keyedTile(0, tiles[0], "t0-b")], [], []),
      KEY,
    );
    expect(plan.keepTileIds).toEqual(["t0-a", null, null]);
    expect(plan.deleteTileIds).toEqual(["t0-b"]);
  });

  it("a widen keeps the prop at its cell and never parks it on a wall", () => {
    // Regression (BRA-218): converge matched tiles by flat layout
    // index, so widening the room shifted every later tile — the old
    // bones tile stayed at index 72, which in the widened room is a
    // south wall tile (ghost prop + missing wall). Position + look
    // matching keeps the bones at its cell and recreates the shifted
    // floor/wall tiles instead.
    const layoutA = layoutRoom(baseSpec, pack, BASE);
    const layoutB = layoutRoom(widenRoom(baseSpec, "east", 2), pack, BASE);
    const presentEmbeds = sceneFromTiles(layoutA.tiles, KEY);
    const plan = planTileRoomConverge(plannedFromLayout(layoutB), presentEmbeds, KEY);
    const bonesA = layoutA.tiles.findIndex((t) => t.texture.src.endsWith("bones.png"));
    const bonesB = layoutB.tiles.findIndex((t) => t.texture.src.endsWith("bones.png"));
    const fogA = layoutA.tiles.findIndex((t) => t.texture.src.includes("fog-wisp"));
    expect(bonesA).toBeGreaterThanOrEqual(0);
    expect(bonesB).toBeGreaterThanOrEqual(0);
    // The prop is the same embed, at its cell, in the widened room.
    expect(plan.keepTileIds[bonesB]).toBe(`tile-${bonesA}`);
    expect(plan.deleteTileIds).not.toContain(`tile-${bonesA}`);
    expect(plan.deleteTileIds).not.toContain(`tile-${fogA}`);
    // The real invariant: every kept tile still looks like the layout
    // tile it covers — no prop parked on a wall slot, no wall parked
    // on a prop slot.
    layoutB.tiles.forEach((t, i) => {
      const kept = plan.keepTileIds[i];
      if (kept === null) return;
      const embed = presentEmbeds.tiles.find((e) => e.id === kept);
      expect(embed).toBeDefined();
      expect(embed!.sort).toBe(t.sort);
      expect(embed!.x).toBe(t.x);
      expect(embed!.y).toBe(t.y);
      expect(embed!.src).toBe(t.texture.src);
    });
  });

  it("a re-skin keeps the prop and recreates the tiles whose look changed", () => {
    // The western theme has no dressing variants, so the bones prop
    // keeps its tile; the floor changes look (plain -> sand), so
    // every floor tile is deleted + recreated instead of keeping the
    // stale dungeon texture.
    const dungeon = layoutRoom(baseSpec, pack, BASE);
    const western = layoutRoom(baseSpec, pack, BASE, "western");
    const presentEmbeds = sceneFromTiles(dungeon.tiles, KEY);
    const plan = planTileRoomConverge(plannedFromLayout(western), presentEmbeds, KEY);
    const bonesD = dungeon.tiles.findIndex((t) => t.texture.src.endsWith("bones.png"));
    const bonesW = western.tiles.findIndex((t) => t.texture.src.endsWith("bones.png"));
    expect(bonesW).toBeGreaterThanOrEqual(0);
    expect(plan.keepTileIds[bonesW]).toBe(`tile-${bonesD}`);
    const floorW = western.tiles.findIndex((t) => t.sort === 0);
    expect(plan.keepTileIds[floorW]).toBeNull();
    expect(plan.createTiles).toContain(floorW);
  });
});

describe("extractTileRoomEmbeds / sceneHasTileRoomKey", () => {
  it("reads keyed embeds, levels, and initialLevel from a raw scene doc", () => {
    const scene = {
      _id: "scene-1",
      flags: { "foundry-live": { buildKey: KEY } },
      tiles: [
        { _id: "t0", flags: { "foundry-live": { tileRoomKey: `${KEY}:tile:0` } } },
        { _id: "t1" },
      ],
      walls: [{ _id: "w0", flags: { "foundry-live": { tileRoomKey: `${KEY}:wall:0` } } }],
      lights: [],
      levels: [{ _id: "lvl-1" }],
      initialLevel: "lvl-1",
    };
    const got = extractTileRoomEmbeds(scene);
    expect(got.tiles).toEqual([{ key: `${KEY}:tile:0`, id: "t0" }]);
    expect(got.walls).toEqual([{ key: `${KEY}:wall:0`, id: "w0" }]);
    expect(got.lights).toEqual([]);
    expect(got.levelIds).toEqual(["lvl-1"]);
    expect(got.initialLevel).toBe("lvl-1");
    expect(sceneHasTileRoomKey(scene, KEY)).toBe(true);
    expect(sceneHasTileRoomKey(scene, "tile-room:other")).toBe(false);
  });

  it("tolerates missing arrays, missing flags, and non-objects", () => {
    expect(extractTileRoomEmbeds(undefined)).toEqual({
      tiles: [],
      walls: [],
      lights: [],
      levelIds: [],
      initialLevel: null,
    });
    expect(extractTileRoomEmbeds({ _id: "s" })).toEqual({
      tiles: [],
      walls: [],
      lights: [],
      levelIds: [],
      initialLevel: null,
    });
    expect(extractTileRoomEmbeds({ tiles: ["nope", { _id: "t", flags: { "foundry-live": { tileRoomKey: 42 } } }] }).tiles).toEqual([]);
    expect(sceneHasTileRoomKey(null, KEY)).toBe(false);
    expect(sceneHasTileRoomKey({ flags: null }, KEY)).toBe(false);
  });
});

// ---------------------------------------------------------------- fake live

type FakeDoc = Record<string, unknown> & { _id: string };

interface FakeScene {
  _id: string;
  name: string;
  width: number;
  height: number;
  navigation: boolean;
  ownership: Record<string, number>;
  flags: Record<string, Record<string, unknown>>;
  tiles: FakeDoc[];
  walls: FakeDoc[];
  lights: FakeDoc[];
  levels: FakeDoc[];
  initialLevel: string | null;
}

interface FakeChat {
  id: string;
  author: string;
  content: string;
  flags: Record<string, Record<string, unknown>>;
}

/** The shared "server": scenes + chat log, visible to every connection. */
interface FakeServer {
  scenes: FakeScene[];
  chats: FakeChat[];
}

function newServer(): FakeServer {
  return { scenes: [], chats: [] };
}

/**
 * In-memory Foundry stand-in. Two FakeLive instances over the same
 * FakeServer model two connections to the same world (fresh
 * connections see the full world payload, including tiles).
 * `failAfter` simulates a crash: the step's effects persist, then the
 * call throws. The chat methods mirror live.ts's contract, including
 * the dedupe-key memo + 50-message scan in sendChatIdempotent.
 */
class FakeLive {
  server: FakeServer;
  /** "Type:action" log of every modifyDocument call. */
  calls: string[] = [];
  failAfter: "scene" | "level" | "tiles" | "walls" | "lights" | null = null;
  userId: string | null = "mcp-api";
  private counter = 0;
  private sentDedupeKeys = new Map<string, string>();

  constructor(server: FakeServer = newServer()) {
    this.server = server;
  }

  get scenes(): FakeScene[] {
    return this.server.scenes;
  }

  get chats(): FakeChat[] {
    return this.server.chats;
  }

  getUsers() {
    return [{ _id: "gm-1", name: "Gamemaster", role: 4, active: true }];
  }

  raw() {
    return { getScenes: () => this.server.scenes };
  }

  getChatMessages(limit = 20): FakeChat[] {
    return this.server.chats.slice(-limit);
  }

  findMessageByDedupeKey(dedupeKey: string): FakeChat | undefined {
    return this.getChatMessages(50).find(
      (m) => m.author === this.userId && m.flags["foundry-live"]?.dedupeKey === dedupeKey,
    );
  }

  async sendChat(content: string, opts: { dedupeKey?: string } = {}): Promise<string> {
    const id = `msg-${++this.counter}`;
    this.server.chats.push({
      id,
      author: this.userId ?? "",
      content,
      flags: opts.dedupeKey ? { "foundry-live": { dedupeKey: opts.dedupeKey } } : {},
    });
    if (opts.dedupeKey) this.sentDedupeKeys.set(opts.dedupeKey, id);
    return id;
  }

  async sendChatIdempotent(
    content: string,
    opts: { dedupeKey: string },
  ): Promise<{ id: string; duplicate: boolean }> {
    const alreadySent = this.sentDedupeKeys.get(opts.dedupeKey);
    if (alreadySent) return { id: alreadySent, duplicate: true };
    const existing = this.findMessageByDedupeKey(opts.dedupeKey);
    if (existing) {
      this.sentDedupeKeys.set(opts.dedupeKey, existing.id);
      return { id: existing.id, duplicate: true };
    }
    const id = await this.sendChat(content, opts);
    return { id, duplicate: false };
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }

  private sceneOf(parentUuid: string): FakeScene {
    const id = parentUuid.replace(/^Scene\./, "");
    const scene = this.scenes.find((s) => s._id === id);
    if (!scene) throw new Error(`FakeLive: no scene ${id}`);
    return scene;
  }

  private crashAfter(step: string): void {
    if (this.failAfter === step) {
      this.failAfter = null;
      throw new Error(`simulated crash after ${step}`);
    }
  }

  async modifyDocument(
    type: string,
    action: string,
    opts: {
      data?: Record<string, unknown>[];
      updates?: Record<string, unknown>[];
      ids?: string[];
      parentUuid?: string;
    },
  ): Promise<FakeDoc[]> {
    this.calls.push(`${type}:${action}`);
    if (type === "Scene" && action === "create") {
      const created = (opts.data ?? []).map((d) => {
        const scene: FakeScene = {
          _id: this.nextId("scene"),
          name: String(d.name ?? ""),
          width: Number(d.width ?? 0),
          height: Number(d.height ?? 0),
          navigation: Boolean(d.navigation),
          ownership: (d.ownership as Record<string, number>) ?? {},
          flags: (d.flags as Record<string, Record<string, unknown>>) ?? {},
          tiles: [],
          walls: [],
          lights: [],
          levels: [],
          initialLevel: null,
        };
        this.scenes.push(scene);
        return scene as unknown as FakeDoc;
      });
      this.crashAfter("scene");
      return created;
    }
    if (type === "Level" && action === "create") {
      const scene = this.sceneOf(opts.parentUuid ?? "");
      const created = (opts.data ?? []).map((d) => ({ ...d, _id: this.nextId("level") }) as FakeDoc);
      scene.levels.push(...created);
      this.crashAfter("level");
      return created;
    }
    if (type === "Scene" && action === "update") {
      const updated: FakeDoc[] = [];
      for (const u of opts.updates ?? []) {
        const scene = this.scenes.find((s) => s._id === String(u._id));
        if (!scene) continue;
        if (typeof u.width === "number") scene.width = u.width;
        if (typeof u.height === "number") scene.height = u.height;
        if (typeof u.initialLevel === "string") scene.initialLevel = u.initialLevel;
        if (typeof u.navigation === "boolean") scene.navigation = u.navigation;
        const flags = u.flags as Record<string, Record<string, unknown>> | undefined;
        if (flags) {
          for (const [scope, values] of Object.entries(flags)) {
            scene.flags[scope] = { ...(scene.flags[scope] ?? {}), ...values };
          }
        }
        updated.push(scene as unknown as FakeDoc);
      }
      return updated;
    }
    if (type === "Scene" && action === "delete") {
      const removed = this.server.scenes.filter((s) => (opts.ids ?? []).includes(s._id));
      const kept = this.server.scenes.filter((s) => !(opts.ids ?? []).includes(s._id));
      this.server.scenes.splice(0, this.server.scenes.length, ...kept);
      return removed as unknown as FakeDoc[];
    }
    if ((type === "Tile" || type === "Wall" || type === "AmbientLight") && action === "create") {
      const scene = this.sceneOf(opts.parentUuid ?? "");
      const bucket = type === "Tile" ? scene.tiles : type === "Wall" ? scene.walls : scene.lights;
      const created = (opts.data ?? []).map((d) => ({ ...d, _id: this.nextId(type.toLowerCase()) }) as FakeDoc);
      bucket.push(...created);
      this.crashAfter(type === "Tile" ? "tiles" : type === "Wall" ? "walls" : "lights");
      return created;
    }
    if ((type === "Tile" || type === "Wall" || type === "AmbientLight") && action === "delete") {
      const scene = this.sceneOf(opts.parentUuid ?? "");
      const bucket = type === "Tile" ? scene.tiles : type === "Wall" ? scene.walls : scene.lights;
      const ids = new Set(opts.ids ?? []);
      const removed = bucket.filter((d) => ids.has(d._id));
      const kept = bucket.filter((d) => !ids.has(d._id));
      if (type === "Tile") scene.tiles = kept;
      else if (type === "Wall") scene.walls = kept;
      else scene.lights = kept;
      return removed;
    }
    throw new Error(`FakeLive: unsupported ${type}:${action}`);
  }
}

function asLive(fake: FakeLive): FoundryLive {
  return fake as unknown as FoundryLive;
}

function sceneDoc(fake: FakeLive, sceneId: string): FakeScene {
  const scene = fake.scenes.find((s) => s._id === sceneId);
  if (!scene) throw new Error(`no scene ${sceneId}`);
  return scene;
}

function createsOf(fake: FakeLive, type: string): number {
  return fake.calls.filter((c) => c === `${type}:create`).length;
}

// ---------------------------------------------------------------- live: build

describe("buildTileRoom — keyed (fake live)", () => {
  it("same key twice builds one scene; the second call creates nothing and posts once", async () => {
    const live = new FakeLive();
    const spec = { ...baseSpec, buildKey: KEY };
    const first = await buildTileRoom(asLive(live), spec, pack, BASE);
    const callsAfterFirst = live.calls.length;
    const second = await buildTileRoom(asLive(live), spec, pack, BASE);
    expect(second.sceneId).toBe(first.sceneId);
    expect(second.tileIds).toEqual(first.tileIds);
    expect(second.wallIds).toEqual(first.wallIds);
    expect(second.lightIds).toEqual(first.lightIds);
    expect(live.calls.length).toBe(callsAfterFirst); // memo hit: no server traffic at all
    expect(live.scenes).toHaveLength(1);
    expect(live.chats).toHaveLength(1); // description posted once, not on resume
    const scene = sceneDoc(live, first.sceneId);
    expect(scene.flags["foundry-live"]?.buildKey).toBe(KEY);
    expect(scene.tiles.every((t) => typeof (t.flags as Record<string, Record<string, unknown>> | undefined)?.["foundry-live"]?.tileRoomKey === "string")).toBe(true);
    expect(scene.initialLevel).not.toBeNull();
  });

  it("a different key builds a second scene", async () => {
    const live = new FakeLive();
    const a = await buildTileRoom(asLive(live), { ...baseSpec, buildKey: KEY }, pack, BASE);
    const b = await buildTileRoom(asLive(live), { ...baseSpec, name: "Other Room", buildKey: "tile-room:other" }, pack, BASE);
    expect(b.sceneId).not.toBe(a.sceneId);
    expect(live.scenes).toHaveLength(2);
  });

  it("unkeyed builds are unchanged: two builds, two scenes, no flags", async () => {
    const live = new FakeLive();
    const a = await buildTileRoom(asLive(live), baseSpec, pack, BASE);
    const b = await buildTileRoom(asLive(live), baseSpec, pack, BASE);
    expect(b.sceneId).not.toBe(a.sceneId);
    expect(live.scenes).toHaveLength(2);
    for (const scene of live.scenes) {
      expect(scene.flags).toEqual({});
      expect(scene.tiles.every((t) => t.flags === undefined)).toBe(true);
    }
  });

  it("crash after Scene create: retry converges to a full room, one scene", async () => {
    const server = newServer();
    const live = new FakeLive(server);
    live.failAfter = "scene";
    await expect(buildTileRoom(asLive(live), { ...baseSpec, buildKey: KEY }, pack, BASE)).rejects.toThrow(/simulated crash after scene/);
    expect(live.scenes).toHaveLength(1);
    expect(live.scenes[0].tiles).toHaveLength(0);
    expect(live.scenes[0].initialLevel).toBeNull();
    const retried = await buildTileRoom(asLive(live), { ...baseSpec, buildKey: KEY }, pack, BASE);
    expect(retried.sceneId).toBe(live.scenes[0]._id);
    expect(live.scenes).toHaveLength(1);
    const scene = sceneDoc(live, retried.sceneId);
    expect(scene.tiles.length).toBeGreaterThan(0);
    expect(scene.walls.length).toBeGreaterThan(0);
    expect(scene.lights).toHaveLength(1);
    expect(scene.initialLevel).not.toBeNull();
    expect(live.chats).toHaveLength(1);
  });

  it("crash after tiles: retry reuses the tiles and finishes walls + lights", async () => {
    const live = new FakeLive();
    live.failAfter = "tiles";
    await expect(buildTileRoom(asLive(live), { ...baseSpec, buildKey: KEY }, pack, BASE)).rejects.toThrow(/simulated crash after tiles/);
    const sceneBefore = live.scenes[0];
    const tileIdsBefore = sceneBefore.tiles.map((t) => t._id);
    expect(tileIdsBefore.length).toBeGreaterThan(0);
    expect(sceneBefore.walls).toHaveLength(0);
    const tileCreatesBefore = createsOf(live, "Tile");
    const retried = await buildTileRoom(asLive(live), { ...baseSpec, buildKey: KEY }, pack, BASE);
    expect(retried.tileIds).toEqual(tileIdsBefore);
    expect(createsOf(live, "Tile")).toBe(tileCreatesBefore); // no tile re-created
    expect(retried.wallIds).toHaveLength(sceneBefore.walls.length);
    expect(retried.lightIds).toHaveLength(1);
    expect(live.scenes).toHaveLength(1);
  });

  it("same-connection tile invisibility: the memo returns the original ids, zero creates", async () => {
    const live = new FakeLive();
    const first = await buildTileRoom(asLive(live), { ...baseSpec, buildKey: KEY }, pack, BASE);
    // Simulate the vendored client's cache gap: this connection can no
    // longer see the tiles it created.
    sceneDoc(live, first.sceneId).tiles = [];
    const callsBefore = live.calls.length;
    const second = await buildTileRoom(asLive(live), { ...baseSpec, buildKey: KEY }, pack, BASE);
    expect(second).toEqual(first);
    expect(live.calls.length).toBe(callsBefore);
  });

  it("fresh connection (empty memo) converges via the server scan", async () => {
    const server = newServer();
    const live1 = new FakeLive(server);
    const first = await buildTileRoom(asLive(live1), { ...baseSpec, buildKey: KEY }, pack, BASE);
    // A second connection to the same world: new live object, empty memo.
    const live2 = new FakeLive(server);
    const tileCreatesBefore = createsOf(live2, "Tile");
    const second = await buildTileRoom(asLive(live2), { ...baseSpec, buildKey: KEY }, pack, BASE);
    expect(second.sceneId).toBe(first.sceneId);
    expect(second.tileIds).toEqual(first.tileIds);
    expect(second.wallIds).toEqual(first.wallIds);
    expect(createsOf(live2, "Tile")).toBe(tileCreatesBefore);
    expect(server.scenes).toHaveLength(1);
    // The announcement is idempotent across connections too: the
    // first connection posted it, the second one's resume found it.
    expect(server.chats).toHaveLength(1);
  });

  it("a shrunk spec deletes the surplus keyed embeds on re-run", async () => {
    const live = new FakeLive();
    const first = await buildTileRoom(asLive(live), { ...baseSpec, buildKey: KEY }, pack, BASE);
    expect(first.lightIds).toHaveLength(1);
    const second = await buildTileRoom(
      asLive(live),
      { ...baseSpec, buildKey: KEY, torches: [], lights: [] },
      pack,
      BASE,
    );
    expect(second.sceneId).toBe(first.sceneId);
    expect(second.lightIds).toEqual([]);
    expect(sceneDoc(live, first.sceneId).lights).toHaveLength(0);
    // Floor/wall tiles are unchanged — kept, not re-created.
    expect(second.tileIds).toEqual(first.tileIds);
  });
});

describe("rebuildTileRoom — keyed (fake live)", () => {
  it("rebuild under the same key replaces embeds and a later build re-run converges", async () => {
    const live = new FakeLive();
    const built = await buildTileRoom(asLive(live), { ...baseSpec, buildKey: KEY }, pack, BASE);
    const rebuilt = await rebuildTileRoom(
      asLive(live),
      built.sceneId,
      { ...baseSpec, buildKey: KEY, gridW: 10 },
      pack,
      BASE,
      built,
    );
    expect(rebuilt.sceneId).toBe(built.sceneId);
    expect(rebuilt.tileIds).not.toEqual(built.tileIds);
    expect(sceneDoc(live, built.sceneId).tiles.length).toBe(10 * 6 + 28 + 1 + 1);
    // A later build re-run with the same key finds the rebuilt room.
    const again = await buildTileRoom(asLive(live), { ...baseSpec, buildKey: KEY, gridW: 10 }, pack, BASE);
    expect(again.sceneId).toBe(built.sceneId);
    expect(again.tileIds).toEqual(rebuilt.tileIds);
  });

  it("rebuild deletes keyed leftovers the caller does not know about", async () => {
    const live = new FakeLive();
    const built = await buildTileRoom(asLive(live), { ...baseSpec, buildKey: KEY }, pack, BASE);
    // Simulate a crashed rebuild's leftover: an extra keyed tile the
    // caller's `previous` never listed.
    sceneDoc(live, built.sceneId).tiles.push({
      _id: "tile-leftover",
      flags: { "foundry-live": { tileRoomKey: `${KEY}:tile:999` } },
    } as FakeDoc);
    const rebuilt = await rebuildTileRoom(
      asLive(live),
      built.sceneId,
      { ...baseSpec, buildKey: KEY },
      pack,
      BASE,
      built,
    );
    expect(sceneDoc(live, built.sceneId).tiles.some((t) => t._id === "tile-leftover")).toBe(false);
    expect(rebuilt.tileIds).not.toContain("tile-leftover");
  });

  it("rebuild stamps the scene key when the scene was built unkeyed", async () => {
    const live = new FakeLive();
    const built = await buildTileRoom(asLive(live), baseSpec, pack, BASE);
    expect(sceneDoc(live, built.sceneId).flags).toEqual({});
    const rebuilt = await rebuildTileRoom(
      asLive(live),
      built.sceneId,
      { ...baseSpec, buildKey: KEY },
      pack,
      BASE,
      built,
    );
    expect(sceneDoc(live, built.sceneId).flags["foundry-live"]?.buildKey).toBe(KEY);
    // And now a keyed build re-run finds it instead of duplicating.
    const again = await buildTileRoom(asLive(live), { ...baseSpec, buildKey: KEY }, pack, BASE);
    expect(again.sceneId).toBe(rebuilt.sceneId);
  });
});

describe("buildDungeon — keyed (fake live)", () => {
  it("re-running a keyed dungeon returns the same scenes", async () => {
    const live = new FakeLive();
    const spec = {
      rooms: [
        { id: "hall", name: "Entry Hall", gridW: 8, gridH: 6, seed: 1, doors: [{ wall: "south" as const, at: 3 }] },
        { id: "crypt", name: "Crypt", gridW: 6, gridH: 6, seed: 2, doors: [{ wall: "north" as const, at: 2 }] },
      ],
      links: [{ from: { room: "hall", wall: "south" as const, at: 3 }, to: { room: "crypt", wall: "north" as const, at: 2 } }],
    };
    const first = await buildDungeon(asLive(live), spec, pack, BASE, undefined, { buildKey: "dungeon-1" });
    expect(first.rooms).toHaveLength(2);
    expect(live.scenes).toHaveLength(2);
    const sceneCreatesBefore = createsOf(live, "Scene");
    const second = await buildDungeon(asLive(live), spec, pack, BASE, undefined, { buildKey: "dungeon-1" });
    expect(second.rooms.map((r) => r.sceneId)).toEqual(first.rooms.map((r) => r.sceneId));
    expect(createsOf(live, "Scene")).toBe(sceneCreatesBefore);
    expect(live.scenes).toHaveLength(2);
  });
});

describe("build-exec — crash retry through executeBuild (fake live)", () => {
  it("a re-issued create after a lost in-memory session converges to the same scene", async () => {
    const server = newServer();
    const live = new FakeLive(server);
    const op = {
      type: "create-room" as const,
      name: "Entry Hall",
      gridW: 8,
      gridH: 6,
      doors: [{ wall: "south" as const }],
      chest: false,
      torches: true,
      fog: false,
    };
    const session1 = new BuildSession();
    const built1 = new Map();
    await executeBuild(asLive(live), session1, op, "build an entry hall", { pack, serverBase: BASE, built: built1 });
    expect(server.scenes).toHaveLength(1);
    const roomId = session1.current().dungeon.rooms[0].id;
    const sceneId = (built1.get(roomId) as { sceneId: string }).sceneId;
    // Crash: the process restarts with a fresh session and an empty
    // built map, but the world persists. The GM re-issues the build.
    const session2 = new BuildSession();
    const built2 = new Map();
    await executeBuild(asLive(live), session2, op, "build an entry hall", { pack, serverBase: BASE, built: built2 });
    expect(server.scenes).toHaveLength(1);
    expect((built2.get(roomId) as { sceneId: string }).sceneId).toBe(sceneId);
  });
});
