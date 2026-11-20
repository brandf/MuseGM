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
 * Honest limit: resolving a light by proximity, or reading its
 * current state as the animation's `from`, needs the scene's lights
 * in this connection's worldData cache. If the cache has no lights
 * (the vendored client may not track them), pass the light's _id and
 * explicit `from` values instead — the update itself works by _id
 * with no read.
 */
import type { FoundryLive } from "../live.js";

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
