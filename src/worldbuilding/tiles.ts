/**
 * Tile composer — LIVE build functions (needs a Foundry connection).
 *
 * The pure composition math lives in `tiles-layout.ts` (unit-testable
 * without a connection); this module builds a laid-out room on the
 * server: Scene + Level + Tile/Wall/Light embeds.
 *
 * Scene shape for a tile room: the scene has NO background image — the
 * tiles ARE the map. The Level still exists (a scene with no Level will
 * not load at all — the Lich's Lair bug, Nov 19) and carries a plain
 * dark background colour from the room's theme
 * (`background: { color: theme.backgroundColor, src: null }` — "#050508"
 * for the dungeon baseline). That colour-only background is a
 * live-verification item: it is what an empty scene's level looks like,
 * but it has not been seen on screen yet.
 *
 * Caveats (all live-verification items, see BACKLOG.md):
 * - The vendored client's world cache does not track Tile documents
 *   (EMBEDDED_COLLECTIONS has no Tile entry), so a connection never sees
 *   its own tile creates — verify tiles on a FRESH connection, and keep
 *   the ids buildTileRoom returns if you later want to rebuild/resize.
 * - Wall-tile rotation and the colour-only Level background are schema-
 *   verified, not yet seen on screen.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { FoundryLive } from "../live.js";
import type { DungeonLayout, DungeonSpec, PackManifest, ResolvedDoorLink, RoomSpec, WallSide } from "./tiles-layout.js";
import { TILE_PX, layoutDungeon, layoutRoom } from "./tiles-layout.js";
import { resolveTheme, type ThemeSpec } from "./themes.js";
import { addLights, addWalls } from "./index.js";
import { deleteToken, placeToken, resolveToken } from "../session/movement.js";
import { uploadImage } from "./upload.js";

export * from "./tiles-layout.js";

export interface BuiltTileRoom {
  sceneId: string;
  tileIds: string[];
  wallIds: string[];
  lightIds: string[];
}

/**
 * Create a tile room on the server: Scene + Level (colour-only
 * background — the tiles are the map) + Tile/Wall/Light embeds.
 * The scene is NOT activated (the GM activates it when ready).
 * GM users are added as owners (role 4) so the DM can edit the scene —
 * the ownership gap that bit Lich's Lair (BACKLOG.md).
 *
 * @param theme an explicit theme (one-word name or ThemeSpec) — it
 *   overrides `spec.theme`; with neither, the dungeon baseline.
 *   The theme picks the floor/wall tiles, the fog remap, the torch
 *   palette, and the Level background colour (FR-2).
 */
export async function buildTileRoom(
  live: FoundryLive,
  spec: RoomSpec,
  pack: import("./tiles-layout.js").Pack,
  serverBase: string,
  theme?: string | ThemeSpec,
): Promise<BuiltTileRoom> {
  const resolved = resolveTheme(theme ?? spec.theme);
  const layout = layoutRoom(spec, pack, serverBase, resolved);
  const gms = live.getUsers().filter((u) => u.role === 4);
  const ownership: Record<string, number> = { default: 0 };
  for (const gm of gms) ownership[gm._id] = 3;
  if (live.userId) ownership[live.userId] = 3;

  const created = await live.modifyDocument("Scene", "create", {
    data: [{
      name: spec.name,
      width: layout.width,
      height: layout.height,
      grid: { size: TILE_PX, type: 1, distance: 5, units: "ft" },
      navigation: true,
      ownership,
    }],
  });
  const sceneId = String(created[0]?._id ?? "");
  if (!sceneId) throw new Error("Scene create returned no _id.");

  // v14: the map lives on a Level. A tile room has no background image,
  // so the Level carries a plain dark colour from the theme instead of
  // a src.
  const levels = await live.modifyDocument("Level", "create", {
    data: [{
      name: spec.name,
      background: { color: resolved.backgroundColor, src: null, tint: "#ffffff", alphaThreshold: 0.75 },
      foreground: { src: null, tint: "#ffffff", alphaThreshold: 0.75 },
      elevation: { top: 20, bottom: 0 },
      fog: { src: null },
      textures: { anchorX: 0.5, anchorY: 0.5, offsetX: 0, offsetY: 0, fit: "fill", scaleX: 1, scaleY: 1, rotation: 0 },
      visibility: { levels: [] },
      sort: 0,
      flags: {},
    }],
    parentUuid: `Scene.${sceneId}`,
  });
  const levelId = String(levels[0]?._id ?? "");
  if (!levelId) throw new Error("Level create returned no _id.");
  await live.modifyDocument("Scene", "update", {
    updates: [{ _id: sceneId, initialLevel: levelId }],
  });

  // Tiles in one create — the vendored client's cache does not track
  // Tile documents, so verify on a FRESH connection, not this one.
  const tileCreated = await live.modifyDocument("Tile", "create", {
    data: layout.tiles,
    parentUuid: `Scene.${sceneId}`,
  });
  const tileIds = tileCreated.map((d) => String(d._id));
  const wallIds = await addWalls(live, sceneId, layout.walls);
  const lightIds = await addLights(live, sceneId, layout.lights);

  if (spec.description) {
    await live.sendChat(`🏰 **${spec.name}**\n${spec.description}`);
  }
  return { sceneId, tileIds, wallIds, lightIds };
}

/**
 * Resize a tile room in place: delete the previous build's tiles/walls/
 * lights (by the ids buildTileRoom returned — the caller keeps them, the
 * client's cache cannot re-derive them) and apply the new layout.
 * Changing gridW/gridH is all it takes; no new images are involved.
 * A `theme` here re-skins the room at the same time (FR-2) — same
 * layout, new look.
 */
export async function rebuildTileRoom(
  live: FoundryLive,
  sceneId: string,
  spec: RoomSpec,
  pack: import("./tiles-layout.js").Pack,
  serverBase: string,
  previous: { tileIds: string[]; wallIds: string[]; lightIds: string[] },
  theme?: string | ThemeSpec,
): Promise<BuiltTileRoom> {
  const resolved = resolveTheme(theme ?? spec.theme);
  const parentUuid = `Scene.${sceneId}`;
  if (previous.tileIds.length > 0) {
    await live.modifyDocument("Tile", "delete", { ids: previous.tileIds, parentUuid });
  }
  if (previous.wallIds.length > 0) {
    await live.modifyDocument("Wall", "delete", { ids: previous.wallIds, parentUuid });
  }
  if (previous.lightIds.length > 0) {
    await live.modifyDocument("AmbientLight", "delete", { ids: previous.lightIds, parentUuid });
  }
  const layout = layoutRoom(spec, pack, serverBase, resolved);
  await live.modifyDocument("Scene", "update", {
    updates: [{ _id: sceneId, width: layout.width, height: layout.height }],
  });
  const tileCreated = await live.modifyDocument("Tile", "create", {
    data: layout.tiles,
    parentUuid,
  });
  const tileIds = tileCreated.map((d) => String(d._id));
  const wallIds = await addWalls(live, sceneId, layout.walls);
  const lightIds = await addLights(live, sceneId, layout.lights);
  return { sceneId, tileIds, wallIds, lightIds };
}

/**
 * Upload the whole pack to the Foundry server, one file at a time.
 * Target defaults to the world folder itself (it always exists — the
 * server will not create subfolders). Pass "worlds/<world>/tiles" once
 * the GM has created that folder in the FilePicker. Returns the server
 * base to pass to layoutRoom/buildTileRoom.
 */
export async function uploadTilePack(
  live: FoundryLive,
  tilesDir: string,
  target?: string,
): Promise<string> {
  const manifestPath = path.join(tilesDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as PackManifest;
  const title = live.getWorldSummary().title ?? "testbed";
  const worldFolder = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const dest = target ?? `worlds/${worldFolder}`;
  for (const entry of manifest.tiles) {
    const local = path.join(tilesDir, entry.file);
    await uploadImage(local, dest);
  }
  return dest;
}

// ---------------------------------------------------------------- dungeon graph (live)

export interface BuiltDungeonRoom extends BuiltTileRoom {
  id: string;
}

export interface BuiltDungeon {
  rooms: BuiltDungeonRoom[];
  links: ResolvedDoorLink[];
}

/**
 * Build a whole dungeon: one scene per room (via buildTileRoom), plus
 * the resolved door links. Scenes are NOT activated — the GM activates
 * the entry room when ready. Pure layout/validation happens first in
 * layoutDungeon, so a bad graph fails before any scene is created.
 * A `theme` here re-skins every room that does not set its own
 * (FR-2) — one call, whole dungeon, new look.
 */
export async function buildDungeon(
  live: FoundryLive,
  spec: DungeonSpec,
  pack: import("./tiles-layout.js").Pack,
  serverBase: string,
  theme?: string | ThemeSpec,
): Promise<BuiltDungeon> {
  const dungeon: DungeonLayout = layoutDungeon(spec, pack, serverBase, theme);
  const rooms: BuiltDungeonRoom[] = [];
  for (const room of spec.rooms) {
    const built = await buildTileRoom(live, room, pack, serverBase, theme);
    rooms.push({ id: room.id, ...built });
  }
  return { rooms, links: dungeon.links };
}

export interface DoorWalkResult {
  fromRoom: string;
  toRoom: string;
  toSceneId: string;
  /** Old token _id -> new token _id (tokens are re-created on the new
   *  scene — Foundry has no cross-scene token move). */
  tokens: { oldId: string; newId: string; name: string }[];
}

/**
 * Walk the party through a door: tokens leave the `fromRoom` scene and
 * appear in the linked room, just inside the matching door. Tokens are
 * deleted on the old scene and re-placed on the new one (actorLink, so
 * HP and conditions live on the actor and survive the move); the new
 * token _ids are returned because the old ones no longer exist.
 * Live-verification item: not yet walked on a real table.
 */
export async function walkThroughDoor(
  live: FoundryLive,
  dungeon: BuiltDungeon,
  fromRoom: string,
  wall: WallSide,
  at: number,
  tokenIds: string[],
): Promise<DoorWalkResult> {
  const key = `${fromRoom}:${wall}:${at}`;
  let other: ResolvedDoorLink["to"] | null = null;
  let toRoom = "";
  for (const link of dungeon.links) {
    if (`${link.from.room}:${link.from.wall}:${link.from.at}` === key) {
      other = link.to;
      toRoom = link.to.room;
      break;
    }
    if (`${link.to.room}:${link.to.wall}:${link.to.at}` === key) {
      other = link.from;
      toRoom = link.from.room;
      break;
    }
  }
  if (!other) {
    throw new Error(`No door link from ${key} — the door is unlinked or not a door.`);
  }
  const fromScene = dungeon.rooms.find((r) => r.id === fromRoom);
  const toScene = dungeon.rooms.find((r) => r.id === toRoom);
  if (!fromScene || !toScene) throw new Error(`Dungeon is missing a scene for ${!fromScene ? fromRoom : toRoom}.`);
  const x = other.enterGx * TILE_PX + TILE_PX / 2;
  const y = other.enterGy * TILE_PX + TILE_PX / 2;
  const moved: DoorWalkResult["tokens"] = [];
  for (const tokenId of tokenIds) {
    const token = resolveToken(live, fromScene.sceneId, tokenId);
    if (!token.actorId) throw new Error(`Token ${token.name} has no actor — cannot re-place it in ${toRoom}.`);
    await deleteToken(live, fromScene.sceneId, token._id);
    const newId = await placeToken(live, toScene.sceneId, token.actorId, x, y, { name: token.name });
    moved.push({ oldId: token._id, newId, name: token.name });
  }
  return { fromRoom, toRoom, toSceneId: toScene.sceneId, tokens: moved };
}
