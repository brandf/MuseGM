/**
 * Stage-then-fire gate (BRA-231) — the GM approval gate for big moments.
 *
 * The doc (Act One): "Muse proposes, builds, and operates. The GM
 * decides. Nothing important happens because an AI felt like it." Act
 * Three (safety valves): "Nothing big is silent. Boss reveals,
 * character deaths, and story turns wait for the GM's nod. Muse
 * stages; the GM fires."
 *
 * The gate has two halves:
 * - STAGE (pure, this module): validate the whole script and resolve
 *   every reference it needs — actors, tokens, lights, tiles, walls,
 *   scenes — against a `WorldSnapshot`, WITHOUT playing anything.
 *   Every problem is listed up front, never just the first. A staged
 *   beat is invisible to the table: staging writes nothing, posts
 *   nothing, moves nothing. It only proves the beat *would* play.
 * - FIRE: `playStagedCutscene` plays a staged beat's expanded steps
 *   through the normal timeline player. Firing an unstaged script
 *   still works exactly as before — `playCutscene` validates and
 *   expands inline first, i.e. it stages implicitly, then plays.
 *   The gate adds a checkpoint; it does not change the player.
 *
 * A staged beat never fires on its own: the store below has no
 * timers, no watchers, no auto-fire — a beat plays only when the
 * caller explicitly fires it. The GM fires, edits, or drops a beat
 * in one message (the monitor routing for that is the follow-up;
 * this module is the mechanism, plus the CLI: --stage / --fire).
 *
 * What staging checks, and what it cannot:
 * - Checked: script shape (via validateCutscene — every error), every
 *   sceneId resolves, every actor exists (by _id or exact name),
 *   every token reference resolves (in the scene, or placed earlier
 *   in the same script), every light id / tile id / wall id exists,
 *   every cell address has a tile, every `at` point has a wall within
 *   150px (the same threshold the player uses) or a light to select.
 * - Warnings, not errors: `waitRound` when the snapshot carries no
 *   combat state (the step needs a live combat at fire time — the
 *   beat still stages, and the warning rides in the GM preview).
 * - Not checked: roll formula syntax (the dice roller validates it
 *   at fire time), prop image paths and reveal image URLs (files the
 *   snapshot cannot see), and anything the world does between staging
 *   and firing — staging is a pre-flight check, not a lock. A token
 *   that dies after staging still fails at fire time, on the first
 *   bad step, the same as an unstaged play.
 *
 * The snapshot contract: it must be the whole world the script can
 * touch — every actor, every scene with its tokens, lights, tiles,
 * and walls. An absent scene or actor is "not found", not "maybe".
 * `snapshotWorld` (live layer, below) builds one from a connection;
 * tests and the CLI build one from a JSON file.
 *
 * Pure except the two live functions at the bottom
 * (`snapshotWorld`, `playStagedCutscene`), which are thin wrappers
 * over the existing live readers and the timeline player.
 */
import type { FoundryLive } from "../live.js";
import { validateCutscene, expandCutscene } from "./cutscene.js";
import type { CutsceneScript } from "./cutscene.js";
import { runSequence } from "./sequence.js";
import type { SequenceStep, SequenceResult, RunSequenceOptions } from "./sequence.js";
import { findTileAtCell } from "./tile-ops.js";
import type { TileRef } from "./tile-ops.js";

// ---------------------------------------------------------------- snapshot

export interface SnapshotActor {
  id: string;
  name: string;
}

export interface SnapshotToken {
  id: string;
  name: string;
  x: number;
  y: number;
}

export interface SnapshotLight {
  id: string;
  x: number;
  y: number;
}

export interface SnapshotTile {
  id: string;
  x: number;
  y: number;
}

export interface SnapshotWall {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface SnapshotScene {
  id: string;
  name?: string;
  tokens: SnapshotToken[];
  lights: SnapshotLight[];
  tiles: SnapshotTile[];
  walls: SnapshotWall[];
}

/** The world a script is staged against. */
export interface WorldSnapshot {
  actors: SnapshotActor[];
  scenes: SnapshotScene[];
  /** Active combat, when one is running — needed to verify waitRound. */
  combat?: { round: number } | null;
}

export function emptySnapshot(): WorldSnapshot {
  return { actors: [], scenes: [] };
}

// ---------------------------------------------------------------- hashing

/** Canonical JSON: object keys sorted recursively, so the same script
 *  hashes the same way no matter how it was built or loaded. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(",")}}`;
}

/** Short content hash of a script: the id a staged beat carries, and
 *  the tripwire that catches a script edited after staging. */
export function scriptHash(script: CutsceneScript): string {
  const json = stableJson(script);
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------- staged beat

export interface StagedBeat {
  /** Deterministic: `staged-<name-slug>-<hash8>`. Same script, same id. */
  id: string;
  name: string;
  script: CutsceneScript;
  /** Expanded steps, ready to hand to runSequence — firing does not
   *  re-expand or re-resolve. */
  expandedSteps: SequenceStep[];
  stagedAt: string;
  scriptHash: string;
  /** Things that could not be verified from the snapshot (e.g.
   *  waitRound with no combat in it) — shown to the GM, not errors. */
  warnings: string[];
  /** One human-readable line per script step, for the GM preview. */
  preview: string[];
}

export type StageResult =
  | { ok: true; beat: StagedBeat }
  | { ok: false; errors: string[] };

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "beat"
  );
}

function findScene(world: WorldSnapshot, sceneIdOrName: string): SnapshotScene | undefined {
  const byId = world.scenes.find((s) => s.id === sceneIdOrName);
  if (byId) return byId;
  return world.scenes.find(
    (s) => s.name !== undefined && s.name.toLowerCase() === sceneIdOrName.toLowerCase(),
  );
}

function findActor(world: WorldSnapshot, actor: string): SnapshotActor | undefined {
  const byId = world.actors.find((a) => a.id === actor);
  if (byId) return byId;
  return world.actors.find((a) => a.name.toLowerCase() === actor.toLowerCase());
}

function pointSegDist(
  px: number, py: number,
  x1: number, y1: number, x2: number, y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** One-line GM preview of a script step. */
function previewStep(step: Record<string, unknown>, i: number): string {
  const kind = String(step.kind ?? "?");
  switch (kind) {
    case "chat": {
      const c = String(step.content ?? "");
      return `${i + 1}. say "${c.length > 80 ? `${c.slice(0, 77)}…` : c}"`;
    }
    case "place":
      return `${i + 1}. place ${String(step.actor ?? "?")} at (${step.x}, ${step.y})${step.name ? ` as "${step.name}"` : ""}`;
    case "move":
      return `${i + 1}. move ${String(step.token ?? "?")} to (${step.x}, ${step.y})`;
    case "deleteToken":
      return `${i + 1}. remove token ${String(step.token ?? "?")}`;
    case "formation":
      return `${i + 1}. ${String(step.shape ?? "?")} formation ×${step.count ?? "?"} ${String(step.actor ?? "?")}`;
    case "rush": {
      const tokens = Array.isArray(step.tokens) ? step.tokens : [];
      return `${i + 1}. rush ${tokens.length} ${String(tokens[0] ?? "tokens")} through the hall`;
    }
    case "emerge":
      return `${i + 1}. ${String(step.actor ?? "?")} emerges from ${String(step.fromToken ?? "?")}`;
    case "face":
      return `${i + 1}. ${String(step.token ?? "?")} faces ${step.rotation !== undefined ? `${step.rotation}°` : step.towardToken ? String(step.towardToken) : `(${step.x}, ${step.y})`}`;
    case "light": {
      const sel = step.light as Record<string, unknown> | undefined;
      const at = sel && "at" in sel ? `nearest light to (${(sel.at as { x: number; y: number }).x}, ${(sel.at as { x: number; y: number }).y})` : `light ${String(sel?.id ?? "?")}`;
      return `${i + 1}. light ${at}${step.dim !== undefined ? ` → dim ${step.dim}` : ""}${step.bright !== undefined ? ` / bright ${step.bright}` : ""}`;
    }
    case "lightsOut":
      return `${i + 1}. all lights out`;
    case "prop":
      return `${i + 1}. place prop ${String(step.src ?? "?")} at (${step.x}, ${step.y})`;
    case "reveal":
      return step.image !== undefined
        ? `${i + 1}. reveal image ${String(step.image)}`
        : `${i + 1}. reveal ${String(step.what ?? "?")} ${String(step.id ?? "?")}`;
    case "swapTile":
      return `${i + 1}. swap tile ${step.tile !== undefined ? String(step.tile) : `at (${(step.cell as { x: number; y: number }).x}, ${(step.cell as { x: number; y: number }).y})`} → ${String(step.to ?? "?")}`;
    case "breakWall":
      return `${i + 1}. smash the wall ${step.wallId !== undefined ? String(step.wallId) : `near (${(step.at as { x: number; y: number }).x}, ${(step.at as { x: number; y: number }).y})`}`;
    case "damage":
    case "heal":
      return `${i + 1}. ${kind} ${String(step.actorId ?? "?")} ${step.amount ?? "?"} hp`;
    case "effect":
      return `${i + 1}. give ${String(step.actorId ?? "?")} the ${String(step.statusId ?? "?")} effect`;
    case "roll":
      return `${i + 1}. roll ${String(step.formula ?? "?")}${step.flavor ? ` (${String(step.flavor)})` : ""}`;
    case "pause":
      return `${i + 1}. pause ${step.ms ?? "?"}ms`;
    case "wait":
    case "waitChat":
      return `${i + 1}. wait for the table`;
    case "waitRound":
      return `${i + 1}. wait until round ${step.round ?? "?"}${step.relative ? " (from now)" : ""}`;
    case "ping":
      return `${i + 1}. ping (${step.x}, ${step.y})`;
    case "cursor":
      return `${i + 1}. move the cursor to (${step.x}, ${step.y})`;
    default:
      return `${i + 1}. ${kind}`;
  }
}

/** Scene-carrying step kinds: a step of one of these kinds needs a
 *  scene (its own sceneId, or the script's default) that resolves.
 *  ping / cursor / waitRound are not listed: their sceneId is
 *  optional at run time (active scene / global combat), so a missing
 *  one is fine — but a present one must still resolve (checked
 *  below). A `reveal` of a scene carries the scene in `id`, not
 *  sceneId, so it is exempt from the sceneId requirement too. */
const SCENE_KINDS = new Set([
  "place", "deleteToken", "move", "face", "light", "prop", "swapTile",
  "lightsOut", "breakWall", "formation", "rush", "emerge",
]);

/**
 * Stage a cutscene script against a world snapshot: validate it, then
 * resolve every reference it needs, without playing anything.
 * Returns the staged beat (with the expanded steps, ready to fire),
 * or every problem found, in step order.
 */
export function stageCutscene(
  input: unknown,
  world: WorldSnapshot,
  opts: { stagedAt?: string } = {},
): StageResult {
  const validated = validateCutscene(input);
  if (!validated.ok) return { ok: false, errors: validated.errors };
  const script = validated.script;
  const errors: string[] = [];
  const warnings: string[] = [];

  // The script's default scene, when present, must resolve — it is
  // the beat's declared scene, and a typo there means the author is
  // staging against the wrong world even when no current step uses
  // it. Reported once here; the per-step loop below skips the same
  // failure for steps that inherit this default.
  const defaultSceneBad =
    script.sceneId !== undefined && !findScene(world, script.sceneId);
  if (defaultSceneBad) {
    errors.push(`Script sceneId not found: "${script.sceneId}".`);
  }

  const sceneOf = (stepSceneId: string | undefined): SnapshotScene | undefined => {
    const id = stepSceneId ?? script.sceneId;
    return id === undefined ? undefined : findScene(world, id);
  };

  // Scene resolution: every scene-carrying step needs a resolvable
  // scene; a `reveal` of a document also needs one (an image reveal
  // does not — it posts to chat — and a scene reveal carries the
  // scene in `id`). ping / cursor / waitRound carry an optional
  // sceneId: a present one must resolve, an absent one is fine.
  for (let i = 0; i < script.steps.length; i++) {
    const step = script.steps[i] as Record<string, unknown>;
    const kind = String(step.kind);
    const needsScene =
      SCENE_KINDS.has(kind) ||
      (kind === "reveal" && step.image === undefined && step.what !== "scene");
    const sceneId = (step.sceneId as string | undefined) ?? script.sceneId;
    if (needsScene) {
      if (sceneId === undefined) {
        errors.push(
          `Step ${i} (${kind}): no sceneId (set it on the step or the script).`,
        );
      } else if (!findScene(world, sceneId)) {
        // The script default's failure is already reported once above.
        if (!(sceneId === script.sceneId && defaultSceneBad)) {
          errors.push(`Step ${i} (${kind}): scene not found: "${sceneId}".`);
        }
      }
    } else if (
      (kind === "ping" || kind === "cursor" || kind === "waitRound") &&
      step.sceneId !== undefined &&
      !findScene(world, step.sceneId as string)
    ) {
      errors.push(`Step ${i} (${kind}): scene not found: "${step.sceneId as string}".`);
    }
  }

  // Token centers (formation rings, emerge corpses) resolve against
  // the snapshot before expansion — expansion throws without them.
  const centerOf = (token: string, sceneId: string): { x: number; y: number } => {
    const scene = findScene(world, sceneId);
    const found = scene?.tokens.find(
      (t) => t.id === token || t.name.toLowerCase() === token.toLowerCase(),
    );
    if (!found) {
      throw new Error(`Token not found on scene ${sceneId}: "${token}".`);
    }
    return { x: found.x, y: found.y };
  };
  for (let i = 0; i < script.steps.length; i++) {
    const step = script.steps[i] as Record<string, unknown>;
    const sceneId = (step.sceneId as string | undefined) ?? script.sceneId;
    if (sceneId === undefined) continue;
    if (step.kind === "formation") {
      const center = step.center as Record<string, unknown> | undefined;
      if (step.shape === "ring" && center && typeof center.token === "string") {
        try {
          centerOf(center.token, sceneId);
        } catch (err) {
          errors.push(`Step ${i} (formation): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    if (step.kind === "emerge") {
      const fromToken = step.fromToken as string | undefined;
      if (typeof fromToken === "string") {
        try {
          centerOf(fromToken, sceneId);
        } catch (err) {
          errors.push(`Step ${i} (emerge): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (typeof step.actor === "string" && !findActor(world, step.actor)) {
        errors.push(`Step ${i} (emerge): actor not found: "${step.actor}".`);
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  let expanded: SequenceStep[];
  try {
    expanded = expandCutscene(script, { centerOf });
  } catch (err) {
    return { ok: false, errors: [`Expansion failed: ${err instanceof Error ? err.message : String(err)}`] };
  }

  // Reference walk over the expanded steps. Tokens the script itself
  // places count as present from that step on (the player tracks the
  // same placed map at run time), per scene.
  const placedByScene = new Map<string, Map<string, string>>(); // sceneId -> name-lower -> name
  const placedName = (sceneId: string, name: string): void => {
    let m = placedByScene.get(sceneId);
    if (!m) {
      m = new Map();
      placedByScene.set(sceneId, m);
    }
    m.set(name.toLowerCase(), name);
  };
  const tokenPresent = (scene: SnapshotScene, token: string): boolean => {
    if (scene.tokens.some((t) => t.id === token || t.name.toLowerCase() === token.toLowerCase())) {
      return true;
    }
    return placedByScene.get(scene.id)?.has(token.toLowerCase()) ?? false;
  };

  for (let i = 0; i < expanded.length; i++) {
    const step = expanded[i] as unknown as Record<string, unknown>;
    const kind = String(step.kind);
    const sceneId = step.sceneId as string | undefined;
    const scene = sceneId !== undefined ? findScene(world, sceneId) : undefined;
    // The scene check above already covered these; `scene` is only
    // undefined here for scene-less kinds.
    switch (kind) {
      case "place": {
        const actor = String(step.actor ?? "");
        const found = findActor(world, actor);
        if (!found) {
          errors.push(`Step ${i} (place): actor not found: "${actor}".`);
        } else if (scene) {
          placedName(scene.id, String(step.name ?? found.name ?? actor));
        }
        break;
      }
      case "move":
      case "deleteToken": {
        if (scene && !tokenPresent(scene, String(step.token ?? ""))) {
          errors.push(
            `Step ${i} (${kind}): token not found on scene ${sceneId}: "${String(step.token ?? "")}".`,
          );
        }
        break;
      }
      case "face": {
        if (scene) {
          if (!tokenPresent(scene, String(step.token ?? ""))) {
            errors.push(
              `Step ${i} (face): token not found on scene ${sceneId}: "${String(step.token ?? "")}".`,
            );
          }
          if (
            typeof step.towardToken === "string" &&
            !tokenPresent(scene, step.towardToken)
          ) {
            errors.push(
              `Step ${i} (face): token not found on scene ${sceneId}: "${step.towardToken}".`,
            );
          }
        }
        break;
      }
      case "damage":
      case "heal":
      case "effect": {
        const actorId = String(step.actorId ?? "");
        if (!world.actors.some((a) => a.id === actorId)) {
          errors.push(`Step ${i} (${kind}): actor not found: "${actorId}".`);
        }
        break;
      }
      case "light": {
        if (scene) {
          const sel = step.light as Record<string, unknown> | undefined;
          if (sel && typeof sel.id === "string") {
            if (!scene.lights.some((l) => l.id === sel.id)) {
              errors.push(
                `Step ${i} (light): light not found on scene ${sceneId}: "${sel.id}".`,
              );
            }
          } else if (sel && "at" in sel) {
            if (scene.lights.length === 0) {
              errors.push(
                `Step ${i} (light): scene ${sceneId} has no lights to select near (${(sel.at as { x: number; y: number }).x}, ${(sel.at as { x: number; y: number }).y}).`,
              );
            }
          }
        }
        break;
      }
      case "reveal": {
        if (step.image !== undefined) break; // image URL/path — unverifiable offline
        const what = String(step.what ?? "");
        const id = String(step.id ?? "");
        if (what === "scene") {
          if (!findScene(world, id)) {
            errors.push(`Step ${i} (reveal): scene not found: "${id}".`);
          }
        } else if (scene) {
          if (what === "tile" && !scene.tiles.some((t) => t.id === id)) {
            errors.push(`Step ${i} (reveal): tile not found on scene ${sceneId}: "${id}".`);
          }
          if (what === "token" && !tokenPresent(scene, id)) {
            errors.push(`Step ${i} (reveal): token not found on scene ${sceneId}: "${id}".`);
          }
          if (what === "light" && !scene.lights.some((l) => l.id === id)) {
            errors.push(`Step ${i} (reveal): light not found on scene ${sceneId}: "${id}".`);
          }
        }
        break;
      }
      case "swapTile": {
        if (scene) {
          if (typeof step.tile === "string") {
            if (!scene.tiles.some((t) => t.id === step.tile)) {
              errors.push(
                `Step ${i} (swapTile): tile not found on scene ${sceneId}: "${step.tile}".`,
              );
            }
          } else if (step.cell !== undefined) {
            const cell = step.cell as { x: number; y: number };
            const tiles = scene.tiles as unknown as TileRef[];
            if (!findTileAtCell(tiles, cell.x, cell.y)) {
              errors.push(
                `Step ${i} (swapTile): no tile at cell (${cell.x}, ${cell.y}) on scene ${sceneId}.`,
              );
            }
          }
        }
        break;
      }
      case "breakWall": {
        if (scene) {
          if (typeof step.wallId === "string") {
            if (!scene.walls.some((w) => w.id === step.wallId)) {
              errors.push(
                `Step ${i} (breakWall): wall not found on scene ${sceneId}: "${step.wallId}".`,
              );
            }
          } else if (step.at !== undefined) {
            const at = step.at as { x: number; y: number };
            const near = scene.walls.some(
              (w) => pointSegDist(at.x, at.y, w.x1, w.y1, w.x2, w.y2) <= 150,
            );
            if (!near) {
              errors.push(
                `Step ${i} (breakWall): no wall within 150px of (${at.x}, ${at.y}) on scene ${sceneId}.`,
              );
            }
          }
        }
        break;
      }
      case "waitRound": {
        if (world.combat === undefined || world.combat === null) {
          warnings.push(
            `Step ${i} (waitRound): no combat in the snapshot — the step needs an active combat at fire time.`,
          );
        }
        break;
      }
      default:
        break;
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const hash = scriptHash(script);
  const stagedAt = opts.stagedAt ?? new Date().toISOString();
  const preview = script.steps.map((s, i) => previewStep(s as unknown as Record<string, unknown>, i));
  const beat: StagedBeat = {
    id: `staged-${slug(script.name)}-${hash}`,
    name: script.name,
    script,
    expandedSteps: expanded,
    stagedAt,
    scriptHash: hash,
    warnings,
    preview,
  };
  return { ok: true, beat };
}

/** Shape check for a staged beat loaded from a file (CLI --fire, or a
 *  stored beat). Unknown fields are ignored; a bad shape is rejected
 *  with a plain message, never trusted. */
export function isStagedBeat(v: unknown): v is StagedBeat {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const b = v as Record<string, unknown>;
  return (
    typeof b.id === "string" &&
    b.id.length > 0 &&
    typeof b.name === "string" &&
    b.name.length > 0 &&
    typeof b.script === "object" &&
    b.script !== null &&
    Array.isArray(b.expandedSteps) &&
    typeof b.stagedAt === "string" &&
    typeof b.scriptHash === "string" &&
    Array.isArray(b.warnings) &&
    Array.isArray(b.preview)
  );
}

export function parseStagedBeat(v: unknown): StagedBeat {
  if (!isStagedBeat(v)) throw new Error("Not a staged beat (missing id/name/script/expandedSteps/stagedAt/scriptHash).");
  return v;
}

// ---------------------------------------------------------------- beat store

export interface BeatRecord {
  beat: StagedBeat;
  status: "staged" | "fired" | "dropped";
  /** Fired/dropped beats keep their history; staged ones are live. */
  updatedAt: string;
}

export interface BeatStore {
  version: 1;
  beats: Record<string, BeatRecord>;
}

export function emptyBeatStore(): BeatStore {
  return { version: 1, beats: {} };
}

/** Stage a beat into the store. Staging the same script twice is an
 *  idempotent no-op: the same id comes back with `duplicate: true`.
 *  A beat that was fired or dropped can be staged again (it replaces
 *  the old record). */
export function stageBeatInStore(
  store: BeatStore,
  beat: StagedBeat,
  opts: { at?: string } = {},
): { store: BeatStore; beat: StagedBeat; duplicate: boolean } {
  const existing = store.beats[beat.id];
  if (existing && existing.status === "staged") {
    return { store, beat: existing.beat, duplicate: true };
  }
  const next: BeatStore = {
    version: 1,
    beats: {
      ...store.beats,
      [beat.id]: { beat, status: "staged", updatedAt: opts.at ?? new Date().toISOString() },
    },
  };
  return { store: next, beat, duplicate: false };
}

/** Fire a staged beat: marks it fired and hands it back for the
 *  player. Anything but "staged" refuses — a fired beat never fires
 *  twice, a dropped beat never fires at all. */
export function fireBeat(
  store: BeatStore,
  id: string,
  opts: { at?: string } = {},
): { ok: true; store: BeatStore; beat: StagedBeat } | { ok: false; error: string } {
  const rec = store.beats[id];
  if (!rec) return { ok: false, error: `No staged beat "${id}".` };
  if (rec.status === "fired") return { ok: false, error: `Beat "${id}" already fired — it never fires twice.` };
  if (rec.status === "dropped") return { ok: false, error: `Beat "${id}" was dropped — re-stage it to fire it.` };
  const next: BeatStore = {
    version: 1,
    beats: {
      ...store.beats,
      [id]: { ...rec, status: "fired", updatedAt: opts.at ?? new Date().toISOString() },
    },
  };
  return { ok: true, store: next, beat: rec.beat };
}

/** Drop a staged beat. A fired beat stays fired (history is not
 *  rewritten); dropping a dropped beat is a no-op. */
export function dropBeat(
  store: BeatStore,
  id: string,
  opts: { at?: string } = {},
): { ok: true; store: BeatStore } | { ok: false; error: string } {
  const rec = store.beats[id];
  if (!rec) return { ok: false, error: `No staged beat "${id}".` };
  if (rec.status === "fired") return { ok: false, error: `Beat "${id}" already fired — it cannot be dropped.` };
  if (rec.status === "dropped") return { ok: true, store };
  const next: BeatStore = {
    version: 1,
    beats: {
      ...store.beats,
      [id]: { ...rec, status: "dropped", updatedAt: opts.at ?? new Date().toISOString() },
    },
  };
  return { ok: true, store: next };
}

/**
 * Edit a staged beat: re-stage the new script against the world. On
 * success the old beat is dropped and the new beat (new id — the id
 * is the script's hash) takes its place. On failure the old beat is
 * left exactly as it was, and the errors are returned.
 */
export function editBeat(
  store: BeatStore,
  id: string,
  input: unknown,
  world: WorldSnapshot,
  opts: { at?: string } = {},
): { ok: true; store: BeatStore; beat: StagedBeat } | { ok: false; errors: string[] } {
  const rec = store.beats[id];
  if (!rec) return { ok: false, errors: [`No staged beat "${id}".`] };
  if (rec.status !== "staged") {
    return { ok: false, errors: [`Beat "${id}" is ${rec.status} — only a staged beat can be edited.`] };
  }
  const staged = stageCutscene(input, world, { stagedAt: opts.at });
  if (!staged.ok) return { ok: false, errors: staged.errors };
  const dropped = dropBeat(store, id, opts);
  if (!dropped.ok) return { ok: false, errors: [dropped.error] };
  const added = stageBeatInStore(dropped.store, staged.beat, opts);
  return { ok: true, store: added.store, beat: added.beat };
}

/** All beats, insertion order — staged first, then fired, then dropped. */
export function listBeats(store: BeatStore): BeatRecord[] {
  const all = Object.values(store.beats);
  const rank = { staged: 0, fired: 1, dropped: 2 } as const;
  return [...all].sort((a, b) => rank[a.status] - rank[b.status]);
}

/** Serialize the store (for the monitor's state file, later). */
export function serializeBeatStore(store: BeatStore): string {
  return JSON.stringify(store);
}

/** Parse a stored beat store. Bad version, bad beats, or bad JSON
 *  are rejected with a plain message — never trusted. */
export function parseBeatStore(json: string): BeatStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`Beat store is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Beat store must be a JSON object.");
  }
  const s = parsed as Record<string, unknown>;
  if (s.version !== 1) throw new Error(`Beat store version must be 1, got ${JSON.stringify(s.version)}.`);
  if (!s.beats || typeof s.beats !== "object" || Array.isArray(s.beats)) {
    throw new Error("Beat store needs a \"beats\" object.");
  }
  const beats: Record<string, BeatRecord> = {};
  for (const [id, rec] of Object.entries(s.beats as Record<string, unknown>)) {
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
      throw new Error(`Beat store: beat "${id}" is not an object.`);
    }
    const r = rec as Record<string, unknown>;
    if (!isStagedBeat(r.beat)) throw new Error(`Beat store: beat "${id}" is not a staged beat.`);
    if (r.status !== "staged" && r.status !== "fired" && r.status !== "dropped") {
      throw new Error(`Beat store: beat "${id}" has bad status ${JSON.stringify(r.status)}.`);
    }
    if (typeof r.updatedAt !== "string") throw new Error(`Beat store: beat "${id}" needs updatedAt.`);
    beats[id] = { beat: r.beat, status: r.status, updatedAt: r.updatedAt };
  }
  return { version: 1, beats };
}

// ---------------------------------------------------------------- live layer

type RawWorldScene = {
  _id: string;
  name?: string;
  tokens?: { _id: string; name: string; x: number; y: number }[];
  lights?: { _id: string; x: number; y: number }[];
  tiles?: { _id: string; x: number; y: number }[];
  walls?: { _id?: string; c?: [number, number, number, number] }[];
  width?: number;
  height?: number;
};

type RawClient = {
  getWorldData(): { scenes?: RawWorldScene[]; actors?: { _id: string; name: string }[] } | null;
  getScenes(): RawWorldScene[];
  searchActors(params: { query: string; limit?: number }): Promise<{
    actors?: { _id: string; name: string }[];
  }>;
};

/**
 * Build the world snapshot a script is staged against, from a live
 * connection. Actors come from the search (empty query, large limit —
 * the default limit is 10); scenes, tokens, tiles, and lights come
 * from the world payload; walls come from getScenes, the same source
 * the breakWall step reads. Combat comes from the live combat state.
 */
export async function snapshotWorld(live: FoundryLive): Promise<WorldSnapshot> {
  const raw = live.raw() as unknown as RawClient;
  const [actorRes, world] = await Promise.all([
    raw.searchActors({ query: "", limit: 1000 }),
    Promise.resolve(raw.getWorldData()),
  ]);
  const scenes: SnapshotScene[] = (world?.scenes ?? []).map((s) => ({
    id: s._id,
    name: s.name,
    tokens: (s.tokens ?? []).map((t) => ({ id: t._id, name: t.name, x: t.x, y: t.y })),
    lights: (s.lights ?? []).map((l) => ({ id: l._id, x: l.x, y: l.y })),
    tiles: (s.tiles ?? []).map((t) => ({ id: t._id, x: t.x, y: t.y })),
    walls: (s.walls ?? [])
      .filter((w): w is { _id: string; c: [number, number, number, number] } =>
        typeof w._id === "string" && Array.isArray(w.c) && w.c.length === 4,
      )
      .map((w) => ({ id: w._id, x1: w.c[0], y1: w.c[1], x2: w.c[2], y2: w.c[3] })),
  }));
  // getScenes is the same cache the breakWall step reads — merge any
  // wall the world payload did not carry.
  try {
    for (const gs of raw.getScenes()) {
      const snap = scenes.find((s) => s.id === gs._id);
      if (!snap) continue;
      for (const w of gs.walls ?? []) {
        if (typeof w._id !== "string" || !Array.isArray(w.c) || w.c.length !== 4) continue;
        if (snap.walls.some((x) => x.id === w._id)) continue;
        snap.walls.push({ id: w._id, x1: w.c[0], y1: w.c[1], x2: w.c[2], y2: w.c[3] });
      }
    }
  } catch {
    // Walls already came from the payload; a missing getScenes is not fatal.
  }
  const combat = live.getCombatState() as { round?: number } | null;
  return {
    actors: (actorRes.actors ?? []).map((a) => ({ id: a._id, name: a.name })),
    scenes,
    combat: combat && typeof combat.round === "number" ? { round: combat.round } : null,
  };
}

export interface PlayStagedOptions extends RunSequenceOptions {
  /** Idempotency key for the whole run (passed through to runSequence). */
  runKey?: string;
}

export interface PlayStagedResult extends SequenceResult {
  name: string;
  beatId: string;
  expandedSteps: number;
}

/**
 * Fire a staged beat: play its expanded steps through the normal
 * timeline player. Refuses when the script no longer matches the
 * hash it was staged under — the script was edited after staging,
 * so re-stage it instead of playing a beat the GM never approved.
 * The world may still have moved since staging; a step that fails
 * now stops the run (unless continueOnError), exactly as an unstaged
 * play would.
 */
export async function playStagedCutscene(
  live: FoundryLive,
  beat: StagedBeat,
  opts: PlayStagedOptions = {},
): Promise<PlayStagedResult> {
  if (scriptHash(beat.script) !== beat.scriptHash) {
    throw new Error(
      `Staged beat "${beat.id}" was edited after staging — re-stage it before firing.`,
    );
  }
  const result = await runSequence(live, beat.expandedSteps, {
    continueOnError: opts.continueOnError,
    onStep: opts.onStep,
    runKey: opts.runKey,
  });
  return { ...result, name: beat.name, beatId: beat.id, expandedSteps: beat.expandedSteps.length };
}
