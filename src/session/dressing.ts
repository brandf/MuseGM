/**
 * Interactive dressing (FR-16): the map you can touch.
 *
 * A dressing pass sprinkles a room with clickable light sources —
 * torches along the walls, candles on tables (or floor cells next to a
 * wall when there are no tables), braziers in the corners of large
 * rooms. Each item is a dressing tile *plus* its paired AmbientLight
 * *plus* the toggle wiring: clicking it flips the light and posts a
 * one-line flavor note in chat. A human placing all of that by hand
 * would take forever; a script generates it in one pass.
 *
 * Pure functions only — no Foundry, no network. The composer hook
 * (applyDressingToSpec / layoutRoomWithDressing) runs the dressing
 * pass per room and merges it into the spec; the pairing helper
 * (resolveDressingPairing) pairs the created Tile and AmbientLight
 * _ids back to their items after the live build, so the click module
 * can find the light to flip. The one step this module does NOT do is
 * the Foundry calls themselves (create tiles/lights, write the flags
 * back) — that is the small live half in buildTileRoom, sketched in
 * docs/interactive-dressing.md.
 *
 * Light language (FR-7 + the Lich's Lair lighting fix, Nov 19):
 * warm torch amber #ff9a3c, alpha 0.4. A candle is a smaller, paler
 * flame; a brazier is a bigger fire. The toggle is stateful by design:
 * the light document carries the state (hidden on/off + alpha), so a
 * relight restores exactly the same light.
 *
 * Tile honesty: every kind has a real pack tile now — torch "sconce",
 * candle "candle", brazier "brazier" (tiles/procedural/
 * generate_tiles.py, 48 tiles, 0 gaps). A plan whose item has no tile
 * still lists it in `tileGaps` and the hook skips it — never faked.
 * The alpha gap is closed the same way: LightSpec carries an `alpha`
 * field now (BRA-192), so the hook's lights are created with their
 * own alpha instead of a post-create update.
 */
import { mulberry32 } from "../worldbuilding/maze.js";
import {
  isMazeWallCell,
  layoutRoom,
  mazeGridsFor,
  TILE_PX,
  type Pack,
  type RoomLayout,
  type RoomSpec,
  type WallSide,
} from "../worldbuilding/tiles-layout.js";
import type { LightSpec } from "../worldbuilding/index.js";
import type { ThemeSpec } from "../worldbuilding/themes.js";
import { isValidHexColor } from "./lights.js";

export type DressingKind = "torch" | "candle" | "brazier";
export type DressingState = "lit" | "unlit";
/** Where the item sits: on a wall cell, on a table, or on the floor. */
export type DressingPlacement = "wall" | "table" | "floor";

/** The paired light for one dressing item (cell centre, px). */
export interface DressingLightSpec {
  x: number;
  y: number;
  dim: number;
  bright: number;
  color: string;
  alpha: number;
}

/** One interactive dressing piece: a tile + its paired light + state. */
export interface DressingItem {
  /** Stable key, e.g. "torch-n-4", "candle-table-3-2", "brazier-nw". */
  id: string;
  kind: DressingKind;
  gx: number;
  gy: number;
  /** Pack tile name, or null when the pack has no tile for this kind. */
  tile: string | null;
  /** Tile the pack still needs, when tile is null. */
  tileNeeded?: string;
  placement: DressingPlacement;
  /** The paired light. */
  light: DressingLightSpec;
  /** Foundry AmbientLight _id once built; null in a plan. */
  lightId: string | null;
  /** Current state; the light doc carries it. */
  state: DressingState;
  /** Chat lines for the toggle, one per state. */
  chatLines: Record<DressingState, string>;
}

/** One light document to create, keyed to its item. */
export interface DressingLightDoc extends DressingLightSpec {
  /** The item this light belongs to. */
  itemId: string;
  /** Foundry AmbientLight _id once built; null in a plan. */
  lightId: string | null;
}

export interface DressingPlan {
  roomId: string;
  items: DressingItem[];
  /** The light docs to create — one per item, keyed by itemId. */
  lights: DressingLightDoc[];
  /** Tiles the pack still needs before this plan can build. */
  tileGaps: string[];
  seed: number;
}

/** Light presets per kind — the torch language from the lighting fix. */
export const DRESSING_LIGHTS: Record<
  DressingKind,
  { dim: number; bright: number; color: string; alpha: number }
> = {
  torch: { dim: 300, bright: 120, color: "#ff9a3c", alpha: 0.4 },
  candle: { dim: 120, bright: 60, color: "#ffc46b", alpha: 0.4 },
  brazier: { dim: 400, bright: 200, color: "#ff8c2e", alpha: 0.5 },
};

/** One toggle line per kind + state — no generic filler. */
export const DRESSING_CHAT_LINES: Record<
  DressingKind,
  Record<DressingState, string>
> = {
  torch: {
    lit: "The torch sputters to life.",
    unlit: "The torch gutters out.",
  },
  candle: {
    lit: "The candle's flame steadies and grows.",
    unlit: "The candle gutters out.",
  },
  brazier: {
    lit: "The brazier roars to life, firelight washing the room.",
    unlit: "The brazier's fire dies down to embers.",
  },
};

/** Pack tile per kind — every kind has a real tile now (BRA-192). */
export const DRESSING_TILES: Record<DressingKind, string> = {
  torch: "sconce",
  candle: "candle",
  brazier: "brazier",
};

/** A room counts as large (braziers in the corners) at this size. */
export const BRAZIER_MIN_SIZE = 8;

export interface PlanDressingOptions {
  /** Deterministic seed. Default 1. */
  seed?: number;
  /** Torch spacing along a wall, in cells. Default 3. */
  spacing?: number;
  /** Table cells for candles (one candle per table, up to maxCandles). */
  tables?: { gx: number; gy: number }[];
  /** Max candles on tables. Default 6. */
  maxCandles?: number;
  /** Floor candles when there are no tables. Default 2. */
  candleCount?: number;
  /** Place braziers in large rooms. Default true. */
  braziers?: boolean;
  /** Initial state for every item. Default "lit". */
  initialState?: DressingState;
}

/** The cell a door/opening occupies on its wall. */
function doorCell(
  wall: WallSide,
  at: number,
  gridW: number,
  gridH: number,
): { gx: number; gy: number } {
  switch (wall) {
    case "north":
      return { gx: at, gy: 0 };
    case "south":
      return { gx: at, gy: gridH - 1 };
    case "west":
      return { gx: 0, gy: at };
    case "east":
      return { gx: gridW - 1, gy: at };
  }
}

function cellKey(gx: number, gy: number): string {
  return `${gx},${gy}`;
}

function makeItem(
  kind: DressingKind,
  id: string,
  gx: number,
  gy: number,
  placement: DressingPlacement,
  state: DressingState,
): DressingItem {
  const preset = DRESSING_LIGHTS[kind];
  // Every kind has a real pack tile (BRA-192) — no tileNeeded, no
  // null. A plan carrying a null tile is a stale plan; validation
  // rejects it rather than building around it.
  return {
    id,
    kind,
    gx,
    gy,
    tile: DRESSING_TILES[kind],
    placement,
    light: {
      x: gx * TILE_PX + TILE_PX / 2,
      y: gy * TILE_PX + TILE_PX / 2,
      ...preset,
    },
    lightId: null,
    state,
    chatLines: DRESSING_CHAT_LINES[kind],
  };
}

/**
 * Plan the interactive dressing for a room: torches along the walls
 * (every `spacing` cells, skipping door cells and corners), candles on
 * tables when given (otherwise floor cells next to a wall, picked by
 * seed), braziers in the corners of large rooms. Deterministic for a
 * given seed. Never places on a door cell, never two items on one
 * cell, never outside the room, never on a maze wall cell.
 */
export function planDressing(
  roomSpec: RoomSpec,
  opts: PlanDressingOptions = {},
): DressingPlan {
  const { gridW, gridH } = roomSpec;
  if (!Number.isInteger(gridW) || !Number.isInteger(gridH) || gridW < 1 || gridH < 1) {
    throw new Error(`Room must be at least 1x1 grid squares, got ${gridW}x${gridH}.`);
  }
  const seed = opts.seed ?? 1;
  const spacing = opts.spacing ?? 3;
  if (!Number.isInteger(spacing) || spacing < 1) {
    throw new Error(`Torch spacing must be an integer >= 1, got ${spacing}.`);
  }
  const state = opts.initialState ?? "lit";
  const grids = mazeGridsFor(roomSpec);
  const occupied = new Set<string>();
  const items: DressingItem[] = [];

  const doorCells = new Set<string>();
  for (const d of [...(roomSpec.doors ?? []), ...(roomSpec.openings ?? [])]) {
    const c = doorCell(d.wall, d.at, gridW, gridH);
    doorCells.add(cellKey(c.gx, c.gy));
  }

  const claim = (item: DressingItem): boolean => {
    const key = cellKey(item.gx, item.gy);
    if (occupied.has(key)) return false;
    if (isMazeWallCell(grids, item.gx, item.gy)) return false;
    occupied.add(key);
    items.push(item);
    return true;
  };

  // Torches: along each wall, cells 1, 1+spacing, ... — corners skipped
  // (index 0 and the last index are corners), door cells skipped.
  const sides: { side: WallSide; cells: number }[] = [
    { side: "north", cells: gridW },
    { side: "south", cells: gridW },
    { side: "west", cells: gridH },
    { side: "east", cells: gridH },
  ];
  for (const { side, cells } of sides) {
    for (let at = 1; at < cells - 1; at += spacing) {
      const { gx, gy } = doorCell(side, at, gridW, gridH);
      if (doorCells.has(cellKey(gx, gy))) continue;
      claim(makeItem("torch", `torch-${side[0]}-${at}`, gx, gy, "wall", state));
    }
  }

  // Braziers: the four corners, large rooms only. Torches skip corners,
  // so there is no collision — but claim() still guards the cell.
  if ((opts.braziers ?? true) && gridW >= BRAZIER_MIN_SIZE && gridH >= BRAZIER_MIN_SIZE) {
    const corners: { id: string; gx: number; gy: number }[] = [
      { id: "brazier-nw", gx: 0, gy: 0 },
      { id: "brazier-ne", gx: gridW - 1, gy: 0 },
      { id: "brazier-sw", gx: 0, gy: gridH - 1 },
      { id: "brazier-se", gx: gridW - 1, gy: gridH - 1 },
    ];
    for (const c of corners) claim(makeItem("brazier", c.id, c.gx, c.gy, "floor", state));
  }

  // Candles: on tables when given, otherwise floor cells next to a wall.
  const maxCandles = opts.maxCandles ?? 6;
  const tables = (opts.tables ?? []).filter(
    (t) =>
      Number.isInteger(t.gx) &&
      Number.isInteger(t.gy) &&
      t.gx >= 0 &&
      t.gx < gridW &&
      t.gy >= 0 &&
      t.gy < gridH,
  );
  if (tables.length > 0) {
    for (const t of tables.slice(0, maxCandles)) {
      claim(
        makeItem("candle", `candle-table-${t.gx}-${t.gy}`, t.gx, t.gy, "table", state),
      );
    }
  } else {
    const candleCount = opts.candleCount ?? 2;
    const candidates: { gx: number; gy: number }[] = [];
    for (let gy = 1; gy < gridH - 1; gy++) {
      for (let gx = 1; gx < gridW - 1; gx++) {
        if (gx !== 1 && gx !== gridW - 2 && gy !== 1 && gy !== gridH - 2) continue;
        if (occupied.has(cellKey(gx, gy))) continue;
        if (isMazeWallCell(grids, gx, gy)) continue;
        candidates.push({ gx, gy });
      }
    }
    // Seeded shuffle — same seed, same candles.
    const rand = mulberry32(seed);
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    for (const c of candidates.slice(0, candleCount)) {
      claim(makeItem("candle", `candle-floor-${c.gx}-${c.gy}`, c.gx, c.gy, "floor", state));
    }
  }

  const lights: DressingLightDoc[] = items.map((item) => ({
    itemId: item.id,
    ...item.light,
    lightId: item.lightId,
  }));
  const tileGaps = [...new Set(items.filter((i) => i.tile === null).map((i) => i.tileNeeded as string))];
  return { roomId: roomSpec.name, items, lights, tileGaps, seed };
}

/** The Foundry update that flips one item's light, plus its chat line. */
export interface DressingToggle {
  /** The item with its state flipped (a copy — the input is untouched). */
  item: DressingItem;
  /** The AmbientLight _id to update (null until the plan is built). */
  lightId: string | null;
  /** Dot-notation update for modifyDocument, per the lights.ts pattern. */
  update: { hidden: boolean; "config.alpha": number };
  /** The chat line for the new state. */
  chatLine: string;
}

/**
 * Toggle one dressing item. Off = hidden + alpha 0; on = shown + the
 * item's own alpha — so a relight restores exactly the same light.
 * Pure: returns a new item, the input is untouched.
 */
export function toggleDressing(item: DressingItem, state: DressingState): DressingToggle {
  const next: DressingItem = { ...item, state };
  return {
    item: next,
    lightId: item.lightId,
    update:
      state === "lit"
        ? { hidden: false, "config.alpha": item.light.alpha }
        : { hidden: true, "config.alpha": 0 },
    chatLine: item.chatLines[state],
  };
}

/**
 * Validate a plan against its room. Returns every problem found
 * (empty = valid), never a silent skip.
 */
export function validateDressingPlan(plan: DressingPlan, roomSpec: RoomSpec): string[] {
  const errors: string[] = [];
  const { gridW, gridH } = roomSpec;
  if (plan.roomId !== roomSpec.name) {
    errors.push(`Plan is for room "${plan.roomId}", not "${roomSpec.name}".`);
  }

  const doorCells = new Set<string>();
  for (const d of [...(roomSpec.doors ?? []), ...(roomSpec.openings ?? [])]) {
    const c = doorCell(d.wall, d.at, gridW, gridH);
    doorCells.add(cellKey(c.gx, c.gy));
  }

  const seenCells = new Set<string>();
  const seenIds = new Set<string>();
  const seenLightIds = new Set<string>();
  const lightItemIds = new Set(plan.lights.map((l) => l.itemId));
  for (const item of plan.items) {
    if (!Number.isInteger(item.gx) || !Number.isInteger(item.gy)) {
      errors.push(`Item ${item.id}: cell (${item.gx},${item.gy}) is not integer.`);
      continue;
    }
    if (item.gx < 0 || item.gx >= gridW || item.gy < 0 || item.gy >= gridH) {
      errors.push(`Item ${item.id} (${item.kind}) at (${item.gx},${item.gy}) is outside a ${gridW}x${gridH} room.`);
    }
    const key = cellKey(item.gx, item.gy);
    if (seenCells.has(key)) errors.push(`Two items on cell (${item.gx},${item.gy}).`);
    seenCells.add(key);
    if (seenIds.has(item.id)) errors.push(`Duplicate item id: ${item.id}.`);
    seenIds.add(item.id);
    if (item.lightId !== null) {
      if (seenLightIds.has(item.lightId)) errors.push(`Duplicate lightId: ${item.lightId}.`);
      seenLightIds.add(item.lightId);
    }
    if (item.kind === "torch" && doorCells.has(key)) {
      errors.push(`Torch ${item.id} sits on a door cell (${item.gx},${item.gy}).`);
    }
    if (item.kind === "brazier") {
      const isCorner =
        (item.gx === 0 || item.gx === gridW - 1) && (item.gy === 0 || item.gy === gridH - 1);
      if (!isCorner) errors.push(`Brazier ${item.id} is not in a corner.`);
      if (gridW < BRAZIER_MIN_SIZE || gridH < BRAZIER_MIN_SIZE) {
        errors.push(`Brazier ${item.id} in a ${gridW}x${gridH} room — braziers need ${BRAZIER_MIN_SIZE}x${BRAZIER_MIN_SIZE} or larger.`);
      }
    }
    // Tile contract: every kind has a real pack tile (BRA-192) — the
    // item must name its kind's tile and carry no tileNeeded. A null
    // tile (or a stale tileNeeded) is a plan from before the
    // candle/brazier tiles existed; the plan is rejected, never
    // built around with a faked tile.
    if (item.tile !== DRESSING_TILES[item.kind]) {
      errors.push(
        `${item.kind} ${item.id} must use tile "${DRESSING_TILES[item.kind]}", got ${JSON.stringify(item.tile)}.`,
      );
    }
    if (item.tileNeeded !== undefined) {
      errors.push(
        `${item.kind} ${item.id} records tileNeeded "${item.tileNeeded}" — the pack has a ${item.kind} tile now, so a stale tileNeeded means a stale plan.`,
      );
    }
    // The light itself.
    const l = item.light;
    if (!l || typeof l.dim !== "number" || l.dim < 0 || typeof l.bright !== "number" || l.bright < 0 || l.bright > l.dim) {
      errors.push(`Item ${item.id}: light must have 0 <= bright <= dim, got dim=${l?.dim} bright=${l?.bright}.`);
    }
    if (!l || !isValidHexColor(l.color)) {
      errors.push(`Item ${item.id}: light color must be #rrggbb, got ${JSON.stringify(l?.color)}.`);
    }
    if (!l || typeof l.alpha !== "number" || l.alpha < 0 || l.alpha > 1) {
      errors.push(`Item ${item.id}: light alpha must be 0..1, got ${l?.alpha}.`);
    }
    if (l && (l.x !== item.gx * TILE_PX + TILE_PX / 2 || l.y !== item.gy * TILE_PX + TILE_PX / 2)) {
      errors.push(`Item ${item.id}: light is not at the cell centre.`);
    }
    if (!lightItemIds.has(item.id)) {
      errors.push(`Item ${item.id} has no light in the plan.`);
    }
    if (!item.chatLines?.lit || !item.chatLines?.unlit) {
      errors.push(`Item ${item.id} is missing a chat line for a state.`);
    }
  }
  for (const light of plan.lights) {
    const item = plan.items.find((i) => i.id === light.itemId);
    if (!item) {
      errors.push(`Light for item "${light.itemId}" has no matching item.`);
      continue;
    }
    if (
      light.x !== item.light.x ||
      light.y !== item.light.y ||
      light.dim !== item.light.dim ||
      light.bright !== item.light.bright ||
      light.color !== item.light.color ||
      light.alpha !== item.light.alpha
    ) {
      errors.push(`Light for item "${light.itemId}" does not match the item's light.`);
    }
    if (light.lightId !== item.lightId) {
      errors.push(`Light for item "${light.itemId}" has a different lightId than its item.`);
    }
  }
  return errors;
}

/**
 * The group name for a dressing kind — the name its lights are
 * addressable by (FR-7, BRA-197). "Torches" is not "torchs": the
 * plural is spelled out, not derived by adding "s".
 */
export const DRESSING_KIND_GROUP_NAME: Record<DressingKind, string> = {
  torch: "the torches",
  candle: "the candles",
  brazier: "the braziers",
};

/**
 * What the composer hook adds to a RoomSpec from a plan: torch cells
 * (the `torches` shorthand), one LightSpec per item, and a dressing
 * placement per item that has a tile. Items without a tile are left
 * out of `dressing` and listed in `skipped` — the hook must not build
 * what it cannot draw. (With the pack complete, `skipped` is empty;
 * the field stays so a future pack gap fails the same loud way.)
 *
 * Each light is named for its kind (DRESSING_KIND_GROUP_NAME) — so a
 * whole kind can be addressed by name once built ("dim the
 * braziers"). The name rides the LightSpec into the room spec and is
 * stamped into the created AmbientLight's flags by `addLights`. Each
 * light also carries its item's `alpha` (LightSpec.alpha, BRA-192)
 * and its `dressingId`, so the hook can pair the created _id back to
 * the item. Each dressing placement carries the item id twice: as
 * its prop `id` (so move/remove can address it like any prop) and as
 * `dressingId` (so layoutRoom stamps flags.meroki.dressingId on the
 * tile).
 */
export function dressingToRoomSpec(plan: DressingPlan): {
  torches: { gx: number; gy: number }[];
  lights: LightSpec[];
  dressing: { tile: string; gx: number; gy: number; id: string; dressingId: string }[];
  skipped: string[];
} {
  const torches = plan.items
    .filter((i) => i.kind === "torch")
    .map((i) => ({ gx: i.gx, gy: i.gy }));
  const lights: LightSpec[] = plan.items.map((i) => ({
    x: i.light.x,
    y: i.light.y,
    dim: i.light.dim,
    bright: i.light.bright,
    color: i.light.color,
    alpha: i.light.alpha,
    name: DRESSING_KIND_GROUP_NAME[i.kind],
    dressingId: i.id,
  }));
  const dressing: { tile: string; gx: number; gy: number; id: string; dressingId: string }[] = [];
  const skipped: string[] = [];
  for (const item of plan.items) {
    if (item.tile !== null) {
      dressing.push({ tile: item.tile, gx: item.gx, gy: item.gy, id: item.id, dressingId: item.id });
    } else skipped.push(item.id);
  }
  return { torches, lights, dressing, skipped };
}

/** Options for the composer hook (layoutRoomWithDressing). */
export interface DressingHookOptions {
  /** planDressing options — seed, spacing, tables, braziers. */
  plan?: PlanDressingOptions;
  /** An explicit theme (one-word name or ThemeSpec) — passed through
   *  to layoutRoom; with neither, the room builds in its own theme. */
  theme?: string | ThemeSpec;
}

/**
 * The composer hook, pure half: merge a dressing plan into a room
 * spec and return the new spec (the input is untouched). Lights join
 * `spec.lights` (one per item, named by kind, with its own alpha and
 * dressingId) and dressing placements join `spec.dressing` — the
 * existing layout path then creates the tiles and lights, and
 * `addLights` returns the _ids in creation order, so the live half
 * can pair each returned _id with its item (resolveDressingPairing).
 *
 * Throws, listing every problem, when the plan is invalid for this
 * room, when it names another room, or when it still has tile gaps —
 * a plan that cannot build is never merged silently. Also throws when
 * a dressing item id collides with a prop id the room already has.
 */
export function applyDressingToSpec(
  spec: RoomSpec,
  plan: DressingPlan,
): { spec: RoomSpec; items: DressingItem[] } {
  const errors = validateDressingPlan(plan, spec);
  if (plan.tileGaps.length > 0) {
    errors.push(
      `Plan has tile gaps: ${plan.tileGaps.join(", ")} — generate the pack tiles first, the hook never builds what it cannot draw.`,
    );
  }
  if (errors.length > 0) {
    throw new Error(`Cannot dress room "${spec.name}": ${errors.join(" ")}`);
  }
  const existingIds = new Set((spec.dressing ?? []).map((p) => p.id).filter((id): id is string => !!id));
  for (const item of plan.items) {
    if (existingIds.has(item.id)) {
      throw new Error(
        `Cannot dress room "${spec.name}": dressing item "${item.id}" collides with a prop id the room already has.`,
      );
    }
  }
  const { lights, dressing } = dressingToRoomSpec(plan);
  // NOTE: torches are NOT merged into spec.torches. The plan's torch
  // lights are already in `lights` — merging the shorthand too would
  // give every torch two lights (one theme torch from the shorthand,
  // one named dressing light). dressingToRoomSpec still returns the
  // torch cells for callers that need positions without lights.
  return {
    spec: {
      ...spec,
      lights: [...(spec.lights ?? []), ...lights],
      dressing: [...(spec.dressing ?? []), ...dressing],
    },
    items: plan.items,
  };
}

/**
 * Run the dressing pass per room and lay it out: planDressing, merge
 * into the spec, layoutRoom. One call is the whole composer hook —
 * the caller (buildTileRoom, the floor planner, a CLI) builds the
 * returned layout, then pairs the created ids with
 * resolveDressingPairing. Pure — no Foundry, no network.
 */
export function layoutRoomWithDressing(
  spec: RoomSpec,
  pack: Pack,
  serverBase: string,
  opts: DressingHookOptions = {},
): { plan: DressingPlan; spec: RoomSpec; layout: RoomLayout } {
  const plan = planDressing(spec, opts.plan ?? {});
  const { spec: dressed } = applyDressingToSpec(spec, plan);
  return { plan, spec: dressed, layout: layoutRoom(dressed, pack, serverBase, opts.theme) };
}

/** One dressing item, fully built: its tile _id and its light _id. */
export interface DressingPair {
  itemId: string;
  tileId: string;
  lightId: string;
  /**
   * The flag record the live half writes onto the tile:
   * flags.meroki = { dressingId, lightId, kind, alpha } — the whole
   * record the click module needs, so a tile built before the module
   * existed still toggles once its flag is completed.
   */
  tileFlags: { dressingId: string; lightId: string; kind: DressingKind; alpha: number };
}

/** The flag scope the dressing tiles carry. */
export const DRESSING_FLAG_SCOPE = "meroki";

/** Read the dressing id a layout tile carries, or null. */
function tileDressingId(tile: RoomLayout["tiles"][number]): string | null {
  const scope = tile.flags?.[DRESSING_FLAG_SCOPE];
  if (typeof scope !== "object" || scope === null) return null;
  const id = (scope as Record<string, unknown>).dressingId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Pair the created ids back to their items, after the live build.
 * `tileIds` / `lightIds` are the _ids buildTileRoom returned, in
 * layout order (tileIds[i] is layout.tiles[i]'s _id, lightIds[i] is
 * layout.lights[i]'s). The join key is the dressing id: layout tiles
 * carry it in flags.meroki.dressingId, layout lights carry it in
 * LightSpec.dressingId.
 *
 * Returns every pair plus every problem found (empty = fully paired)
 * — a tile without a light, a light without a tile, a duplicate
 * dressing id, or an id array that does not line up with its layout
 * array. Never pairs by position alone and never silently drops an
 * item: the live half throws when errors is non-empty. The caller
 * also needs the plan for the kind/alpha in tileFlags — pass it in.
 */
export function resolveDressingPairing(
  plan: DressingPlan,
  layout: RoomLayout,
  tileIds: string[],
  lightIds: string[],
): { pairs: DressingPair[]; errors: string[] } {
  const errors: string[] = [];
  if (tileIds.length !== layout.tiles.length) {
    errors.push(
      `tileIds has ${tileIds.length} entries for ${layout.tiles.length} layout tiles — the build did not return one _id per tile.`,
    );
  }
  if (lightIds.length !== layout.lights.length) {
    errors.push(
      `lightIds has ${lightIds.length} entries for ${layout.lights.length} layout lights — the build did not return one _id per light.`,
    );
  }
  const byId = new Map(plan.items.map((i) => [i.id, i]));
  const tileByItem = new Map<string, string>();
  for (let i = 0; i < layout.tiles.length; i++) {
    const dressingId = tileDressingId(layout.tiles[i]);
    if (!dressingId) continue;
    if (!byId.has(dressingId)) {
      errors.push(`Layout tile ${i} carries dressingId "${dressingId}", which is not an item in this plan.`);
      continue;
    }
    if (tileByItem.has(dressingId)) {
      errors.push(`Two layout tiles carry dressingId "${dressingId}" — one item, one tile.`);
      continue;
    }
    tileByItem.set(dressingId, tileIds[i] ?? "");
  }
  const lightByItem = new Map<string, string>();
  for (let i = 0; i < layout.lights.length; i++) {
    const dressingId = layout.lights[i].dressingId;
    if (!dressingId) continue;
    if (!byId.has(dressingId)) {
      errors.push(`Layout light ${i} carries dressingId "${dressingId}", which is not an item in this plan.`);
      continue;
    }
    if (lightByItem.has(dressingId)) {
      errors.push(`Two layout lights carry dressingId "${dressingId}" — one item, one light.`);
      continue;
    }
    lightByItem.set(dressingId, lightIds[i] ?? "");
  }
  const pairs: DressingPair[] = [];
  for (const item of plan.items) {
    const tileId = tileByItem.get(item.id);
    const lightId = lightByItem.get(item.id);
    if (!tileId) errors.push(`Item ${item.id} (${item.kind}) has no tile in the layout — its tile was not built.`);
    if (!lightId) errors.push(`Item ${item.id} (${item.kind}) has no light in the layout — its light was not built.`);
    if (tileId && lightId) {
      pairs.push({
        itemId: item.id,
        tileId,
        lightId,
        tileFlags: { dressingId: item.id, lightId, kind: item.kind, alpha: item.light.alpha },
      });
    }
  }
  return { pairs, errors };
}

/** One-line summary per item, for the CLI and the chat. */
export function formatDressingPlan(plan: DressingPlan): string[] {
  return plan.items.map(
    (item) =>
      `${item.kind} ${item.id} at (${item.gx},${item.gy}) [${item.placement}] — ` +
      `light dim ${item.light.dim}/bright ${item.light.bright} ${item.light.color} ` +
      `alpha ${item.light.alpha}, ${item.state}` +
      (item.tile === null ? `, tile needed: ${item.tileNeeded}` : `, tile ${item.tile}`),
  );
}
