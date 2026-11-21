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

/** One embed on the scene that carries a tile-room key. Tiles carry
 *  their match fields (position + look, read from the raw doc),
 *  which is what converge matches on — flat layout indices shift
 *  whenever the layout changes (a widen, a re-skin), so an index is
 *  not an identity. Walls and lights carry theirs too (BRA-243):
 *  a wall's endpoints + door flag, a light's position + config +
 *  name. Fields a doc does not carry (or carries with the wrong
 *  type) are simply absent — such an embed matches nothing and is
 *  deleted + recreated, the safe convergent choice. */
export interface KeyedEmbed {
  key: string;
  id: string;
  sort?: number;
  elevation?: number;
  x?: number;
  y?: number;
  src?: string;
  rotation?: number;
  /** Walls: segment endpoints (canonical order — the smaller end
   *  first) + door flag (0 plain, 1 door, 2 secret). */
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  door?: number;
  /** Lights: config radii + angle/color/alpha, and the display name
   *  (flags["foundry-live"].lightName, FR-7) when the light has one. */
  dim?: number;
  bright?: number;
  angle?: number;
  color?: string;
  alpha?: number;
  name?: string;
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
      // Walls and lights carry theirs the same way (BRA-243): a
      // wall's `c` endpoints + `door` flag, a light's position +
      // `config` + display name. Deliberately NOT matched: a wall's
      // `ds` (door state — the GM opening a door must not read as a
      // changed wall) and a light's `hidden` (state, not look).
      const raw = entry as Record<string, unknown>;
      const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
      if (field === "tiles") {
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
      } else if (field === "walls") {
        const c = raw["c"];
        if (
          Array.isArray(c) &&
          c.length === 4 &&
          c.every((v) => typeof v === "number")
        ) {
          const [ax, ay, bx, by] = c as number[];
          // Canonical endpoint order (the smaller end first) — a
          // wall is an undirected segment, so a doc that lists the
          // ends the other way round is the same wall.
          const [x1, y1, x2, y2] =
            ax < bx || (ax === bx && ay <= by) ? [ax, ay, bx, by] : [bx, by, ax, ay];
          embed.x1 = x1;
          embed.y1 = y1;
          embed.x2 = x2;
          embed.y2 = y2;
        }
        const door = num(raw["door"]);
        if (door !== undefined) embed.door = door;
      } else if (field === "lights") {
        const x = num(raw["x"]);
        const y = num(raw["y"]);
        if (x !== undefined) embed.x = x;
        if (y !== undefined) embed.y = y;
        const config = raw["config"];
        if (typeof config === "object" && config !== null) {
          const cfg = config as Record<string, unknown>;
          const dim = num(cfg["dim"]);
          const bright = num(cfg["bright"]);
          const angle = num(cfg["angle"]);
          const alpha = num(cfg["alpha"]);
          const color = typeof cfg["color"] === "string" ? (cfg["color"] as string) : undefined;
          if (dim !== undefined) embed.dim = dim;
          if (bright !== undefined) embed.bright = bright;
          if (angle !== undefined) embed.angle = angle;
          if (alpha !== undefined) embed.alpha = alpha;
          if (color !== undefined) embed.color = color;
        }
        const lightName = scope?.[FLAG_FIELDS.lightName];
        if (typeof lightName === "string" && lightName.length > 0) embed.name = lightName;
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

/** One wall the layout wants, for converge matching: endpoints +
 *  door flag. A wall matches a scene embed only when every field
 *  agrees — a wall that moved, or gained a door, is a different wall. */
export interface PlannedWall {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** 0 = plain wall, 1 = door, 2 = secret door. */
  door: number;
}

/**
 * Normalize a layout wall into its converge form: the door flag
 * defaults to 0, and the endpoints are ordered canonically (the
 * smaller end first) — a wall is an undirected segment, so a layout
 * that lists the ends the other way round is the same wall.
 */
export function plannedWallOf(w: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  door?: number;
}): PlannedWall {
  const [x1, y1, x2, y2] =
    w.x1 < w.x2 || (w.x1 === w.x2 && w.y1 <= w.y2)
      ? [w.x1, w.y1, w.x2, w.y2]
      : [w.x2, w.y2, w.x1, w.y1];
  return { x1, y1, x2, y2, door: w.door ?? 0 };
}

/** One light the layout wants, for converge matching: position +
 *  config + name. A light matches a scene embed only when every
 *  field agrees — two lights at the same cell with different names
 *  are different lights. */
export interface PlannedLight {
  x: number;
  y: number;
  dim: number;
  bright: number;
  angle: number;
  color: string;
  alpha: number;
  /** Display name (FR-7 group name) when the light has one. */
  name?: string;
}

/**
 * Normalize a layout light into its converge form: the Foundry
 * defaults `lightCreateData` applies (angle 360, warm amber
 * #ff9a3c, alpha 0.5) and a blank name is no name. A dressingId is
 * deliberately NOT a match field — it is a build-time marker that
 * never reaches the Foundry doc, so converge cannot read it back;
 * two dressing lights at one cell with the same config and name tie
 * on position + look, and the tie rule in planTileRoomConverge
 * (an error, not a silent duplicate) applies to them.
 */
export function plannedLightOf(l: {
  x: number;
  y: number;
  dim: number;
  bright: number;
  angle?: number;
  color?: string;
  alpha?: number;
  name?: string;
}): PlannedLight {
  const name = typeof l.name === "string" && l.name.trim().length > 0 ? l.name.trim() : undefined;
  return {
    x: l.x,
    y: l.y,
    dim: l.dim,
    bright: l.bright,
    angle: l.angle ?? 360,
    color: l.color ?? "#ff9a3c",
    alpha: l.alpha ?? 0.5,
    ...(name !== undefined ? { name } : {}),
  };
}

/** Planned embeds for one room layout: tiles, walls and lights, all
 *  matched by position + look, never by flat layout index. */
export interface PlannedEmbeds {
  tiles: PlannedTile[];
  walls: PlannedWall[];
  lights: PlannedLight[];
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
 * Tiles, walls and lights all match by position + look, never by
 * flat layout index: a widen or a re-skin shifts the indices of
 * everything after it, and index matching would keep a prop tile
 * where a wall tile now belongs (ghost prop, missing wall — the
 * BRA-218 regression), or keep a wall where a door now belongs.
 * Walls match on endpoints + door flag; lights on position +
 * config + name.
 *
 * The per-embed key is the primary match AMONG field matches: when
 * several present embeds match one planned slot on position + look
 * (a crash duplicate left behind by a partial build), the one whose
 * key index is this planned index wins. A key alone never keeps an
 * embed — an embed whose key index agrees but whose fields do not
 * is in the wrong place or of the wrong look, and is surplus. That
 * is the only safe reading of "key first": key-over-fields would
 * reintroduce the shift bug this matching exists to fix.
 *
 * A tie between two PLANNED slots is an error, not a silent
 * duplicate: when a planned wall/light has field-matching present
 * embeds but every one is already claimed by an earlier planned
 * slot, creating it would duplicate the embed already on the scene,
 * so the plan throws, listing the tied candidates. Two identical
 * planned walls or lights are a spec/layout bug — give them
 * different positions, looks, or names.
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
  /**
   * Match one kind (walls or lights) by position + look. The
   * `matches` predicate compares every match field; `describe`
   * renders a planned slot for the tie error. Duplicates on the
   * scene side are surplus (the first field match wins, the rest
   * are deleted, as for tiles); duplicates on the plan side throw.
   */
  const planMatched = <T>(
    items: T[],
    presentList: KeyedEmbed[],
    kind: "wall" | "light",
    matches: (e: KeyedEmbed, p: T) => boolean,
    describe: (p: T) => string,
  ): { create: number[]; deleteIds: string[]; keep: (string | null)[] } => {
    const fieldMatches = (p: T): KeyedEmbed[] =>
      presentList.filter((e) => {
        const parsed = parseTileEmbedKey(e.key);
        return parsed !== null && parsed.buildKey === buildKey && parsed.kind === kind && matches(e, p);
      });
    const used = new Set<string>();
    const create: number[] = [];
    const keep: (string | null)[] = [];
    for (let i = 0; i < items.length; i++) {
      const candidates = fieldMatches(items[i]).filter((e) => !used.has(e.id));
      if (candidates.length === 0) {
        const tied = fieldMatches(items[i]);
        if (tied.length > 0) {
          throw new Error(
            `Converge tie: planned ${kind} ${i} (${describe(items[i])}) matches ${tied.length} embed(s) already claimed by earlier planned ${kind}s (${tied.map((e) => e.id).join(", ")}) — two identical ${kind}s cannot both live on the scene. Give them different positions, looks, or names.`,
          );
        }
        create.push(i);
        keep.push(null);
        continue;
      }
      // Key-first among field matches (see the docstring above):
      // the embed whose key index is this planned index wins over a
      // crash duplicate. Field agreement is still required.
      const byKey = candidates.find((e) => parseTileEmbedKey(e.key)?.index === i);
      const match = byKey ?? candidates[0];
      used.add(match.id);
      keep.push(match.id);
    }
    const deleteIds: string[] = [];
    for (const e of presentList) {
      const parsed = parseTileEmbedKey(e.key);
      if (!parsed || parsed.buildKey !== buildKey || parsed.kind !== kind) continue;
      if (!used.has(e.id)) deleteIds.push(e.id);
    }
    return { create, deleteIds, keep };
  };
  const tiles = planTiles(planned.tiles, present.tiles);
  const walls = planMatched(
    planned.walls,
    present.walls,
    "wall",
    (e, w) => e.x1 === w.x1 && e.y1 === w.y1 && e.x2 === w.x2 && e.y2 === w.y2 && e.door === w.door,
    (w) => `(${w.x1},${w.y1})-(${w.x2},${w.y2}) door=${w.door}`,
  );
  const lights = planMatched(
    planned.lights,
    present.lights,
    "light",
    (e, l) =>
      e.x === l.x && e.y === l.y && e.dim === l.dim && e.bright === l.bright &&
      e.angle === l.angle && e.color === l.color && e.alpha === l.alpha &&
      (e.name ?? undefined) === (l.name ?? undefined),
    (l) => `(${l.x},${l.y}) dim=${l.dim} bright=${l.bright} color=${l.color} alpha=${l.alpha}${l.name ? ` name="${l.name}"` : ""}`,
  );
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
