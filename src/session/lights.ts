/**
 * Timed light transitions (FR-7 core, used by the cutscene engine).
 *
 * A light bloom is a fade over seconds, not an instant swap: the
 * mage's casting light animates dim/bright/color from its current
 * state to the target over `durationMs`, in small steps. Pure color
 * math lives here (unit-tested); the live animation is one small
 * wrapper over `modifyDocument`.
 *
 * Light document shape (Foundry 14.370, verified live Nov 19):
 * AmbientLight { _id, x, y, config: { dim, bright, angle, color,
 * alpha }, hidden }. Updates use dot-notation keys ("config.dim") —
 * the standard Foundry pattern for partial updates of nested fields;
 * flag for live verification.
 *
 * Named lights (FR-7, BRA-197) — the naming layer over the lights:
 * a light placed in a room can be given a name ("the braziers",
 * "the altar candles"), stamped into its flags at build time
 * (`flags["foundry-live"].lightName`, see `addLights`), and later
 * steps/commands address the name instead of a Light _id or a
 * coordinate. A name addresses a GROUP of lights: every light
 * carrying that name animates together ("the braziers" is all the
 * braziers, not one). Resolution is pure — `resolveNamedLights`
 * over a scene's light docs — with clear errors: unknown names list
 * the names that exist, a name matching several groups asks for one
 * exactly. Never guess, never animate a partial match silently.
 *
 * What this layer does NOT wire (follow-ups, not this item): the
 * cutscene `light` step still validates `{id} | {at}` only — its
 * validation needs to accept `{name}` and call `animateNamedLights`.
 * The monitor chat routing ("dim the braziers") is built (BRA-240,
 * Nov 20 — `src/session/light-commands.ts` + the monitor "light" class).
 *
 * Honest limit: resolving a light by proximity, or reading its
 * current state as the animation's `from`, needs the scene's lights
 * in this connection's worldData cache. If the cache has no lights
 * (the vendored client may not track them), pass the light's _id and
 * explicit `from` values instead — the update itself works by _id
 * with no read.
 */
import type { FoundryLive } from "../live.js";
import { FLAG_FIELDS, FLAG_SCOPE } from "../idempotency.js";

export interface LightState {
  dim: number;
  bright: number;
  color: string;
  alpha: number;
}

export interface LightDoc {
  _id: string;
  x: number;
  y: number;
  config?: Partial<LightState> & { angle?: number };
  hidden?: boolean;
  /** Build-time flags — a named light carries `lightName` here. */
  flags?: Record<string, Record<string, unknown> | undefined> | null;
}

export type LightSelector = { id: string } | { at: { x: number; y: number } };

export function isValidHexColor(s: unknown): s is string {
  return typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s);
}

export function parseHexColor(hex: string): { r: number; g: number; b: number } {
  if (!isValidHexColor(hex)) throw new Error(`Invalid hex color: ${JSON.stringify(hex)} (want #rrggbb)`);
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

export function toHexColor(c: { r: number; g: number; b: number }): string {
  const p = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${p(c.r)}${p(c.g)}${p(c.b)}`;
}

/** Linear interpolation between two light states (color in RGB). */
export function lerpLight(from: LightState, to: LightState, t: number): LightState {
  const c0 = parseHexColor(from.color);
  const c1 = parseHexColor(to.color);
  const lerp = (a: number, b: number): number => a + (b - a) * t;
  return {
    dim: lerp(from.dim, to.dim),
    bright: lerp(from.bright, to.bright),
    alpha: lerp(from.alpha, to.alpha),
    color: toHexColor({
      r: lerp(c0.r, c1.r),
      g: lerp(c0.g, c1.g),
      b: lerp(c0.b, c1.b),
    }),
  };
}

type RawScene = {
  _id: string;
  name?: string;
  lights?: LightDoc[];
};

function scenesOf(live: FoundryLive): RawScene[] {
  const data = live.raw().getWorldData() as unknown as { scenes?: RawScene[] } | null;
  return data?.scenes ?? [];
}

/** Resolve a scene by _id or name from current state. */
export function resolveSceneLights(live: FoundryLive, sceneIdOrName: string): LightDoc[] {
  const scenes = scenesOf(live);
  const scene =
    scenes.find((s) => s._id === sceneIdOrName) ??
    scenes.find((s) => s.name?.toLowerCase() === sceneIdOrName.toLowerCase());
  if (!scene) {
    throw new Error(
      `Scene not found: ${sceneIdOrName} (scenes now: ${scenes.map((s) => s.name ?? s._id).join(", ") || "none"})`,
    );
  }
  if (!scene.lights) {
    throw new Error(
      `Scene ${scene.name ?? scene._id} has no lights in this connection's cache — ` +
        `use the light's _id with explicit from values, or read the lights from a fresh connection first.`,
    );
  }
  return scene.lights;
}

export function lightStateOf(doc: LightDoc): LightState {
  return {
    dim: doc.config?.dim ?? 0,
    bright: doc.config?.bright ?? 0,
    color: typeof doc.config?.color === "string" ? doc.config.color : "#ffffff",
    alpha: doc.config?.alpha ?? 0.5,
  };
}

// ---------------------------------------------------------------- named lights (FR-7, BRA-197)

/**
 * Normalize a light name for matching: lowercase, trimmed, inner
 * whitespace collapsed, a leading "the" dropped. "The Braziers",
 * "the  braziers" and "braziers" are the same name. Returns "" for a
 * blank name.
 */
export function normalizeLightName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^the\b\s*/, "");
}

/**
 * The name a light doc carries in its flags, or null when it has
 * none. The stored name is returned as authored (trimmed) — the
 * display name for error messages; matching normalizes it.
 */
export function lightNameOf(doc: LightDoc): string | null {
  const raw = doc.flags?.[FLAG_SCOPE]?.[FLAG_FIELDS.lightName];
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  return name.length > 0 ? name : null;
}

/** One named light: its display name and its document _id. */
export interface NamedLight {
  name: string;
  id: string;
}

/** Every named light on a scene, in scene order. Unnamed lights are skipped. */
export function namedLightsOf(lights: LightDoc[]): NamedLight[] {
  const out: NamedLight[] = [];
  for (const doc of lights) {
    const name = lightNameOf(doc);
    if (name && typeof doc._id === "string" && doc._id.length > 0) {
      out.push({ name, id: doc._id });
    }
  }
  return out;
}

/** One name and every light carrying it — a name addresses a group. */
export interface NamedLightGroup {
  /** Display name (first-seen spelling). */
  name: string;
  ids: string[];
}

/**
 * Group a scene's lights by normalized name, first-seen display name
 * kept, ids in scene order. Two spellings of one name ("The
 * Braziers", "braziers") are one group.
 */
export function groupNamedLights(lights: LightDoc[]): NamedLightGroup[] {
  const groups: NamedLightGroup[] = [];
  const byKey = new Map<string, NamedLightGroup>();
  for (const { name, id } of namedLightsOf(lights)) {
    const key = normalizeLightName(name);
    let group = byKey.get(key);
    if (!group) {
      group = { name, ids: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.ids.push(id);
  }
  return groups;
}

/**
 * Resolve a name against a scene's lights. Exact normalized match
 * wins; otherwise a unique substring match ("brazier" finds "the
 * braziers"). Errors name the names that exist — never guess:
 * - unknown name: lists every named light on the scene (or says the
 *   scene has none);
 * - a name matching several groups: lists the matches and asks for
 *   one exactly;
 * - a blank query: lists the names to pick from.
 */
export function resolveNamedLights(lights: LightDoc[], query: string): NamedLightGroup {
  const groups = groupNamedLights(lights);
  const listNames = (): string => groups.map((g) => `"${g.name}"`).join(", ");
  if (groups.length === 0) {
    throw new Error(
      `This scene has no named lights — give a light a name when it is built ` +
        `(LightSpec.name, e.g. "the braziers") before addressing it by name.`,
    );
  }
  const key = normalizeLightName(query);
  if (!key) {
    throw new Error(`Name a light — named lights on this scene: ${listNames()}.`);
  }
  const exact = groups.find((g) => normalizeLightName(g.name) === key);
  if (exact) return exact;
  const partial = groups.filter((g) => normalizeLightName(g.name).includes(key));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(
      `"${query.trim()}" matches more than one light: ${partial.map((g) => `"${g.name}"`).join(", ")} — name one exactly.`,
    );
  }
  throw new Error(
    `No light named "${query.trim()}" on this scene — named lights here: ${listNames()}.`,
  );
}

/** One light's part of a named-light plan: from its current state to the target. */
export interface NamedLightTarget {
  lightId: string;
  /** Current state (the transition starts here). */
  from: LightState;
  to: LightState;
  durationMs: number;
  steps: number;
}

export interface NamedLightPlanOptions {
  /** Total time for the transition. Default 2000ms. */
  durationMs?: number;
  /** Update steps across the transition. Default 12. */
  steps?: number;
}

/**
 * Pure half of a named-light change: resolve the name to its group
 * and plan one transition per light, from each light's current state
 * to the target (fields the target leaves out stay where they are).
 * The plan is the full group, so the caller can see nothing was
 * missed.
 */
export function namedLightPlan(
  lights: LightDoc[],
  query: string,
  target: Partial<LightState>,
  opts: NamedLightPlanOptions = {},
): { name: string; targets: NamedLightTarget[] } {
  const group = resolveNamedLights(lights, query);
  if (target.color !== undefined && !isValidHexColor(target.color)) {
    throw new Error(`Invalid hex color: ${JSON.stringify(target.color)} (want #rrggbb)`);
  }
  const durationMs = opts.durationMs ?? 2000;
  const steps = opts.steps ?? 12;
  if (!(durationMs > 0) || !Number.isFinite(durationMs)) {
    throw new Error(`namedLightPlan: durationMs must be > 0, got ${durationMs}`);
  }
  if (!Number.isInteger(steps) || steps < 1) {
    throw new Error(`namedLightPlan: steps must be an integer >= 1, got ${steps}`);
  }
  const byId = new Map(lights.map((d) => [d._id, d]));
  const targets: NamedLightTarget[] = group.ids.map((id) => {
    const doc = byId.get(id);
    const from = doc ? lightStateOf(doc) : { dim: 0, bright: 0, color: "#ffffff", alpha: 0.5 };
    return {
      lightId: id,
      from,
      to: {
        dim: target.dim ?? from.dim,
        bright: target.bright ?? from.bright,
        color: target.color ?? from.color,
        alpha: target.alpha ?? from.alpha,
      },
      durationMs,
      steps,
    };
  });
  return { name: group.name, targets };
}

/**
 * Resolve a light: by _id (no read needed — the update works by _id),
 * or the nearest light to a point (needs the cache). Returns the
 * document _id plus its current state (from the cache when available).
 */
export function resolveLight(
  live: FoundryLive,
  sceneId: string,
  selector: LightSelector,
): { id: string; current: LightState | null } {
  if ("id" in selector) {
    let current: LightState | null = null;
    try {
      const lights = resolveSceneLights(live, sceneId);
      const doc = lights.find((l) => l._id === selector.id);
      if (doc) current = lightStateOf(doc);
    } catch {
      // Cache miss: the update still works by _id as long as the
      // caller supplies `from`. The caller decides whether to fail.
    }
    return { id: selector.id, current };
  }
  const lights = resolveSceneLights(live, sceneId);
  if (lights.length === 0) throw new Error(`Scene ${sceneId} has no lights to select from.`);
  let best = lights[0];
  let bestD = Math.hypot(best.x - selector.at.x, best.y - selector.at.y);
  for (const light of lights.slice(1)) {
    const d = Math.hypot(light.x - selector.at.x, light.y - selector.at.y);
    if (d < bestD) {
      best = light;
      bestD = d;
    }
  }
  return { id: best._id, current: lightStateOf(best) };
}

export interface LightsOutTarget {
  lightId: string;
  /** Current state (the fade starts here). */
  from: LightState;
  /** The dark state: no radius, no alpha, color unchanged. */
  to: LightState;
  durationMs: number;
  steps: number;
}

export interface LightsOutPlanOptions {
  /** Total fade time. Default 800ms — fast, but a fade, not a blink. */
  durationMs?: number;
  /** Update steps across the fade. Default 8. */
  steps?: number;
}

/**
 * FR-18 lights-out, pure half: every light on the scene fades to
 * nothing. The target keeps the light's color (a dead torch is still
 * a torch) and zeroes dim, bright, and alpha. A light already dark
 * stays in the plan with a zero-length fade — the plan is the full
 * scene, so the caller can see nothing was missed.
 */
export function lightsOutPlan(
  lights: LightDoc[],
  opts: LightsOutPlanOptions = {},
): LightsOutTarget[] {
  const durationMs = opts.durationMs ?? 800;
  const steps = opts.steps ?? 8;
  if (!(durationMs > 0) || !Number.isFinite(durationMs)) {
    throw new Error(`lightsOutPlan: durationMs must be > 0, got ${durationMs}`);
  }
  if (!Number.isInteger(steps) || steps < 1) {
    throw new Error(`lightsOutPlan: steps must be an integer >= 1, got ${steps}`);
  }
  return lights.map((doc) => {
    const from = lightStateOf(doc);
    return {
      lightId: doc._id,
      from,
      to: { dim: 0, bright: 0, color: from.color, alpha: 0 },
      durationMs,
      steps,
    };
  });
}

/**
 * FR-18 lights-out, live half: fade every AmbientLight on the scene
 * to nothing, in parallel (one fade per light — a sequential fade
 * across ten lights would take ten times as long and read as a
 * wave, not a blackout). Returns the per-light results.
 */
export async function lightsOut(
  live: FoundryLive,
  sceneId: string,
  opts: LightsOutPlanOptions = {},
): Promise<{ lightId: string; final: LightState }[]> {
  const lights = resolveSceneLights(live, sceneId);
  const plan = lightsOutPlan(lights, opts);
  return Promise.all(
    plan.map((t) =>
      animateLight(
        live,
        sceneId,
        { id: t.lightId },
        t.to,
        { durationMs: t.durationMs, steps: t.steps, from: t.from },
      ),
    ),
  );
}

export interface AnimateLightOptions {
  /** Total time for the transition. Default 2000ms. */
  durationMs?: number;
  /** Update steps across the transition. Default 12. */
  steps?: number;
  /** Explicit starting state (skips the cache read). */
  from?: Partial<LightState>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Animate a light from its current state (or `from`) to `target`
 * over `durationMs`, sending one AmbientLight update per step.
 * Returns the final state and the light _id.
 */
export async function animateLight(
  live: FoundryLive,
  sceneId: string,
  selector: LightSelector,
  target: Partial<LightState>,
  opts: AnimateLightOptions = {},
): Promise<{ lightId: string; final: LightState }> {
  const { id, current } = resolveLight(live, sceneId, selector);
  const from: LightState = {
    dim: opts.from?.dim ?? current?.dim ?? 0,
    bright: opts.from?.bright ?? current?.bright ?? 0,
    color: opts.from?.color ?? current?.color ?? "#ffffff",
    alpha: opts.from?.alpha ?? current?.alpha ?? 0.5,
  };
  const to: LightState = {
    dim: target.dim ?? from.dim,
    bright: target.bright ?? from.bright,
    color: target.color ?? from.color,
    alpha: target.alpha ?? from.alpha,
  };
  if (to.color !== from.color && !isValidHexColor(to.color)) {
    throw new Error(`Invalid hex color: ${JSON.stringify(to.color)} (want #rrggbb)`);
  }
  const durationMs = opts.durationMs ?? 2000;
  const steps = opts.steps ?? 12;
  if (!(durationMs > 0) || !Number.isFinite(durationMs)) {
    throw new Error(`animateLight: durationMs must be > 0, got ${durationMs}`);
  }
  if (!Number.isInteger(steps) || steps < 1) {
    throw new Error(`animateLight: steps must be an integer >= 1, got ${steps}`);
  }
  const scene = scenesOf(live).find(
    (s) => s._id === sceneId || s.name?.toLowerCase() === sceneId.toLowerCase(),
  );
  const parentUuid = `Scene.${scene?._id ?? sceneId}`;
  const stepMs = Math.max(50, durationMs / steps);
  let final: LightState = from;
  for (let i = 1; i <= steps; i++) {
    final = lerpLight(from, to, i / steps);
    await live.modifyDocument("AmbientLight", "update", {
      updates: [
        {
          _id: id,
          "config.dim": Math.round(final.dim),
          "config.bright": Math.round(final.bright),
          "config.color": final.color,
          "config.alpha": final.alpha,
        },
      ],
      parentUuid,
    });
    if (i < steps) await sleep(stepMs);
  }
  return { lightId: id, final };
}

// ---------------------------------------------------------------- named lights, live half (FR-7, BRA-197)

/**
 * Resolve a name against a scene's lights in this connection's
 * cache. Same errors as the pure resolver — unknown names list the
 * names that exist. Needs the cache (same honest limit as the
 * proximity selector): when the cache has no lights, the error says
 * so instead of guessing.
 */
export function resolveNamedLightsLive(
  live: FoundryLive,
  sceneId: string,
  query: string,
): NamedLightGroup {
  return resolveNamedLights(resolveSceneLights(live, sceneId), query);
}

/**
 * Animate every light in a named group to the target, in parallel
 * (one fade per light — a sequential fade across the braziers would
 * read as a wave, not one change). Each light starts from its own
 * current state. Returns the resolved name and the per-light results.
 */
export async function animateNamedLights(
  live: FoundryLive,
  sceneId: string,
  query: string,
  target: Partial<LightState>,
  opts: NamedLightPlanOptions = {},
): Promise<{ name: string; results: { lightId: string; final: LightState }[] }> {
  const lights = resolveSceneLights(live, sceneId);
  const plan = namedLightPlan(lights, query, target, opts);
  const results = await Promise.all(
    plan.targets.map((t) =>
      animateLight(
        live,
        sceneId,
        { id: t.lightId },
        t.to,
        { durationMs: t.durationMs, steps: t.steps, from: t.from },
      ),
    ),
  );
  return { name: plan.name, results };
}
