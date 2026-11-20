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

export interface SceneSpec {
  name: string;
  /** Local file (uploaded) or server-relative path (used as-is). */
  imagePath: string;
  width: number;
  height: number;
  /** Grid size in pixels. Default: 100. */
  gridSize?: number;
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
}

export interface BuiltChest {
  actorId: string;
  tokenId: string;
  itemIds: string[];
}

const CHEST_IMG = "icons/containers/chest/chest-wooden-tied-white.webp";

/** Create a Scene. A local imagePath is uploaded first (target worlds/<world>/maps). */
export async function createSceneFromImage(
  live: FoundryLive,
  spec: SceneSpec,
): Promise<string> {
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
  const created = await live.modifyDocument("Scene", "create", {
    data: [{
      name: spec.name,
      width: spec.width,
      height: spec.height,
      grid: { size: spec.gridSize ?? 100, type: 1, distance: 5, units: "ft" },
      navigation: true,
    }],
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
  await live.modifyDocument("Scene", "update", {
    updates: [{ _id: id, initialLevel: levelId }],
  });
  return id;
}

/** Add walls to a scene. Returns the created Wall _ids. */
export async function addWalls(
  live: FoundryLive,
  sceneId: string,
  walls: WallSpec[],
): Promise<string[]> {
  const created = await live.modifyDocument("Wall", "create", {
    data: walls.map((w) => ({
      c: [w.x1, w.y1, w.x2, w.y2],
      move: 1,
      sense: 1,
      light: 1,
      sound: 1,
      dir: 0,
      door: w.door ?? 0,
      ds: 0,
    })),
    parentUuid: `Scene.${sceneId}`,
  });
  return created.map((d) => String(d._id));
}

/** Add lights to a scene. Returns the created AmbientLight _ids. */
export async function addLights(
  live: FoundryLive,
  sceneId: string,
  lights: LightSpec[],
): Promise<string[]> {
  const created = await live.modifyDocument("AmbientLight", "create", {
    data: lights.map((l) => ({
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
    })),
    parentUuid: `Scene.${sceneId}`,
  });
  return created.map((d) => String(d._id));
}

/**
 * Add an openable chest: a `loot` actor holding the loot items, plus a
 * token on the scene linked to it. Returns actor/token/item ids.
 */
export async function addChest(
  live: FoundryLive,
  sceneId: string,
  spec: ChestSpec,
): Promise<BuiltChest> {
  const name = spec.name ?? "Old Chest";
  const actorCreated = await live.modifyDocument("Actor", "create", {
    data: [{ name, type: "loot", img: CHEST_IMG }],
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
  },
): Promise<{ sceneId: string; wallIds: string[]; lightIds: string[]; chest: BuiltChest | null }> {
  const sceneId = await createSceneFromImage(live, {
    name: opts.name,
    imagePath: opts.imagePath,
    width: opts.width,
    height: opts.height,
    gridSize: opts.gridSize,
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
  const chest = opts.chest ? await addChest(live, sceneId, opts.chest) : null;
  await live.sendChat(
    `🏰 **${opts.name}**\n${opts.description}` +
      (chest ? `\nThere is a chest here, waiting to be opened.` : ""),
  );
  return { sceneId, wallIds, lightIds, chest };
}
