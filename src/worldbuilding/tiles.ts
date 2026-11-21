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
import { FLAG_FIELDS, flagValue } from "../idempotency.js";
import { findSceneByBuildKey } from "./index.js";
import {
  extractTileRoomEmbeds,
  parseTileEmbedKey,
  planTileRoomConverge,
  sceneHasTileRoomKey,
  tileEmbedKey,
  type KeyedEmbed,
} from "./tile-keys.js";
import { addLights, addWalls } from "./index.js";
import { deleteToken, placeToken, resolveToken } from "../session/movement.js";
import { uploadImage } from "./upload.js";

export * from "./tiles-layout.js";
export { tileRoomBuildKey } from "./tile-keys.js";

/**
 * In-process memo of keyed tile-room builds, per connection. The live
 * client's cache never sees its own Tile creates (no Tile entry in
 * EMBEDDED_COLLECTIONS), so without this a same-connection re-run
 * would miss in the scene scan and duplicate the tiles — the same
 * reason `live.ts` keeps `sentDedupeKeys`. A fresh connection
 * re-scans the server instead; the memo is a cache, never the source
 * of truth, and it is keyed by the live object so it dies with the
 * connection. The memo also records the layout fingerprint: a re-run
 * with the same key but a CHANGED spec is not a retry, it is a new
 * layout for the same room — a fingerprint mismatch falls through to
 * the server converge instead of returning stale ids.
 */
const tileRoomMemo = new WeakMap<
  FoundryLive,
  Map<string, { built: BuiltTileRoom; fingerprint: string }>
>();

/** Stable fingerprint of what a build should look like (deterministic
 *  layout: dims, tiles, walls, lights). */
function tileRoomFingerprint(layout: import("./tiles-layout.js").RoomLayout): string {
  return JSON.stringify(layout);
}

function memoizeTileRoom(
  live: FoundryLive,
  key: string,
  built: BuiltTileRoom,
  fingerprint: string,
): void {
  let perLive = tileRoomMemo.get(live);
  if (!perLive) {
    perLive = new Map();
    tileRoomMemo.set(live, perLive);
  }
  perLive.set(key, { built, fingerprint });
}

export interface BuiltTileRoom {
  sceneId: string;
  tileIds: string[];
  wallIds: string[];
  lightIds: string[];
}

/**
 * Create the Level for a tile room (factored out of buildTileRoom so
 * a keyed re-run can finish one a crash interrupted — see
 * convergeTileRoom). The Level carries a plain dark colour from the
 * theme instead of a src: the tiles are the map.
 */
async function createTileRoomLevel(
  live: FoundryLive,
  sceneId: string,
  name: string,
  resolved: ThemeSpec,
): Promise<string> {
  const levels = await live.modifyDocument("Level", "create", {
    data: [{
      name,
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
  return levelId;
}

/** Raw scene docs, as `live.raw().getScenes()` returns them. */
interface RawSceneDoc {
  _id?: string;
  flags?: Record<string, Record<string, unknown> | undefined> | null;
  [key: string]: unknown;
}

function readSceneDoc(live: FoundryLive, sceneId: string): RawSceneDoc | undefined {
  const raw = live.raw() as unknown as { getScenes(): RawSceneDoc[] };
  return raw.getScenes().find((s) => s._id === sceneId);
}

/**
 * Converge an existing keyed scene to the requested layout: delete
 * surplus keyed embeds, create the missing ones (stamped with their
 * per-embed keys), finish a missing Level, and update the scene dims.
 * Embeds that belong to another build key — or carry no key at all —
 * are never touched. The room description is announced via
 * `sendChatIdempotent` (`<buildKey>:announce`, the buildRoom pattern):
 * a crash before the first attempt's post still gets announced once,
 * and a re-run after a posted announcement posts nothing twice.
 */
async function convergeTileRoom(
  live: FoundryLive,
  sceneId: string,
  spec: RoomSpec,
  layout: import("./tiles-layout.js").RoomLayout,
  resolved: ThemeSpec,
): Promise<BuiltTileRoom> {
  const key = spec.buildKey as string;
  const parentUuid = `Scene.${sceneId}`;
  const present = extractTileRoomEmbeds(readSceneDoc(live, sceneId));
  const plan = planTileRoomConverge(
    { tiles: layout.tiles.length, walls: layout.walls.length, lights: layout.lights.length },
    present,
    key,
  );
  if (plan.deleteTileIds.length > 0) {
    await live.modifyDocument("Tile", "delete", { ids: plan.deleteTileIds, parentUuid });
  }
  if (plan.deleteWallIds.length > 0) {
    await live.modifyDocument("Wall", "delete", { ids: plan.deleteWallIds, parentUuid });
  }
  if (plan.deleteLightIds.length > 0) {
    await live.modifyDocument("AmbientLight", "delete", { ids: plan.deleteLightIds, parentUuid });
  }
  const tileIds = [...plan.keepTileIds];
  if (plan.createTiles.length > 0) {
    const created = await live.modifyDocument("Tile", "create", {
      data: plan.createTiles.map((i) => ({
        ...layout.tiles[i],
        flags: flagValue(FLAG_FIELDS.tileRoom, tileEmbedKey(key, "tile", i)),
      })),
      parentUuid,
    });
    created.forEach((d, n) => {
      tileIds[plan.createTiles[n]] = String(d._id);
    });
  }
  const wallIds = [...plan.keepWallIds];
  if (plan.createWalls.length > 0) {
    const createdIds = await addWalls(
      live,
      sceneId,
      plan.createWalls.map((i) => layout.walls[i]),
      { embedKeys: plan.createWalls.map((i) => tileEmbedKey(key, "wall", i)) },
    );
    createdIds.forEach((id, n) => {
      wallIds[plan.createWalls[n]] = id;
    });
  }
  const lightIds = [...plan.keepLightIds];
  if (plan.createLights.length > 0) {
    const createdIds = await addLights(
      live,
      sceneId,
      plan.createLights.map((i) => layout.lights[i]),
      { embedKeys: plan.createLights.map((i) => tileEmbedKey(key, "light", i)) },
    );
    createdIds.forEach((id, n) => {
      lightIds[plan.createLights[n]] = id;
    });
  }
  // A crash between Scene create and Level create leaves a scene with
  // no initialLevel — finish it now instead of leaving a room that
  // will not load.
  const updates: Record<string, unknown> = { _id: sceneId, width: layout.width, height: layout.height };
  if (!present.initialLevel) {
    updates.initialLevel = await createTileRoomLevel(live, sceneId, spec.name, resolved);
  }
  await live.modifyDocument("Scene", "update", { updates: [updates] });
  if (spec.description) {
    await live.sendChatIdempotent(`🏰 **${spec.name}**\n${spec.description}`, {
      dedupeKey: `${key}:announce`,
    });
  }
  return {
    sceneId,
    tileIds: tileIds as string[],
    wallIds: wallIds as string[],
    lightIds: lightIds as string[],
  };
}

/**
 * Create a tile room on the server: Scene + Level (colour-only
 * background — the tiles are the map) + Tile/Wall/Light embeds.
 * The scene is NOT activated (the GM activates it when ready).
 * GM users are added as owners (role 4) so the DM can edit the scene —
 * the ownership gap that bit Lich's Lair (BACKLOG.md).
 *
 * With `spec.buildKey` (BRA-202), the build is retry-safe: the key is
 * stored in the scene's flags and every tile/wall/light carries a
 * per-embed key. A re-run with the same key returns the existing
 * scene — converging a half-built one to the full layout — instead of
 * building a duplicate. Without a key, behavior is unchanged.
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
  const key = spec.buildKey;
  if (key) {
    // Same-connection re-run with the same layout: the memo has the
    // exact ids (the live cache never sees its own Tile creates). No
    // server traffic. A changed layout under the same key is not a
    // retry — fall through to the server converge below.
    const memo = tileRoomMemo.get(live)?.get(key);
    if (memo && memo.fingerprint === tileRoomFingerprint(layout)) return memo.built;
    // Cross-connection re-run (crash re-dispatch): the scene is on
    // the server under this key — converge it, don't duplicate it.
    const existingId = findSceneByBuildKey(live, key);
    if (existingId) {
      const converged = await convergeTileRoom(live, existingId, spec, layout, resolved);
      memoizeTileRoom(live, key, converged, tileRoomFingerprint(layout));
      return converged;
    }
  }
  const gms = live.getUsers().filter((u) => u.role === 4);
  const ownership: Record<string, number> = { default: 0 };
  for (const gm of gms) ownership[gm._id] = 3;
  if (live.userId) ownership[live.userId] = 3;

  const sceneData: Record<string, unknown> = {
    name: spec.name,
    width: layout.width,
    height: layout.height,
    grid: { size: TILE_PX, type: 1, distance: 5, units: "ft" },
    navigation: true,
    ownership,
  };
  if (key) sceneData.flags = flagValue(FLAG_FIELDS.sceneBuild, key);
  const created = await live.modifyDocument("Scene", "create", {
    data: [sceneData],
  });
  const sceneId = String(created[0]?._id ?? "");
  if (!sceneId) throw new Error("Scene create returned no _id.");

  // v14: the map lives on a Level. A tile room has no background image,
  // so the Level carries a plain dark colour from the theme instead of
  // a src.
  const levelId = await createTileRoomLevel(live, sceneId, spec.name, resolved);
  await live.modifyDocument("Scene", "update", {
    updates: [{ _id: sceneId, initialLevel: levelId }],
  });

  // Tiles in one create — the vendored client's cache does not track
  // Tile documents, so verify on a FRESH connection, not this one.
  // A keyed build stamps each tile with its per-embed key so a re-run
  // can find it again.
  const tileCreated = await live.modifyDocument("Tile", "create", {
    data: layout.tiles.map((t, i) =>
      key ? { ...t, flags: flagValue(FLAG_FIELDS.tileRoom, tileEmbedKey(key, "tile", i)) } : t,
    ),
    parentUuid: `Scene.${sceneId}`,
  });
  const tileIds = tileCreated.map((d) => String(d._id));
  const wallIds = await addWalls(
    live,
    sceneId,
    layout.walls,
    key ? { embedKeys: layout.walls.map((_, i) => tileEmbedKey(key, "wall", i)) } : {},
  );
  const lightIds = await addLights(
    live,
    sceneId,
    layout.lights,
    key ? { embedKeys: layout.lights.map((_, i) => tileEmbedKey(key, "light", i)) } : {},
  );

  if (spec.description) {
    // Keyed builds announce idempotently (<buildKey>:announce, the
    // buildRoom pattern): a re-run after a crash posts once, never twice.
    if (key) {
      await live.sendChatIdempotent(`🏰 **${spec.name}**\n${spec.description}`, {
        dedupeKey: `${key}:announce`,
      });
    } else {
      await live.sendChat(`🏰 **${spec.name}**\n${spec.description}`);
    }
  }
  const built = { sceneId, tileIds, wallIds, lightIds };
  if (key) memoizeTileRoom(live, key, built, tileRoomFingerprint(layout));
  return built;
}

/**
 * Resize a tile room in place: delete the previous build's tiles/walls/
 * lights (by the ids buildTileRoom returned — the caller keeps them, the
 * client's cache cannot re-derive them) and apply the new layout.
 * Changing gridW/gridH is all it takes; no new images are involved.
 * A `theme` here re-skins the room at the same time (FR-2) — same
 * layout, new look.
 *
 * With `spec.buildKey` (BRA-202), the rebuild is retry-safe too: the
 * delete set is the union of `previous` and every embed on the scene
 * carrying this build's per-embed keys (a crashed earlier rebuild's
 * leftovers), the new embeds are stamped with their per-embed keys,
 * and the scene is stamped with the build key when it lacks it — so a
 * later keyed buildTileRoom re-run finds the scene and converges
 * instead of duplicating it.
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
  const key = spec.buildKey;
  // Keyed rebuild: the scene scan, not just `previous`, is the delete
  // set — `previous` is stale after a crashed rebuild.
  let sceneDoc: RawSceneDoc | undefined;
  if (key) {
    sceneDoc = readSceneDoc(live, sceneId);
    const present = extractTileRoomEmbeds(sceneDoc);
    const ownedNotKnown = (list: KeyedEmbed[], known: string[]): string[] => {
      const knownSet = new Set(known);
      return list
        .filter((e) => parseTileEmbedKey(e.key)?.buildKey === key && !knownSet.has(e.id))
        .map((e) => e.id);
    };
    const tileIds = [...previous.tileIds, ...ownedNotKnown(present.tiles, previous.tileIds)];
    const wallIds = [...previous.wallIds, ...ownedNotKnown(present.walls, previous.wallIds)];
    const lightIds = [...previous.lightIds, ...ownedNotKnown(present.lights, previous.lightIds)];
    if (tileIds.length > 0) {
      await live.modifyDocument("Tile", "delete", { ids: tileIds, parentUuid });
    }
    if (wallIds.length > 0) {
      await live.modifyDocument("Wall", "delete", { ids: wallIds, parentUuid });
    }
    if (lightIds.length > 0) {
      await live.modifyDocument("AmbientLight", "delete", { ids: lightIds, parentUuid });
    }
  } else {
    if (previous.tileIds.length > 0) {
      await live.modifyDocument("Tile", "delete", { ids: previous.tileIds, parentUuid });
    }
    if (previous.wallIds.length > 0) {
      await live.modifyDocument("Wall", "delete", { ids: previous.wallIds, parentUuid });
    }
    if (previous.lightIds.length > 0) {
      await live.modifyDocument("AmbientLight", "delete", { ids: previous.lightIds, parentUuid });
    }
  }
  const layout = layoutRoom(spec, pack, serverBase, resolved);
  // Stamp the scene with the build key when it lacks it (a scene built
  // before keys existed, now rebuilt under one). Flag updates merge
  // per scope — the quest log stamps flags the same way.
  const sceneUpdate: Record<string, unknown> = { _id: sceneId, width: layout.width, height: layout.height };
  if (key && !sceneHasTileRoomKey(sceneDoc, key)) {
    sceneUpdate.flags = flagValue(FLAG_FIELDS.sceneBuild, key);
  }
  await live.modifyDocument("Scene", "update", {
    updates: [sceneUpdate],
  });
  const tileCreated = await live.modifyDocument("Tile", "create", {
    data: layout.tiles.map((t, i) =>
      key ? { ...t, flags: flagValue(FLAG_FIELDS.tileRoom, tileEmbedKey(key, "tile", i)) } : t,
    ),
    parentUuid,
  });
  const tileIds = tileCreated.map((d) => String(d._id));
  const wallIds = await addWalls(
    live,
    sceneId,
    layout.walls,
    key ? { embedKeys: layout.walls.map((_, i) => tileEmbedKey(key, "wall", i)) } : {},
  );
  const lightIds = await addLights(
    live,
    sceneId,
    layout.lights,
    key ? { embedKeys: layout.lights.map((_, i) => tileEmbedKey(key, "light", i)) } : {},
  );
  const built = { sceneId, tileIds, wallIds, lightIds };
  if (key) memoizeTileRoom(live, key, built, tileRoomFingerprint(layout));
  return built;
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
 *
 * With `opts.buildKey` (BRA-202), every room is built under
 * `<buildKey>:<room id>` (unless the room's own spec already sets a
 * buildKey), so a re-run of the whole dungeon returns the existing
 * scenes instead of building a second dungeon.
 */
export async function buildDungeon(
  live: FoundryLive,
  spec: DungeonSpec,
  pack: import("./tiles-layout.js").Pack,
  serverBase: string,
  theme?: string | ThemeSpec,
  opts: { buildKey?: string } = {},
): Promise<BuiltDungeon> {
  const dungeon: DungeonLayout = layoutDungeon(spec, pack, serverBase, theme);
  const rooms: BuiltDungeonRoom[] = [];
  for (const room of spec.rooms) {
    const keyed: RoomSpec =
      opts.buildKey && !room.buildKey
        ? { ...room, buildKey: `${opts.buildKey}:${room.id}` }
        : room;
    const built = await buildTileRoom(live, keyed, pack, serverBase, theme);
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
