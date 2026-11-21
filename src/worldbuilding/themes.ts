/**
 * Theme re-skin (FR-2): a theme is a named palette + floor/wall/fog/
 * dressing variant set. The GM picks one word ("western") and the same
 * room spec rebuilds with a different look — the layout (walls, doors,
 * links) is unchanged, only the look.
 *
 * Pure data + pure functions — no Foundry, no network. The composer
 * (tiles-layout.ts) resolves the theme and swaps tile names at layout
 * time; the live builders (tiles.ts) take the theme's light palette
 * and Level background colour.
 *
 * A theme is a pack variant, not a rebuild: every tile name a theme
 * references must exist in the pack. `themeTileGaps` lists the ones
 * that don't — the composer throws naming the theme + the missing tile
 * instead of ever faking one (the dressing.ts tileGaps precedent).
 *
 * The two themes shipped here:
 * - "dungeon": the existing look, made explicit — cold blue-grey
 *   stone, warm amber torch pools, green eerie fog (STYLE.md).
 *   Behaviour is identical to the pre-theme composer.
 * - "western": a desert frontier town — sun-baked sandstone floors,
 *   wood-plank walls, dust drifting instead of fog. The western tiles
 *   are procedural (tiles/procedural/generate_tiles.py), same
 *   code-over-AI rule as the dungeon pack.
 *
 * Fog/dressing placements in a room spec name pack tiles directly, so
 * a theme remaps them: a spec that says fog "fog-wisp-large" gets
 * "dust-wisp-large" under the western theme, and "bones" stays "bones"
 * (no western bones equivalent exists yet — the dressing map is empty
 * for western, and a western dressing tile set is a later pack
 * addition, not something to fake).
 */
import type { Pack } from "./tiles-layout.js";

/** Floor tile names for one theme. */
export interface ThemeFloor {
  plain: string;
  cracked: string;
  rubble: string;
  /** The cold/dark floor for deeper rooms and enclosed maze cells. */
  dark: string;
}

/** Wall tile names for one theme. */
export interface ThemeWall {
  straight: string;
  corner: string;
  door: string;
}

/** The theme's light language (FR-7 + the Lich's Lair lighting fix). */
export interface ThemeTorch {
  dim: number;
  bright: number;
  color: string;
}

export interface ThemeSpec {
  /** One-word id, e.g. "dungeon", "western". Lowercase, no spaces. */
  id: string;
  /** Display name, e.g. "Western". */
  label: string;
  /** One line for the GM: what this theme looks like. */
  description: string;
  floor: ThemeFloor;
  wall: ThemeWall;
  /**
   * Fog remap: generic fog tile name -> themed fog tile. Applied to
   * spec.fog placements at layout time, so a room spec written with
   * "fog-wisp-large" re-skins to dust under the western theme.
   */
  atmosphere: Record<string, string>;
  /**
   * Dressing remap: generic dressing tile name -> themed dressing
   * tile. Applied to spec.dressing placements at layout time. Empty
   * when the theme has no dressing variants yet — placements keep
   * their tile names.
   */
  dressing: Record<string, string>;
  /** Torch shorthand lights + the sconce glow for this theme. */
  torch: ThemeTorch;
  /** The colour-only Level background for a room in this theme
   *  (tiles.ts paints the Level with it — the tiles are the map). */
  backgroundColor: string;
}

/** The dungeon baseline, made explicit — the pre-theme look, unchanged. */
export const DUNGEON_THEME: ThemeSpec = {
  id: "dungeon",
  label: "Dungeon",
  description:
    "Cold blue-grey stone, warm amber torch pools, bone off-white, green eerie fog — the Lich's Lair look (STYLE.md).",
  floor: {
    plain: "floor-plain",
    cracked: "floor-cracked",
    rubble: "floor-rubble",
    dark: "floor-dark",
  },
  wall: {
    straight: "wall-straight",
    corner: "wall-corner",
    door: "wall-door",
  },
  atmosphere: {},
  dressing: {},
  torch: { dim: 300, bright: 120, color: "#ff9a3c" },
  backgroundColor: "#050508",
};

/** The western theme: a desert frontier town. */
export const WESTERN_THEME: ThemeSpec = {
  id: "western",
  label: "Western",
  description:
    "Sun-baked sandstone floors, wood-plank walls, lantern gold light, dust drifting where the fog was — a frontier town, not a crypt.",
  floor: {
    plain: "floor-sand",
    cracked: "floor-sand-cracked",
    rubble: "floor-sand-rubble",
    dark: "floor-sand-dark",
  },
  wall: {
    straight: "wall-wood-straight",
    corner: "wall-wood-corner",
    door: "wall-wood-door",
  },
  atmosphere: {
    "fog-wisp-small": "dust-wisp-small",
    "fog-wisp-large": "dust-wisp-large",
    "fog-pool": "dust-pool",
  },
  dressing: {},
  torch: { dim: 280, bright: 110, color: "#ffb347" },
  backgroundColor: "#0d0a07",
};

/** Every theme the composer knows, by id. */
export const THEMES: Record<string, ThemeSpec> = {
  [DUNGEON_THEME.id]: DUNGEON_THEME,
  [WESTERN_THEME.id]: WESTERN_THEME,
};

/** All tile names a theme references (floor + wall + remap values). */
export function themeTileNames(theme: ThemeSpec): string[] {
  return [
    theme.floor.plain,
    theme.floor.cracked,
    theme.floor.rubble,
    theme.floor.dark,
    theme.wall.straight,
    theme.wall.corner,
    theme.wall.door,
    ...Object.values(theme.atmosphere),
    ...Object.values(theme.dressing),
  ];
}

/**
 * Tiles this theme needs that the pack does not have — the honest gap
 * list (dressing.ts precedent). Empty means the theme builds today.
 */
export function themeTileGaps(theme: ThemeSpec, pack: Pack): string[] {
  const gaps: string[] = [];
  for (const name of themeTileNames(theme)) {
    if (!pack.get(name) && !gaps.includes(name)) gaps.push(name);
  }
  return gaps;
}

/**
 * Resolve a theme: a ThemeSpec passes through, a one-word name looks
 * the theme up (case-insensitive, trimmed — the GM says "western",
 * not "Western"), and undefined/empty means the dungeon baseline.
 * Unknown names throw, listing the themes that exist — a typo should
 * fail loudly at build time, not silently build the wrong look.
 */
export function resolveTheme(theme?: string | ThemeSpec): ThemeSpec {
  if (!theme) return DUNGEON_THEME;
  if (typeof theme !== "string") return theme;
  const id = theme.trim().toLowerCase();
  if (!id) return DUNGEON_THEME;
  const found = THEMES[id];
  if (!found) {
    throw new Error(
      `Unknown theme "${theme}" — known themes: ${Object.keys(THEMES).join(", ")}.`,
    );
  }
  return found;
}

/** One-word theme names the GM can pick, in registry order. */
export function listThemes(): string[] {
  return Object.keys(THEMES);
}
