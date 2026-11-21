/**
 * Tile-room idempotency keys (BRA-202) — the pure half.
 *
 * Same mechanism as the rest of the retry-safety core
 * (`src/idempotency.ts`): a client-generated key carried in the
 * document's `flags["foundry-live"]`. Two levels:
 *
 * - Scene level: the build key itself, in `flags.buildKey` — the same
 *   field `scene create --build-key` uses (`findSceneByBuildKey` in
 *   `worldbuilding/index.ts`). A re-run finds the scene by it.
 * - Embed level: every Tile/Wall/AmbientLight a keyed build creates
 *   carries `<buildKey>:tile|wall|light:<index>` in
 *   `flags.tileRoomKey` — the encounter-token pattern
 *   (`${encounterKey}:token:${idx}` in `session/encounter.ts`). A
 *   re-run scans the scene's embeds for those keys and creates only
 *   the missing ones, so a crash mid-build converges on retry instead
 *   of duplicating the room.
 *
 * Everything here is pure — no Foundry, no I/O — so `bun test`
 * covers it with no connection.
 *
 * Honest limits (do not paper over these):
 * - The check-then-create is NOT atomic — same caveat as the rest of
 *   the core. The realistic hazard is a crash re-dispatch (strictly
 *   sequential), not a concurrent double-send.
 * - A scene doc read from the live client's cache may not list tiles
 *   the same connection created (the vendored client does not track
 *   Tile documents — see `tiles.ts`). A fresh connection's world
 *   payload does list them. The live layer therefore keeps an
 *   in-process memo per connection (same pattern as `sentDedupeKeys`
 *   in `live.ts`) so a same-connection re-run never re-scans.
 * - `extractTileRoomEmbeds` reads whatever the raw scene doc holds.
 *   A doc without flags, or a flags value of the wrong shape, is
 *   skipped, never guessed at.
 */
import { FLAG_FIELDS, FLAG_SCOPE, dedupeKeyFor, docHasFlag } from "../idempotency.js";

export type TileEmbedKind = "tile" | "wall" | "light";

/** Stable build key for a tile room, derived from its room id. */
export function tileRoomBuildKey(roomId: string): string {
  return dedupeKeyFor("tile-room", roomId);
}

/** Per-embed key: `<buildKey>:tile|wall|light:<index>`. */
export function tileEmbedKey(buildKey: string, kind: TileEmbedKind, index: number): string {
  return `${buildKey}:${kind}:${index}`;
}

/** Parse a per-embed key back into its parts, or null when it is not one. */
export function parseTileEmbedKey(
  key: string,
): { buildKey: string; kind: TileEmbedKind; index: number } | null {
  const m = /^(.*):(tile|wall|light):(\d+)$/.exec(key);
  if (!m) return null;
  return { buildKey: m[1], kind: m[2] as TileEmbedKind, index: Number(m[3]) };
}

/** One embed on the scene that carries a tile-room key. Tiles also
 *  carry their match fields (position + look, read from the raw doc),
 *  which is what converge matches on — flat layout indices shift
 *  whenever the layout changes (a widen, a re-skin), so an index is
 *  not an identity. Walls and lights are still matched by index;
 *  their shift bug is a BRA-202 follow-up, not this item. */
export interface KeyedEmbed {
  key: string;
  id: string;
  sort?: number;
  elevation?: number;
  x?: number;
  y?: number;
  src?: string;
  rotation?: number;
}

/** What a raw scene doc says about one keyed build's embeds. */
export interface TileRoomEmbeds {
  tiles: KeyedEmbed[];
  walls: KeyedEmbed[];
  lights: KeyedEmbed[];
  /** Level _ids on the scene (empty when the scene has none yet). */
  levelIds: string[];
  /** The scene's initialLevel, or null when it has none yet. */
  initialLevel: string | null;
}

const EMPTY_EMBEDS: TileRoomEmbeds = {
  tiles: [],
  walls: [],
  lights: [],
  levelIds: [],
  initialLevel: null,
};

/**
 * Pull the keyed embeds out of a raw scene document (as returned by
 * `live.raw().getScenes()`). Only embeds carrying our flag field are
 * listed; everything else is the GM's own work and is left alone.
 * Tolerates missing arrays, missing flags, and non-object docs.
 */
export function extractTileRoomEmbeds(scene: unknown): TileRoomEmbeds {
  if (typeof scene !== "object" || scene === null) return { ...EMPTY_EMBEDS };
  const doc = scene as Record<string, unknown>;
  const read = (field: string): KeyedEmbed[] => {
    const arr = doc[field];
    if (!Array.isArray(arr)) return [];
    const out: KeyedEmbed[] = [];
    for (const entry of arr) {
      if (typeof entry !== "object" || entry === null) continue;
      const flagged = entry as { _id?: unknown; flags?: unknown };
      const id = typeof flagged._id === "string" ? flagged._id : "";
      if (!id) continue;
      const scope = (flagged.flags as Record<string, Record<string, unknown> | undefined> | null)?.[
        FLAG_SCOPE
      ];
      const key = scope?.[FLAG_FIELDS.tileRoom];
      if (typeof key !== "string" || key.length === 0) continue;
      const embed: KeyedEmbed = { key, id };
      // Tiles carry their match fields (position + look) so converge
      // can match them without trusting the flat layout index. A
      // field is only attached when the doc actually carries it with
      // the right type — a malformed doc matches nothing and is
      // deleted + recreated, which is the safe convergent choice.
      if (field === "tiles") {
        const raw = entry as Record<string, unknown>;
        const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
        const sort = num(raw["sort"]);
        const elevation = num(raw["elevation"]);
        const x = num(raw["x"]);
        const y = num(raw["y"]);
        const rotation = num(raw["rotation"]);
        const tex = raw["texture"];
        const texSrc =
          typeof tex === "object" && tex !== null && typeof (tex as { src?: unknown }).src === "string"
            ? (tex as { src: string }).src
            : undefined;
        const img = typeof raw["img"] === "string" ? raw["img"] : undefined;
        const src = texSrc ?? img;
        if (sort !== undefined) embed.sort = sort;
        if (elevation !== undefined) embed.elevation = elevation;
        if (x !== undefined) embed.x = x;
        if (y !== undefined) embed.y = y;
        if (rotation !== undefined) embed.rotation = rotation;
        if (src !== undefined) embed.src = src;
      }
      out.push(embed);
    }
    return out;
  };
  const levels = doc["levels"];
  const levelIds: string[] = Array.isArray(levels)
    ? levels
        .filter((l): l is { _id: string } => typeof l === "object" && l !== null && typeof (l as { _id?: unknown })._id === "string")
        .map((l) => l._id)
    : [];
  return {
    tiles: read("tiles"),
    walls: read("walls"),
    lights: read("lights"),
    levelIds,
    initialLevel: typeof doc["initialLevel"] === "string" ? (doc["initialLevel"] as string) : null,
  };
}

/** One tile the layout wants, for converge matching: position +
 *  look. Tiles match a scene embed only when every field agrees. */
export interface PlannedTile {
  sort: number;
  elevation: number;
  x: number;
  y: number;
  src: string;
  rotation: number;
}

/** Planned embeds for one room layout: the tiles themselves (matched
 *  by position + look), and the wall/light counts (matched by index,
 *  as before). */
export interface PlannedEmbeds {
  tiles: PlannedTile[];
  walls: number;
  lights: number;
}

/** What a keyed re-run must do to converge the scene to the plan. */
export interface TileRoomConvergePlan {
  /** Layout indices to create (their per-embed key is absent). */
  createTiles: number[];
  createWalls: number[];
  createLights: number[];
  /** Embed _ids to delete: keyed to this build but matching no
   *  planned slot (the spec shrank, a prop moved, or a re-skin
   *  changed the tile's look). */
  deleteTileIds: string[];
  deleteWallIds: string[];
  deleteLightIds: string[];
  /** Embed _id already on the scene at each layout index, or null
   *  when that index still needs creating. Layout order, so the
   *  caller can assemble the final BuiltTileRoom deterministically. */
  keepTileIds: (string | null)[];
  keepWallIds: (string | null)[];
  keepLightIds: (string | null)[];
}

/**
 * Plan a keyed re-run: which planned embeds are missing (create
 * them), which keyed embeds are surplus to the current plan (delete
 * them), and which are already in place (keep them, in layout
 * order). Embeds belonging to another build key — or with no key at
 * all — are never touched: the GM's hand-placed walls are not ours
 * to delete.
 *
 * Tiles match by position + look (sort, elevation, x, y, texture
 * src, rotation), never by flat layout index: a widen or a re-skin
 * shifts the indices of everything after it, and index matching
 * would keep a prop tile where a wall tile now belongs (ghost prop,
 * missing wall). Walls and lights still match by index — their shift
 * bug is a BRA-202 follow-up, not this item.
 */
export function planTileRoomConverge(
  planned: PlannedEmbeds,
  present: TileRoomEmbeds,
  buildKey: string,
): TileRoomConvergePlan {
  const planTiles = (
    tiles: PlannedTile[],
    presentList: KeyedEmbed[],
  ): { create: number[]; deleteIds: string[]; keep: (string | null)[] } => {
    const matches = (e: KeyedEmbed, t: PlannedTile): boolean =>
      e.sort === t.sort && e.elevation === t.elevation && e.x === t.x && e.y === t.y &&
      e.src === t.src && e.rotation === t.rotation;
    const used = new Set<string>();
    const create: number[] = [];
    const keep: (string | null)[] = [];
    for (let i = 0; i < tiles.length; i++) {
      const match = presentList.find((e) => {
        if (used.has(e.id)) return false;
        const parsed = parseTileEmbedKey(e.key);
        return parsed !== null && parsed.buildKey === buildKey && parsed.kind === "tile" && matches(e, tiles[i]);
      });
      if (match) {
        used.add(match.id);
        keep.push(match.id);
      } else {
        create.push(i);
        keep.push(null);
      }
    }
    // Surplus: keyed to this build, a tile, and matched by nothing.
    // A duplicate of an already-matched tile is surplus too.
    const deleteIds: string[] = [];
    for (const e of presentList) {
      const parsed = parseTileEmbedKey(e.key);
      if (!parsed || parsed.buildKey !== buildKey || parsed.kind !== "tile") continue;
      if (!used.has(e.id)) deleteIds.push(e.id);
    }
    return { create, deleteIds, keep };
  };
  const planKind = (
    count: number,
    presentList: KeyedEmbed[],
  ): { create: number[]; deleteIds: string[]; keep: (string | null)[] } => {
    const byIndex = new Map<number, string>();
    const deleteIds: string[] = [];
    for (const { key, id } of presentList) {
      const parsed = parseTileEmbedKey(key);
      if (!parsed || parsed.buildKey !== buildKey) continue;
      if (parsed.index < count && !byIndex.has(parsed.index)) {
        byIndex.set(parsed.index, id);
      } else {
        // Same key, past the plan's end (spec shrank) — or a
        // duplicate index, which a previous partial failure left
        // behind. Either way it is surplus to this plan.
        deleteIds.push(id);
      }
    }
    const create: number[] = [];
    const keep: (string | null)[] = [];
    for (let i = 0; i < count; i++) {
      const id = byIndex.get(i);
      if (id === undefined) {
        create.push(i);
        keep.push(null);
      } else {
        keep.push(id);
      }
    }
    return { create, deleteIds, keep };
  };
  const tiles = planTiles(planned.tiles, present.tiles);
  const walls = planKind(planned.walls, present.walls);
  const lights = planKind(planned.lights, present.lights);
  return {
    createTiles: tiles.create,
    createWalls: walls.create,
    createLights: lights.create,
    deleteTileIds: tiles.deleteIds,
    deleteWallIds: walls.deleteIds,
    deleteLightIds: lights.deleteIds,
    keepTileIds: tiles.keep,
    keepWallIds: walls.keep,
    keepLightIds: lights.keep,
  };
}

/** True when the scene already carries this build's key. */
export function sceneHasTileRoomKey(
  scene: { flags?: Record<string, Record<string, unknown> | undefined> | null } | null | undefined,
  buildKey: string,
): boolean {
  if (!scene) return false;
  return docHasFlag(scene, FLAG_FIELDS.sceneBuild, buildKey);
}
