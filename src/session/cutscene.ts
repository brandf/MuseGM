/**
 * Cutscene script engine (FR-5) + scripted tile swaps (FR-13).
 *
 * This is NOT canned responses. The shape is: Muse authors a small
 * declarative script (JSON) — the decisions only: which tokens, where
 * roughly, in what order, what it should feel like. The engine plays
 * it on a timed timeline — hundreds of placements, movements, facings,
 * light changes, prop drops — with no further tokens and no round-trip
 * per step. The script is compact; Muse's tokens go to the creative
 * calls, never to enumerating placements (a ring of 9 is one intent,
 * expanded by code).
 *
 * A cutscene script is a versioned JSON object:
 *   { version: 1, name, sceneId?, steps: [...] }
 * Steps are SequenceSteps plus one intent step, `formation`, which
 * expands at play time into concrete place/move/face/prop steps.
 * `sceneId` at the top level is the default for steps that omit it.
 *
 * Validation is strict and loud: an unknown step kind, a missing
 * target, or a bad timing value is a clear error listing everything
 * wrong — never a silent skip. The script either plays whole or
 * refuses to start.
 */
import type { FoundryLive } from "../live.js";
import type { SequenceStep } from "./sequence.js";
import { runSequence } from "./sequence.js";
import type { RunSequenceOptions, SequenceResult } from "./sequence.js";
import { ringPositions, linePositions, wedgePositions } from "./formations.js";
import type { Point } from "./formations.js";
import { resolveToken } from "./movement.js";

export interface FormationStep {
  kind: "formation";
  shape: "ring" | "line" | "wedge";
  count: number;
  actor: string;
  /** Ring center, or the token to surround (resolved at play time). */
  center?: Point | { token: string };
  /** Line endpoints (shape "line"). */
  from?: Point;
  to?: Point;
  /** Wedge apex + facing (shape "wedge"). */
  apex?: Point;
  directionDeg?: number;
  spreadDeg?: number;
  spacing?: number;
  radius?: number;
  /** Place each member here first, then glide to its formation spot. */
  enterFrom?: Point;
  speed?: number;
  /** Pause between members entering (ms). Default 0. */
  staggerMs?: number;
  namePrefix?: string;
  /** A prop tile placed at each member, rotated to face the focus. */
  prop?: { src: string; width?: number; height?: number };
  sceneId?: string;
}

export type CutsceneStep = SequenceStep | FormationStep;

export interface CutsceneScript {
  version: 1;
  name: string;
  sceneId?: string;
  steps: CutsceneStep[];
  [key: string]: unknown; // top-level metadata (notes, author) is ignored
}

const SEQUENCE_KINDS = new Set([
  "place", "deleteToken", "move", "pause", "chat", "roll", "damage", "heal", "effect",
  "ping", "cursor", "waitChat", "face", "light", "prop", "reveal", "wait", "swapTile",
]);

const STEP_FIELDS: Record<string, Set<string>> = {
  place: new Set(["kind", "sceneId", "actor", "x", "y", "name", "key", "note"]),
  deleteToken: new Set(["kind", "sceneId", "token", "note"]),
  move: new Set(["kind", "sceneId", "token", "x", "y", "speed", "stepPx", "note"]),
  pause: new Set(["kind", "ms", "note"]),
  chat: new Set(["kind", "content", "alias", "dedupeKey", "note"]),
  roll: new Set(["kind", "formula", "flavor", "showInChat", "seed", "note"]),
  damage: new Set(["kind", "actorId", "amount", "expectHp", "note"]),
  heal: new Set(["kind", "actorId", "amount", "expectHp", "note"]),
  effect: new Set(["kind", "actorId", "statusId", "name", "note"]),
  ping: new Set(["kind", "x", "y", "sceneId", "style", "pull", "note"]),
  cursor: new Set(["kind", "x", "y", "sceneId", "note"]),
  waitChat: new Set(["kind", "timeout", "debounce", "note"]),
  face: new Set(["kind", "sceneId", "token", "x", "y", "towardToken", "rotation", "note"]),
  light: new Set(["kind", "sceneId", "light", "dim", "bright", "color", "alpha", "durationMs", "steps", "from", "note"]),
  prop: new Set(["kind", "sceneId", "src", "x", "y", "width", "height", "rotation", "elevation", "sort", "alpha", "hidden", "key", "note"]),
  reveal: new Set(["kind", "what", "id", "sceneId", "note"]),
  wait: new Set(["kind", "timeout", "debounce", "match", "note"]),
  swapTile: new Set(["kind", "sceneId", "tile", "cell", "to", "note"]),
  formation: new Set(["kind", "shape", "count", "actor", "center", "from", "to", "apex", "directionDeg", "spreadDeg", "spacing", "radius", "enterFrom", "speed", "staggerMs", "namePrefix", "prop", "sceneId", "note"]),
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPoint(v: unknown): v is Point {
  return (
    isRecord(v) &&
    typeof v.x === "number" &&
    Number.isFinite(v.x) &&
    typeof v.y === "number" &&
    Number.isFinite(v.y)
  );
}

function numField(
  errors: string[],
  step: Record<string, unknown>,
  i: number,
  field: string,
  opts: { min?: number; integer?: boolean; required?: boolean } = {},
): void {
  const v = step[field];
  if (v === undefined) {
    if (opts.required) errors.push(`Step ${i}: "${field}" is required.`);
    return;
  }
  if (typeof v !== "number" || !Number.isFinite(v)) {
    errors.push(`Step ${i}: "${field}" must be a finite number, got ${JSON.stringify(v)}.`);
    return;
  }
  if (opts.integer && !Number.isInteger(v)) {
    errors.push(`Step ${i}: "${field}" must be an integer, got ${v}.`);
  }
  if (opts.min !== undefined && v < opts.min) {
    errors.push(`Step ${i}: "${field}" must be >= ${opts.min}, got ${v}.`);
  }
}

function strField(
  errors: string[],
  step: Record<string, unknown>,
  i: number,
  field: string,
  required = false,
): void {
  const v = step[field];
  if (v === undefined) {
    if (required) errors.push(`Step ${i}: "${field}" is required.`);
    return;
  }
  if (typeof v !== "string" || v.length === 0) {
    errors.push(`Step ${i}: "${field}" must be a non-empty string.`);
  }
}

/**
 * Validate a cutscene script. Returns the typed script when valid, or
 * every error found (all of them, not just the first) when invalid.
 */
export function validateCutscene(
  input: unknown,
): { ok: true; script: CutsceneScript } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(input)) {
    return { ok: false, errors: ["Cutscene script must be a JSON object."] };
  }
  if (input.version !== 1) {
    errors.push(`"version" must be 1, got ${JSON.stringify(input.version)}.`);
  }
  if (typeof input.name !== "string" || input.name.length === 0) {
    errors.push(`"name" must be a non-empty string.`);
  }
  if (input.sceneId !== undefined && (typeof input.sceneId !== "string" || input.sceneId.length === 0)) {
    errors.push(`"sceneId" must be a non-empty string when present.`);
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    errors.push(`"steps" must be a non-empty array.`);
    return { ok: false, errors };
  }
  for (let i = 0; i < input.steps.length; i++) {
    const raw = input.steps[i];
    if (!isRecord(raw)) {
      errors.push(`Step ${i}: must be an object.`);
      continue;
    }
    const kind = raw.kind;
    if (typeof kind !== "string") {
      errors.push(`Step ${i}: "kind" must be a string.`);
      continue;
    }
    const fields = STEP_FIELDS[kind];
    if (!fields) {
      errors.push(
        `Step ${i}: unknown kind ${JSON.stringify(kind)} (known: ${[...SEQUENCE_KINDS, "formation"].sort().join(", ")}).`,
      );
      continue;
    }
    for (const key of Object.keys(raw)) {
      if (!fields.has(key)) errors.push(`Step ${i} (${kind}): unknown field "${key}".`);
    }
    switch (kind) {
      case "place":
        strField(errors, raw, i, "actor", true);
        numField(errors, raw, i, "x", { required: true });
        numField(errors, raw, i, "y", { required: true });
        break;
      case "deleteToken":
        strField(errors, raw, i, "token", true);
        break;
      case "move":
        strField(errors, raw, i, "token", true);
        numField(errors, raw, i, "x", { required: true });
        numField(errors, raw, i, "y", { required: true });
        numField(errors, raw, i, "speed", { min: 1 });
        numField(errors, raw, i, "stepPx", { min: 1 });
        break;
      case "pause":
        numField(errors, raw, i, "ms", { required: true, min: 0, integer: true });
        break;
      case "chat":
        strField(errors, raw, i, "content", true);
        break;
      case "roll":
        strField(errors, raw, i, "formula", true);
        break;
      case "damage":
      case "heal":
        strField(errors, raw, i, "actorId", true);
        numField(errors, raw, i, "amount", { required: true, min: 0 });
        break;
      case "effect":
        strField(errors, raw, i, "actorId", true);
        strField(errors, raw, i, "statusId", true);
        break;
      case "ping":
      case "cursor":
        numField(errors, raw, i, "x", { required: true });
        numField(errors, raw, i, "y", { required: true });
        break;
      case "waitChat":
      case "wait":
        numField(errors, raw, i, "timeout", { min: 1 });
        numField(errors, raw, i, "debounce", { min: 0 });
        break;
      case "face":
        strField(errors, raw, i, "token", true);
        if (raw.rotation !== undefined) {
          numField(errors, raw, i, "rotation", {});
        } else if (raw.towardToken !== undefined) {
          strField(errors, raw, i, "towardToken");
        } else {
          numField(errors, raw, i, "x", { required: true });
          numField(errors, raw, i, "y", { required: true });
        }
        break;
      case "light":
        if (!isRecord(raw.light) || (!("id" in raw.light) && !("at" in raw.light))) {
          errors.push(`Step ${i} (light): "light" must be {id} or {at: {x, y}}.`);
        } else if ("at" in raw.light && !isPoint(raw.light.at)) {
          errors.push(`Step ${i} (light): "light.at" must be {x, y}.`);
        } else if ("id" in raw.light && typeof raw.light.id !== "string") {
          errors.push(`Step ${i} (light): "light.id" must be a string.`);
        }
        numField(errors, raw, i, "dim", { min: 0 });
        numField(errors, raw, i, "bright", { min: 0 });
        if (raw.color !== undefined && (typeof raw.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(raw.color))) {
          errors.push(`Step ${i} (light): "color" must be #rrggbb, got ${JSON.stringify(raw.color)}.`);
        }
        numField(errors, raw, i, "alpha", { min: 0 });
        numField(errors, raw, i, "durationMs", { min: 1 });
        numField(errors, raw, i, "steps", { min: 1, integer: true });
        break;
      case "prop":
        strField(errors, raw, i, "src", true);
        numField(errors, raw, i, "x", { required: true });
        numField(errors, raw, i, "y", { required: true });
        numField(errors, raw, i, "width", { min: 1 });
        numField(errors, raw, i, "height", { min: 1 });
        numField(errors, raw, i, "rotation", {});
        numField(errors, raw, i, "elevation", {});
        numField(errors, raw, i, "sort", {});
        numField(errors, raw, i, "alpha", { min: 0 });
        break;
      case "reveal":
        if (raw.what !== "scene" && raw.what !== "tile" && raw.what !== "token" && raw.what !== "light") {
          errors.push(`Step ${i} (reveal): "what" must be scene|tile|token|light, got ${JSON.stringify(raw.what)}.`);
        }
        strField(errors, raw, i, "id", true);
        break;
      case "swapTile": {
        const hasTile = typeof raw.tile === "string" && raw.tile.length > 0;
        const hasCell = isPoint(raw.cell);
        if (hasTile && raw.cell !== undefined) {
          errors.push(`Step ${i} (swapTile): give exactly one of "tile" (id) or "cell" ({x, y}), not both.`);
        } else if (!hasTile && !hasCell) {
          errors.push(`Step ${i} (swapTile): give "tile" (the Tile _id) or "cell" ({x, y}) to identify the tile to swap.`);
        } else if (raw.cell !== undefined && !hasCell) {
          errors.push(`Step ${i} (swapTile): "cell" must be {x, y}.`);
        } else if (raw.tile !== undefined && !hasTile) {
          errors.push(`Step ${i} (swapTile): "tile" must be a non-empty string (the Tile _id).`);
        }
        strField(errors, raw, i, "to", true);
        break;
      }
      case "formation": {
        if (raw.shape !== "ring" && raw.shape !== "line" && raw.shape !== "wedge") {
          errors.push(`Step ${i} (formation): "shape" must be ring|line|wedge, got ${JSON.stringify(raw.shape)}.`);
          break;
        }
        strField(errors, raw, i, "actor", true);
        numField(errors, raw, i, "count", { required: true, min: 1, integer: true });
        if (raw.shape === "ring") {
          if (raw.center === undefined) {
            errors.push(`Step ${i} (formation): ring needs "center" ({x, y} or {token}).`);
          } else if (!isPoint(raw.center) && !(isRecord(raw.center) && typeof raw.center.token === "string")) {
            errors.push(`Step ${i} (formation): "center" must be {x, y} or {token}.`);
          }
          numField(errors, raw, i, "radius", { required: true, min: 1 });
        }
        if (raw.shape === "line") {
          if (!isPoint(raw.from)) errors.push(`Step ${i} (formation): line needs "from" ({x, y}).`);
          if (!isPoint(raw.to)) errors.push(`Step ${i} (formation): line needs "to" ({x, y}).`);
        }
        if (raw.shape === "wedge") {
          if (!isPoint(raw.apex)) errors.push(`Step ${i} (formation): wedge needs "apex" ({x, y}).`);
          numField(errors, raw, i, "directionDeg", { required: true });
          numField(errors, raw, i, "spreadDeg", { min: 1 });
          numField(errors, raw, i, "spacing", { min: 1 });
        }
        if (raw.enterFrom !== undefined && !isPoint(raw.enterFrom)) {
          errors.push(`Step ${i} (formation): "enterFrom" must be {x, y}.`);
        }
        numField(errors, raw, i, "speed", { min: 1 });
        numField(errors, raw, i, "staggerMs", { min: 0, integer: true });
        if (raw.prop !== undefined) {
          if (!isRecord(raw.prop) || typeof raw.prop.src !== "string" || raw.prop.src.length === 0) {
            errors.push(`Step ${i} (formation): "prop" must be {src, ...} with a non-empty src.`);
          }
        }
        break;
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, script: input as unknown as CutsceneScript };
}

export interface ExpandOptions {
  /**
   * Resolve a token name to its current position (for formation
   * centers given as {token}). The player passes a live resolver;
   * without one, token centers are an error at expansion time.
   */
  centerOf?: (token: string, sceneId: string) => Point;
}

/**
 * Expand a validated script into plain sequence steps: formation
 * intents become concrete place/move/face/prop steps, and the
 * top-level sceneId fills in for steps that omit it. Pure when every
 * formation center is coordinates; needs `centerOf` for token
 * centers. Formation placements are keyed
 * (`cutscene:<name>:<step#>-<member>`) so a re-run returns the
 * already-placed token instead of placing a second one.
 */
export function expandCutscene(
  script: CutsceneScript,
  opts: ExpandOptions = {},
): SequenceStep[] {
  const out: SequenceStep[] = [];
  const defaultSceneId = script.sceneId;
  for (let i = 0; i < script.steps.length; i++) {
    const step = script.steps[i];
    if (step.kind === "formation") {
      out.push(...expandFormation(script, step, i, opts.centerOf));
      continue;
    }
    const s = { ...step } as Record<string, unknown>;
    if (defaultSceneId && s.sceneId === undefined && STEP_FIELDS[step.kind].has("sceneId")) {
      s.sceneId = defaultSceneId;
    }
    delete (s as Record<string, unknown>).note;
    out.push(s as unknown as SequenceStep);
  }
  return out;
}

function expandFormation(
  script: CutsceneScript,
  step: FormationStep,
  index: number,
  centerOf?: ExpandOptions["centerOf"],
): SequenceStep[] {
  const sceneId = step.sceneId ?? script.sceneId;
  if (!sceneId) {
    throw new Error(`Formation step ${index}: no sceneId (set it on the step or the script).`);
  }
  let positions: { x: number; y: number; facingDeg: number }[];
  if (step.shape === "ring") {
    const c = step.center;
    if (!c) throw new Error(`Formation step ${index}: ring needs a center.`);
    let center: Point;
    if ("token" in c) {
      if (!centerOf) {
        throw new Error(
          `Formation step ${index}: center token "${c.token}" needs a live resolver — play through playCutscene, not expandCutscene alone.`,
        );
      }
      center = centerOf(c.token, sceneId);
    } else {
      center = c;
    }
    positions = ringPositions(step.count, center, step.radius ?? 100);
  } else if (step.shape === "line") {
    if (!step.from || !step.to) throw new Error(`Formation step ${index}: line needs from/to.`);
    positions = linePositions(step.count, step.from, step.to);
  } else {
    if (!step.apex) throw new Error(`Formation step ${index}: wedge needs an apex.`);
    positions = wedgePositions(step.count, step.apex, step.directionDeg ?? 0, {
      spreadDeg: step.spreadDeg,
      spacing: step.spacing,
    });
  }
  // Face steps use the position's facingDeg directly (exact for every
  // shape — a wedge member's facing is its direction, not a point).
  const out: SequenceStep[] = [];
  const staggerMs = step.staggerMs ?? 0;
  for (let n = 0; n < positions.length; n++) {
    const pos = positions[n];
    const name = `${step.namePrefix ?? step.actor} ${n + 1}`;
    const key = `cutscene:${script.name}:${index}-${n + 1}`;
    if (n > 0 && staggerMs > 0) out.push({ kind: "pause", ms: staggerMs });
    if (step.enterFrom) {
      out.push({
        kind: "place",
        sceneId,
        actor: step.actor,
        x: step.enterFrom.x,
        y: step.enterFrom.y,
        name,
        key,
      });
      out.push({
        kind: "move",
        sceneId,
        token: name,
        x: pos.x,
        y: pos.y,
        speed: step.speed,
      });
    } else {
      out.push({ kind: "place", sceneId, actor: step.actor, x: pos.x, y: pos.y, name, key });
    }
    out.push({ kind: "face", sceneId, token: name, rotation: pos.facingDeg });
    if (step.prop) {
      // Center the prop tile on the member (tokens are 100x100, so
      // the member's center is +50/+50 from its top-left), rotated
      // to the member's facing — the prop art points up (north) in
      // its tile, so rotation = facingDeg.
      const w = step.prop.width ?? 200;
      const h = step.prop.height ?? 200;
      out.push({
        kind: "prop",
        sceneId,
        src: step.prop.src,
        x: Math.round(pos.x + 50 - w / 2),
        y: Math.round(pos.y + 50 - h / 2),
        width: w,
        height: h,
        rotation: pos.facingDeg,
        key: `${key}:prop`,
      });
    }
  }
  return out;
}

export interface PlayCutsceneOptions extends RunSequenceOptions {
  /** Idempotency key for the whole run (passed through to runSequence). */
  runKey?: string;
}

export interface PlayCutsceneResult extends SequenceResult {
  name: string;
  expandedSteps: number;
}

/**
 * Play a cutscene script: validate (refuses to start on any error),
 * expand formations (token centers resolve against live scene state),
 * then run the timeline through runSequence. Returns the per-step log.
 */
export async function playCutscene(
  live: FoundryLive,
  input: unknown,
  opts: PlayCutsceneOptions = {},
): Promise<PlayCutsceneResult> {
  const validated = validateCutscene(input);
  if (!validated.ok) {
    throw new Error(`Invalid cutscene script:\n- ${validated.errors.join("\n- ")}`);
  }
  const script = validated.script;
  const centerOf = (token: string, sceneId: string): Point => {
    const found = resolveToken(live, sceneId, token);
    return { x: found.x, y: found.y };
  };
  const steps = expandCutscene(script, { centerOf });
  const result = await runSequence(live, steps, {
    continueOnError: opts.continueOnError,
    onStep: opts.onStep,
    runKey: opts.runKey,
  });
  return { ...result, name: script.name, expandedSteps: steps.length };
}
