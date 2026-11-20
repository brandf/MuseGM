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
 * Pure functions only — no Foundry, no network. The live layer (the
 * composer hook that turns a plan into Tile + AmbientLight documents,
 * and the click handler that calls `toggleDressing`) is a later step;
 * see docs/interactive-dressing.md.
 *
 * Light language (FR-7 + the Lich's Lair lighting fix, Nov 19):
 * warm torch amber #ff9a3c, alpha 0.4. A candle is a smaller, paler
 * flame; a brazier is a bigger fire. The toggle is stateful by design:
 * the light document carries the state (hidden on/off + alpha), so a
 * relight restores exactly the same light.
 *
 * Tile honesty: the pack has a torch tile ("sconce", 100px, dressing
 * layer) but NO candle or brazier tile yet. Candle and brazier items
 * carry `tile: null` + `tileNeeded` and the plan lists them in
 * `tileGaps` — the composer hook cannot build them until those tiles
 * exist, and this module never fakes a tile for them.
 */
import { mulberry32 } from "../worldbuilding/maze.js";
import {
  isMazeWallCell,
  mazeGridsFor,
  TILE_PX,
  type RoomSpec,
  type WallSide,
} from "../worldbuilding/tiles-layout.js";
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

/** Pack tile per kind — null where the pack has no tile yet. */
export const DRESSING_TILES: Record<DressingKind, string | null> = {
  torch: "sconce",
  candle: null,
  brazier: null,
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
  const tile = DRESSING_TILES[kind];
  return {
    id,
    kind,
    gx,
    gy,
    tile,
    ...(tile === null ? { tileNeeded: kind } : {}),
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
    // Tile contract: torches use the sconce; candle/brazier have no
    // tile yet and must say so (never a faked tile).
    if (item.kind === "torch" && item.tile !== "sconce") {
      errors.push(`Torch ${item.id} must use tile "sconce", got ${JSON.stringify(item.tile)}.`);
    }
    if ((item.kind === "candle" || item.kind === "brazier") && item.tile !== null) {
      errors.push(`${item.kind} ${item.id} must have tile null (pack has no ${item.kind} tile), got ${JSON.stringify(item.tile)}.`);
    }
    if ((item.kind === "candle" || item.kind === "brazier") && item.tileNeeded !== item.kind) {
      errors.push(`${item.kind} ${item.id} must record tileNeeded "${item.kind}".`);
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
 * What the composer hook adds to a RoomSpec from a plan: torch cells
 * (the `torches` shorthand), one LightSpec per item, and a dressing
 * placement per item that has a tile. Items without a tile (candle,
 * brazier until the pack has them) are left out of `dressing` and
 * listed in `skipped` — the hook must not build what it cannot draw.
 *
 * Known gap: LightSpec carries no alpha (addLights hardcodes 0.5), so
 * the hook must set each light's alpha in a post-create update — see
 * docs/interactive-dressing.md.
 */
export function dressingToRoomSpec(plan: DressingPlan): {
  torches: { gx: number; gy: number }[];
  lights: { x: number; y: number; dim: number; bright: number; color: string }[];
  dressing: { tile: string; gx: number; gy: number }[];
  skipped: string[];
} {
  const torches = plan.items
    .filter((i) => i.kind === "torch")
    .map((i) => ({ gx: i.gx, gy: i.gy }));
  const lights = plan.items.map((i) => ({
    x: i.light.x,
    y: i.light.y,
    dim: i.light.dim,
    bright: i.light.bright,
    color: i.light.color,
  }));
  const dressing: { tile: string; gx: number; gy: number }[] = [];
  const skipped: string[] = [];
  for (const item of plan.items) {
    if (item.tile !== null) dressing.push({ tile: item.tile, gx: item.gx, gy: item.gy });
    else skipped.push(item.id);
  }
  return { torches, lights, dressing, skipped };
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
