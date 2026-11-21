/**
 * World building (P1.4 / phase 2) — build a scene from a map image, add
 * walls, lights, and interactive tokens (chests) through the same
 * `modifyDocument` socket protocol the rest of the library uses.
 *
 * Document shapes (Foundry 14.370, verified live Nov 19):
 * - Scene: { name, width, height, grid: { size, type: 1, distance: 5, units: "ft" }, navigation }
 *   A scene has NO background of its own in v14. The map lives on a Level:
 *   the scene MUST have at least one Level or the canvas has nothing to
 *   render and the scene will not load — this was the Lich's Lair bug
 *   (scene created with scene-level `background: {src}` only, `levels: []`,
 *   `initialLevel: null`; the update was accepted with no error and the
 *   background never showed). The worldData snapshot never exposes the
 *   level background either, so verify by reading `levels` back on a fresh
 *   connection, not from the snapshot's scene fields.
 * - Level (embedded in Scene): { name, background: { color, src, tint, alphaThreshold }, foreground: { src, tint, alphaThreshold }, elevation: { top: 20, bottom: 0 }, fog: { src: null }, textures: { anchorX: 0.5, anchorY: 0.5, offsetX: 0, offsetY: 0, fit: "fill", scaleX: 1, scaleY: 1, rotation: 0 }, visibility: { levels: [] }, sort: 0 }
 *   Create it right after the scene, then set the scene's `initialLevel`
 *   to the level's REAL _id as returned by the create — the server assigns
 *   its own _id and ignores a requested one.
 * - Wall (embedded in Scene): { c: [x1, y1, x2, y2], move: 1, sense: 1, light: 1, sound: 1, dir: 0, door: 0, ds: 0 }
 *   (move/sense/light/sound 1 = blocks; door 0 = plain wall, 1 = door, 2 = secret; ds = door state)
 * - AmbientLight (embedded in Scene): { x, y, rotation: 0, config: { dim, bright, angle, color, alpha }, hidden: false }
 * - Token (embedded in Scene): { name, actorId, actorLink, x, y, width, height, texture: { src }, disposition }
 *
 * Chest interactivity (the PF2e route that actually works): a Token linked
 * to a `loot`-type Actor holding Item documents. Players open the token,
 * the loot sheet opens, and they take items onto their own sheets. That is
 * the native PF2e loot flow — a journal entry would only be text, and a
 * roll-table roll is a one-off, not an openable chest.
 *
 * Image paths: `createSceneFromImage` accepts a local file (uploaded first
 * via src/worldbuilding/upload.ts — the upload gap is closed, see that
 * module) or a path already on the server.
 */
import * as fs from "node:fs";
import type { FoundryLive } from "../live.js";
import { uploadImage } from "./upload.js";
import { FLAG_FIELDS, docHasFlag, findDocByFlag, flagValue } from "../idempotency.js";

export interface SceneSpec {
  name: string;
  /** Local file (uploaded) or server-relative path (used as-is). */
  imagePath: string;
  width: number;
  height: number;
  /** Grid size in pixels. Default: 100. */
  gridSize?: number;
  /**
   * Idempotency key for this scene. When set, the key is stored in the
   * scene's flags and a re-run returns the already-created scene instead
   * of creating a second one. Without it, behavior is unchanged.
   */
  buildKey?: string;
}

export interface WallSpec {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** 0 = plain wall, 1 = door, 2 = secret door. Default: 0. */
  door?: number;
}

export interface LightSpec {
  x: number;
  y: number;
  /** Dim radius in pixels. */
  dim: number;
  /** Bright radius in pixels. */
  bright: number;
  /** Light cone angle in degrees. Default: 360. */
  angle?: number;
  /** Hex color. Default: "#ff9a3c" (warm torchlight). */
  color?: string;
}

export interface LootSpec {
  name: string;
  /** PF2e item type. Default: "treasure". */
  type?: string;
  /** Price in gp. */
  price?: number;
  quantity?: number;
}

export interface ChestSpec {
  x: number;
  y: number;
  name?: string;
  loot?: LootSpec[];
  /**
   * Idempotency key for this chest. When set, the key is stored in the
   * loot actor's flags and a re-run returns the already-created chest
   * instead of creating a second actor + token. Without it, behavior is
   * unchanged.
   */
  key?: string;
}

export interface BuiltChest {
  actorId: string;
  tokenId: string;
  itemIds: string[];
}

const CHEST_IMG = "icons/containers/chest/chest-wooden-tied-white.webp";

interface RawSceneDoc {
  _id: string;
  name?: string;
  flags?: Record<string, Record<string, unknown> | undefined> | null;
  tokens?: { _id: string; actorId?: string }[];
}

/**
 * Find a scene already created under this build key, or null. Reads
 * current world state — the check a keyed re-run makes before creating.
 */
export function findSceneByBuildKey(live: FoundryLive, buildKey: string): string | null {
  const raw = live.raw() as unknown as {
    getScenes(): RawSceneDoc[];
  };
  const found = findDocByFlag(raw.getScenes(), FLAG_FIELDS.sceneBuild, buildKey);
  return found ? found._id : null;
}

/** Create a Scene. A local imagePath is uploaded first (target worlds/<world>/maps). */
export async function createSceneFromImage(
  live: FoundryLive,
  spec: SceneSpec,
): Promise<string> {
  // Keyed resume: the scene already exists — return it. The Level, walls
  // and lights were built with it; creating again would duplicate the room.
  if (spec.buildKey) {
    const existing = findSceneByBuildKey(live, spec.buildKey);
    if (existing) return existing;
  }
  let img = spec.imagePath;
  if (fs.existsSync(spec.imagePath)) {
    // Upload first: the scene background must live on the Foundry server.
    // Target folder is the world's data folder, derived from the world
    // title. (The server will not create subfolders, so upload to the
    // world folder itself, which always exists.)
    const title = live.getWorldSummary().title ?? "testbed";
    const worldFolder = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const uploaded = await uploadImage(spec.imagePath, `worlds/${worldFolder}`);
    img = uploaded.path;
  }
  const sceneData: Record<string, unknown> = {
    name: spec.name,
    width: spec.width,
    height: spec.height,
    grid: { size: spec.gridSize ?? 100, type: 1, distance: 5, units: "ft" },
    navigation: true,
  };
  if (spec.buildKey) sceneData.flags = flagValue(FLAG_FIELDS.sceneBuild, spec.buildKey);
  const created = await live.modifyDocument("Scene", "create", {
    data: [sceneData],
  });
  const id = String(created[0]?._id ?? "");
  if (!id) throw new Error("Scene create returned no _id.");
  // v14: the map lives on a Level, not on the scene. A scene with no Level
  // will not load at all (Lich's Lair bug, Nov 19). Create the default
  // level carrying the background, then point initialLevel at its real _id
  // (the server assigns its own _id — a requested one is ignored).
  const levels = await live.modifyDocument("Level", "create", {
    data: [{
      name: spec.name,
      background: { color: "#000000", src: img, tint: "#ffffff", alphaThreshold: 0.75 },
      foreground: { src: null, tint: "#ffffff", alphaThreshold: 0.75 },
      elevation: { top: 20, bottom: 0 },
      fog: { src: null },
      textures: { anchorX: 0.5, anchorY: 0.5, offsetX: 0, offsetY: 0, fit: "fill", scaleX: 1, scaleY: 1, rotation: 0 },
      visibility: { levels: [] },
      sort: 0,
      flags: {},
    }],
    parentUuid: `Scene.${id}`,
  });
  const levelId = String(levels[0]?._id ?? "");
  if (!levelId) throw new Error("Level create returned no _id.");
  // Set initialLevel AND navigation in one post-create update. The create
  // silently drops `navigation: true` (the Nov 19 monitor session found
  // it stored as false despite being sent) — an update after create is
  // the only way the field sticks. Do NOT set scene-level `background`
  // here: that update is accepted with no error and does nothing in v14
  // (the earlier wrong "fix"); the Level above carries the map.
  await live.modifyDocument("Scene", "update", {
    updates: [{ _id: id, initialLevel: levelId, navigation: true }],
  });
  return id;
}

/**
 * Add walls to a scene. Returns the created Wall _ids.
 *
 * With `opts.embedKeys`, the i-th wall is stamped with
 * `flags["foundry-live"].tileRoomKey = embedKeys[i]` (BRA-202) so a
 * keyed re-run can find it again. Without it, behavior is unchanged.
 */
export async function addWalls(
  live: FoundryLive,
  sceneId: string,
  walls: WallSpec[],
  opts: { embedKeys?: string[] } = {},
): Promise<string[]> {
  const created = await live.modifyDocument("Wall", "create", {
    data: walls.map((w, i) => ({
      c: [w.x1, w.y1, w.x2, w.y2],
      move: 1,
      sense: 1,
      light: 1,
      sound: 1,
      dir: 0,
      door: w.door ?? 0,
      ds: 0,
      ...(opts.embedKeys?.[i] ? { flags: flagValue(FLAG_FIELDS.tileRoom, opts.embedKeys[i]) } : {}),
    })),
    parentUuid: `Scene.${sceneId}`,
  });
  return created.map((d) => String(d._id));
}

/**
 * Add lights to a scene. Returns the created AmbientLight _ids.
 *
 * With `opts.embedKeys`, the i-th light is stamped with
 * `flags["foundry-live"].tileRoomKey = embedKeys[i]` (BRA-202) so a
 * keyed re-run can find it again. Without it, behavior is unchanged.
 */
export async function addLights(
  live: FoundryLive,
  sceneId: string,
  lights: LightSpec[],
  opts: { embedKeys?: string[] } = {},
): Promise<string[]> {
  const created = await live.modifyDocument("AmbientLight", "create", {
    data: lights.map((l, i) => ({
      x: l.x,
      y: l.y,
      rotation: 0,
      config: {
        dim: l.dim,
        bright: l.bright,
        angle: l.angle ?? 360,
        color: l.color ?? "#ff9a3c",
        alpha: 0.5,
      },
      hidden: false,
      ...(opts.embedKeys?.[i] ? { flags: flagValue(FLAG_FIELDS.tileRoom, opts.embedKeys[i]) } : {}),
    })),
    parentUuid: `Scene.${sceneId}`,
  });
  return created.map((d) => String(d._id));
}

/**
 * Add an openable chest: a `loot` actor holding the loot items, plus a
 * token on the scene linked to it. Returns actor/token/item ids.
 *
 * With `spec.key`, the chest is retry-safe: the key is stored in the loot
 * actor's flags, and a re-run returns the already-created actor + token
 * (with the item ids it already holds) instead of creating a second chest.
 */
export async function addChest(
  live: FoundryLive,
  sceneId: string,
  spec: ChestSpec,
): Promise<BuiltChest> {
  const name = spec.name ?? "Old Chest";
  if (spec.key) {
    const found = (await live.searchActors(name)) as {
      actors?: { _id: string; name: string }[];
    };
    for (const candidate of found.actors ?? []) {
      const actor = (await live.getActorDetails(candidate._id)) as {
        _id?: string;
        flags?: Record<string, Record<string, unknown> | undefined> | null;
        items?: { _id: string }[];
      } | null;
      if (actor && docHasFlag(actor, FLAG_FIELDS.chest, spec.key)) {
        const actorId = String(actor._id ?? candidate._id);
        const raw = live.raw() as unknown as { getScenes(): RawSceneDoc[] };
        const scene = raw.getScenes().find((s) => s._id === sceneId);
        const token = scene?.tokens?.find((t) => t.actorId === actorId);
        if (token) {
          return {
            actorId,
            tokenId: token._id,
            itemIds: (actor.items ?? []).map((i) => String(i._id)),
          };
        }
      }
    }
  }
  const actorData: Record<string, unknown> = { name, type: "loot", img: CHEST_IMG };
  if (spec.key) actorData.flags = flagValue(FLAG_FIELDS.chest, spec.key);
  const actorCreated = await live.modifyDocument("Actor", "create", {
    data: [actorData],
  });
  const actorId = String(actorCreated[0]?._id ?? "");
  if (!actorId) throw new Error("Loot actor create returned no _id.");
  const itemIds: string[] = [];
  if (spec.loot && spec.loot.length > 0) {
    const itemsCreated = await live.modifyDocument("Item", "create", {
      data: spec.loot.map((item) => ({
        name: item.name,
        type: item.type ?? "treasure",
        system: {
          quantity: item.quantity ?? 1,
          price: { value: item.price ?? 0, denomination: "gp" },
        },
      })),
      parentUuid: `Actor.${actorId}`,
    });
    itemIds.push(...itemsCreated.map((d) => String(d._id)));
  }
  const tokenCreated = await live.modifyDocument("Token", "create", {
    data: [{
      name,
      actorId,
      actorLink: true,
      x: spec.x,
      y: spec.y,
      width: 1,
      height: 1,
      texture: { src: CHEST_IMG },
      disposition: 0,
    }],
    parentUuid: `Scene.${sceneId}`,
  });
  const tokenId = String(tokenCreated[0]?._id ?? "");
  if (!tokenId) throw new Error("Chest token create returned no _id.");
  return { actorId, tokenId, itemIds };
}

/** Delete a scene (its walls, lights and tokens go with it). */
export async function deleteScene(live: FoundryLive, sceneId: string): Promise<void> {
  await live.modifyDocument("Scene", "delete", { ids: [sceneId] });
}

/** Delete an actor (used to clean up a chest's loot actor). */
export async function deleteActor(live: FoundryLive, actorId: string): Promise<void> {
  await live.modifyDocument("Actor", "delete", { ids: [actorId] });
}

/** Activate a scene (switches the table's view to it). The GM's call — the builder never activates by itself. */
export async function activateScene(live: FoundryLive, sceneId: string): Promise<void> {
  await live.modifyDocument("Scene", "update", {
    updates: [{ _id: sceneId, active: true }],
  });
}

/**
 * Build a whole room in one call: scene + rectangle walls + lights + a
 * chest, then post the room description to chat. The scene is NOT
 * activated (the GM activates it when ready).
 *
 * With `opts.buildKey`, the build is retry-safe: a re-run finds the
 * scene already built and returns `{ sceneId, duplicate: true }` (with
 * empty wall/light/chest lists — the originals already exist in the
 * world) instead of building a second room. The chest gets the key
 * `<buildKey>:chest` and the announcement `<buildKey>:announce`.
 */
export async function buildRoom(
  live: FoundryLive,
  opts: {
    name: string;
    imagePath: string;
    width: number;
    height: number;
    gridSize?: number;
    description: string;
    lights?: LightSpec[];
    chest?: ChestSpec & { loot?: LootSpec[] };
    doorAt?: { x1: number; y1: number; x2: number; y2: number };
    buildKey?: string;
  },
): Promise<{ sceneId: string; wallIds: string[]; lightIds: string[]; chest: BuiltChest | null; duplicate?: boolean }> {
  if (opts.buildKey) {
    const existing = findSceneByBuildKey(live, opts.buildKey);
    if (existing) {
      return { sceneId: existing, wallIds: [], lightIds: [], chest: null, duplicate: true };
    }
  }
  const sceneId = await createSceneFromImage(live, {
    name: opts.name,
    imagePath: opts.imagePath,
    width: opts.width,
    height: opts.height,
    gridSize: opts.gridSize,
    buildKey: opts.buildKey,
  });
  const { width, height } = opts;
  const walls: WallSpec[] = [
    { x1: 0, y1: 0, x2: width, y2: 0 },
    { x1: width, y1: 0, x2: width, y2: height },
    { x1: width, y1: height, x2: 0, y2: height },
    { x1: 0, y1: height, x2: 0, y2: 0 },
  ];
  if (opts.doorAt) walls.push({ ...opts.doorAt, door: 1 });
  const wallIds = await addWalls(live, sceneId, walls);
  const lightIds = await addLights(live, sceneId, opts.lights ?? []);
  const chest = opts.chest
    ? await addChest(live, sceneId, {
        ...opts.chest,
        key: opts.buildKey ? `${opts.buildKey}:chest` : opts.chest.key,
      })
    : null;
  const announce =
    `🏰 **${opts.name}**\n${opts.description}` +
    (chest ? `\nThere is a chest here, waiting to be opened.` : "");
  if (opts.buildKey) {
    await live.sendChatIdempotent(announce, { dedupeKey: `${opts.buildKey}:announce` });
  } else {
    await live.sendChat(announce);
  }
  return { sceneId, wallIds, lightIds, chest };
}
