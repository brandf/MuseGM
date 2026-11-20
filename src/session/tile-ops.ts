/**
 * Tile operations for cutscene steps (FR-13 scripted tile swaps).
 *
 * A swap changes one tile's texture in place — the trap door opens,
 * the floor becomes a pit, the wall becomes a passage. The update is
 * by Tile _id, so it needs no read; a cell address ({x, y} top-left
 * in scene pixels) resolves through the scene's tile list when the
 * connection's cache carries it.
 *
 * Honest limits (do not paper over these):
 * - The vendored client's worldData cache does not track Tile
 *   documents (see src/worldbuilding/tiles.ts), and the mapped scene
 *   shape (`worldSceneToFoundry`) strips everything but top-level
 *   fields — so a cell address only works if the raw scene payload
 *   happens to carry `tiles`. When it does not, the step fails with a
 *   clear error telling the author to use the tile's _id (from
 *   buildTileRoom's returned tileIds). The _id path always works.
 * - The swap sends {"texture.src": to} — dot-notation, the standard
 *   Foundry pattern for partial updates of nested fields; flag for
 *   live verification, like the light config updates.
 * - A swap is an update, so it is retry-safe by nature: setting the
 *   same texture twice is a no-op in effect. No key is needed.
 */
import type { FoundryLive } from "../live.js";

export interface TileRef {
  _id: string;
  x: number;
  y: number;
  texture?: { src?: string };
  [key: string]: unknown;
}

/** Pure: the tile whose top-left corner is exactly (x, y), or undefined. */
export function findTileAtCell(
  tiles: TileRef[],
  x: number,
  y: number,
): TileRef | undefined {
  return tiles.find((t) => t.x === x && t.y === y);
}

type RawScene = {
  _id: string;
  name?: string;
  tiles?: TileRef[];
};

/** The scene's tile list from the raw world payload, if it carries one. */
export function getSceneTiles(live: FoundryLive, sceneIdOrName: string): TileRef[] {
  const data = live.raw().getWorldData() as unknown as { scenes?: RawScene[] } | null;
  const scenes = data?.scenes ?? [];
  const scene =
    scenes.find((s) => s._id === sceneIdOrName) ??
    scenes.find((s) => s.name?.toLowerCase() === sceneIdOrName.toLowerCase());
  if (!scene) {
    throw new Error(
      `Scene not found: ${sceneIdOrName} (scenes now: ${scenes.map((s) => s.name ?? s._id).join(", ") || "none"})`,
    );
  }
  if (!scene.tiles) {
    throw new Error(
      `Scene ${scene.name ?? scene._id} has no tiles in this connection's cache — ` +
        `address the tile by its _id instead (buildTileRoom returns the tile ids).`,
    );
  }
  return scene.tiles;
}

export type SwapTileTarget = { tile: string } | { cell: { x: number; y: number } };

/**
 * Swap one tile's texture in place. Returns the tile _id, the new
 * texture, and the old texture when it was known from the cache.
 */
export async function swapTileTexture(
  live: FoundryLive,
  sceneId: string,
  target: SwapTileTarget,
  to: string,
): Promise<{ tileId: string; from: string | null; to: string }> {
  const data = live.raw().getWorldData() as unknown as { scenes?: RawScene[] } | null;
  const scene =
    data?.scenes?.find((s) => s._id === sceneId) ??
    data?.scenes?.find((s) => s.name?.toLowerCase() === sceneId.toLowerCase());
  if (!scene) {
    throw new Error(`Scene not found: ${sceneId}`);
  }
  let tileId: string;
  let from: string | null = null;
  if ("tile" in target) {
    tileId = target.tile;
    const doc = (scene.tiles ?? []).find((t) => t._id === tileId);
    if (doc?.texture?.src) from = doc.texture.src;
  } else {
    const tiles = getSceneTiles(live, sceneId);
    const doc = findTileAtCell(tiles, target.cell.x, target.cell.y);
    if (!doc) {
      throw new Error(
        `No tile at cell (${target.cell.x}, ${target.cell.y}) on scene ${sceneId} — ` +
          `address the tile by its _id instead.`,
      );
    }
    tileId = doc._id;
    if (doc.texture?.src) from = doc.texture.src;
  }
  await live.modifyDocument("Tile", "update", {
    updates: [{ _id: tileId, "texture.src": to }],
    parentUuid: `Scene.${scene._id}`,
  });
  return { tileId, from, to };
}
