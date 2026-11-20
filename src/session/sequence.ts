/**
 * Sequence runner (P1) — fire off a timed sequence of actions that plays
 * out on the code side, paced, with no round-trip to Muse per step.
 *
 * One call from Muse, then: move → pause → roll → apply effect → chat,
 * each step awaited in order. The runner returns a per-step log (what ran,
 * what each step returned, how long it took) so the caller can report or
 * react without having driven every step itself.
 *
 * Steps are plain JSON, so a sequence can be written in a file and handed
 * to `bun run src/cli/sequence.ts --file seq.json`, or built by code.
 * Token and actor ids are resolved at RUN time, against current scene
 * state — a sequence written ten minutes ago does not trust ten-minute-old
 * positions (see src/session/movement.ts).
 *
 * Retry-safety: `runSequence(live, steps, { runKey })` makes the run
 * re-runnable. Each effectful step derives a key from the run key
 * (`<runKey>:<kind>:<index>`) — place steps store it in the token's
 * flags, chat steps dedupe by it, roll steps are seeded by it, damage /
 * heal steps compare-and-set on `expectHp`. A crash re-dispatch of the
 * whole sequence reproduces the original run instead of double-applying
 * it. Without a run key, behavior is unchanged (every step applies fresh).
 */
import type { FoundryLive, PingStyle } from "../live.js";
import { moveTokenTo, placeToken, deleteToken, resolveToken, resolveScene } from "./movement.js";
import { postVisibleRoll } from "./dice.js";
import { dedupeKeyFor } from "../idempotency.js";
import { animateLight } from "./lights.js";
import type { LightSelector, LightState } from "./lights.js";
import { angleToFace } from "./formations.js";
import { FLAG_SCOPE } from "../idempotency.js";
import { swapTileTexture } from "./tile-ops.js";

export type SequenceStep =
  | { kind: "place"; sceneId: string; actor: string; x: number; y: number; name?: string; key?: string }
  | { kind: "deleteToken"; sceneId: string; token: string }
  | { kind: "move"; sceneId: string; token: string; x: number; y: number; speed?: number; stepPx?: number }
  | { kind: "pause"; ms: number }
  | { kind: "chat"; content: string; alias?: string; dedupeKey?: string }
  | { kind: "roll"; formula: string; flavor?: string; showInChat?: boolean; seed?: string }
  | { kind: "damage"; actorId: string; amount: number; expectHp?: number }
  | { kind: "heal"; actorId: string; amount: number; expectHp?: number }
  | { kind: "effect"; actorId: string; statusId: string; name?: string }
  | { kind: "ping"; x: number; y: number; sceneId?: string; style?: PingStyle; pull?: boolean }
  | { kind: "cursor"; x: number; y: number; sceneId?: string }
  | { kind: "waitChat"; timeout?: number; debounce?: number }
  | { kind: "face"; sceneId: string; token: string; x?: number; y?: number; towardToken?: string; rotation?: number }
  | { kind: "light"; sceneId: string; light: LightSelector; dim?: number; bright?: number; color?: string; alpha?: number; durationMs?: number; steps?: number; from?: Partial<LightState> }
  | { kind: "prop"; sceneId: string; src: string; x: number; y: number; width?: number; height?: number; rotation?: number; elevation?: number; sort?: number; alpha?: number; hidden?: boolean; key?: string }
  | { kind: "reveal"; what: "scene" | "tile" | "token" | "light"; id: string; sceneId?: string }
  | { kind: "wait"; timeout?: number; debounce?: number; match?: string }
  | { kind: "swapTile"; sceneId: string; tile?: string; cell?: { x: number; y: number }; to: string };

export interface StepResult {
  index: number;
  kind: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}

export interface SequenceResult {
  steps: StepResult[];
  ok: boolean;
  durationMs: number;
}

export interface RunSequenceOptions {
  /** Keep going after a failed step instead of stopping. Default false. */
  continueOnError?: boolean;
  /** Called after each step completes (or fails). */
  onStep?: (result: StepResult) => void;
  /**
   * Idempotency key for the whole run. Each effectful step derives a
   * per-step key (`<runKey>:<kind>:<index>`), so a crash re-dispatch of
   * the sequence reproduces it instead of double-applying it. Without
   * it, every step applies fresh, as before.
   */
  runKey?: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const KNOWN_KINDS = new Set([
  "place", "deleteToken", "move", "pause", "chat", "roll", "damage", "heal", "effect", "ping", "cursor", "waitChat",
  "face", "light", "prop", "reveal", "wait", "swapTile",
]);

type RawActorAccess = {
  getRawActor(id: string): {
    system?: { attributes?: { hp?: { value?: number; max?: number } } };
    effects?: { _id: string; name?: string; statuses?: string[] | unknown }[];
  } | undefined;
  updateActorAttribute(actorId: string, patch: Record<string, number>): Promise<unknown>;
  createActorStatusEffect(parentActorUuid: string, statusId: string, options?: { name?: string }): Promise<{ _id: string }>;
};

async function hpOf(live: FoundryLive, actorId: string): Promise<{ value: number; max: number }> {
  const raw = live.raw() as unknown as RawActorAccess;
  const actor = raw.getRawActor?.(actorId);
  const hp = actor?.system?.attributes?.hp;
  return { value: hp?.value ?? 0, max: hp?.max ?? 0 };
}

/** Run a sequence of steps in order, paced, one call. Returns the per-step log. */
export async function runSequence(
  live: FoundryLive,
  steps: SequenceStep[],
  opts: RunSequenceOptions = {},
): Promise<SequenceResult> {
  // Validate up front: an unknown step kind fails before anything runs.
  for (let i = 0; i < steps.length; i++) {
    if (!steps[i] || !KNOWN_KINDS.has((steps[i] as { kind?: string }).kind ?? "")) {
      throw new Error(`Step ${i}: unknown kind ${JSON.stringify((steps[i] as { kind?: unknown } | null)?.kind)}`);
    }
  }

  const started = Date.now();
  const results: StepResult[] = [];
  let ok = true;
  // Tokens this run placed, by token name and by _id: their create-time
  // position is the authority for a later move, because our own creates
  // are invisible in this connection's cache (see movement.ts TokenRef).
  const placed = new Map<string, { id: string; name: string; x: number; y: number }>();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepStarted = Date.now();
    const result: StepResult = { index: i, kind: step.kind, ok: true, durationMs: 0 };
    try {
      switch (step.kind) {
        case "place": {
          // Actor by _id or by exact name, resolved at run time.
          let actorId = step.actor;
          const found = (await live.searchActors(step.actor)) as {
            actors?: { _id: string; name: string }[];
          };
          const exact = (found.actors ?? []).find(
            (a) => a.name.toLowerCase() === step.actor.toLowerCase(),
          );
          if (exact) actorId = exact._id;
          else if (!step.actor.match(/^[A-Za-z0-9]{16}$/) && !(found.actors ?? []).length) {
            throw new Error(`Actor not found: "${step.actor}".`);
          }
          const key =
            step.key ?? (opts.runKey ? dedupeKeyFor(opts.runKey, "place", i) : undefined);
          const tokenId = await placeToken(live, step.sceneId, actorId, step.x, step.y, {
            name: step.name,
            key,
          });
          const tokenName = step.name ?? exact?.name ?? step.actor;
          const placedRef = { id: tokenId, name: tokenName, x: step.x, y: step.y };
          placed.set(tokenName, placedRef);
          placed.set(tokenId, placedRef);
          result.result = { tokenId, name: tokenName };
          break;
        }
        case "deleteToken":
          await deleteToken(live, step.sceneId, placed.get(step.token)?.id ?? step.token);
          result.result = { token: step.token };
          break;
        case "move": {
          const ref = placed.get(step.token) ?? step.token;
          const moved = await moveTokenTo(live, step.sceneId, ref, step.x, step.y, {
            speed: step.speed,
            stepPx: step.stepPx,
          });
          // Keep the placed record current: our own moves are invisible in
          // this connection's cache too, so the next move in this run must
          // start from where this one ended, not from the create position.
          const placedRef = placed.get(step.token);
          if (placedRef) {
            placedRef.x = step.x;
            placedRef.y = step.y;
          }
          result.result = moved;
          break;
        }
        case "pause":
          await sleep(step.ms);
          result.result = { ms: step.ms };
          break;
        case "chat": {
          const key =
            step.dedupeKey ?? (opts.runKey ? dedupeKeyFor(opts.runKey, "chat", i) : undefined);
          if (key) {
            const sent = await live.sendChatIdempotent(step.content, {
              alias: step.alias,
              dedupeKey: key,
            });
            result.result = { id: sent.id, duplicate: sent.duplicate };
          } else {
            result.result = { id: await live.sendChat(step.content, { alias: step.alias }) };
          }
          break;
        }
        case "roll": {
          const key =
            step.seed ?? (opts.runKey ? dedupeKeyFor(opts.runKey, "roll", i) : undefined);
          const roll = await live.rollDice(step.formula, {
            flavor: step.flavor,
            seed: key,
          });
          if (step.showInChat) {
            await postVisibleRoll(live, roll, { flavor: step.flavor, dedupeKey: key });
          }
          result.result = { formula: roll.formula, total: roll.total, breakdown: roll.breakdown };
          break;
        }
        case "damage": {
          const raw = live.raw() as unknown as RawActorAccess;
          const { value } = await hpOf(live, step.actorId);
          if (step.expectHp !== undefined && value !== step.expectHp) {
            // Compare-and-set miss: the damage was already applied (or the
            // world moved on) — report the skip instead of subtracting twice.
            result.result = { actorId: step.actorId, hpBefore: value, hpAfter: value, skipped: true };
            break;
          }
          const next = Math.max(0, value - step.amount);
          await raw.updateActorAttribute(step.actorId, { "attributes.hp.value": next });
          result.result = { actorId: step.actorId, hpBefore: value, hpAfter: next };
          break;
        }
        case "heal": {
          const raw = live.raw() as unknown as RawActorAccess;
          const { value, max } = await hpOf(live, step.actorId);
          if (step.expectHp !== undefined && value !== step.expectHp) {
            result.result = { actorId: step.actorId, hpBefore: value, hpAfter: value, skipped: true };
            break;
          }
          const next = Math.min(max || value, value + step.amount);
          await raw.updateActorAttribute(step.actorId, { "attributes.hp.value": next });
          result.result = { actorId: step.actorId, hpBefore: value, hpAfter: next };
          break;
        }
        case "effect": {
          const raw = live.raw() as unknown as RawActorAccess;
          const actor = raw.getRawActor?.(step.actorId);
          const existing = (actor?.effects ?? []).find(
            (e) =>
              (Array.isArray(e.statuses) && e.statuses.includes(step.statusId)) ||
              e.name === step.statusId,
          );
          if (existing) {
            result.result = { effectId: existing._id, statusId: step.statusId, duplicate: true };
            break;
          }
          const effect = await raw.createActorStatusEffect(`Actor.${step.actorId}`, step.statusId, {
            name: step.name ?? step.statusId,
          });
          result.result = { effectId: effect._id, statusId: step.statusId };
          break;
        }
        case "ping":
          result.result = await live.ping(step.x, step.y, {
            sceneId: step.sceneId,
            style: step.style,
            pull: step.pull,
          });
          break;
        case "cursor":
          result.result = await live.moveCursor(step.x, step.y, { sceneId: step.sceneId });
          break;
        case "waitChat": {
          const waited = await live.waitForChat({
            timeout: step.timeout ?? 60,
            debounce: step.debounce ?? 3,
          });
          result.result = {
            timedOut: waited.timedOut,
            messages: waited.newMessages.map((m) => ({ id: m.id, author: m.author, content: m.content })),
          };
          break;
        }
        case "face": {
          // Resolve positions: this run's placed map first (current
          // positions — the move handler keeps it current), else the
          // live cache. A token this run placed is invisible in the
          // cache, so the map is the authority for it.
          const resolvePos = (token: string): { id: string; x: number; y: number } => {
            const ref = placed.get(token);
            if (ref) return { id: ref.id, x: ref.x, y: ref.y };
            const found = resolveToken(live, step.sceneId, token);
            return { id: found._id, x: found.x, y: found.y };
          };
          const from = resolvePos(step.token);
          let rotation: number;
          if (step.rotation !== undefined) {
            // Absolute rotation (formation expansion already computed it).
            rotation = step.rotation;
          } else {
            let target: { x: number; y: number };
            if (step.towardToken) {
              const t = resolvePos(step.towardToken);
              target = { x: t.x, y: t.y };
            } else if (step.x !== undefined && step.y !== undefined) {
              target = { x: step.x, y: step.y };
            } else {
              throw new Error("face step needs rotation, x/y, or towardToken.");
            }
            rotation = angleToFace(from, target);
          }
          const scene = resolveScene(live, step.sceneId);
          await live.modifyDocument("Token", "update", {
            updates: [{ _id: from.id, rotation }],
            parentUuid: `Scene.${scene._id}`,
          });
          result.result = { tokenId: from.id, rotation };
          break;
        }
        case "light": {
          result.result = await animateLight(
            live,
            step.sceneId,
            step.light,
            { dim: step.dim, bright: step.bright, color: step.color, alpha: step.alpha },
            { durationMs: step.durationMs, steps: step.steps, from: step.from },
          );
          break;
        }
        case "prop": {
          // A prop is a Tile document. Its `key`, when given, is stored
          // in flags so the prop is identifiable as a cutscene prop for
          // later cleanup — it does NOT dedupe a re-run, because the
          // Tile cache does not track tiles (see tile-ops.ts).
          const scene = resolveScene(live, step.sceneId);
          const doc: Record<string, unknown> = {
            texture: { src: step.src },
            x: step.x,
            y: step.y,
            width: step.width ?? 100,
            height: step.height ?? 100,
            elevation: step.elevation ?? 0,
            sort: step.sort ?? 0,
            rotation: step.rotation ?? 0,
            alpha: step.alpha ?? 1,
            hidden: step.hidden ?? false,
            locked: false,
          };
          if (step.key) doc.flags = { [FLAG_SCOPE]: { propKey: step.key } };
          const created = await live.modifyDocument("Tile", "create", {
            data: [doc],
            parentUuid: `Scene.${scene._id}`,
          });
          const tileId = String(created[0]?._id ?? "");
          if (!tileId) throw new Error("Tile create returned no _id.");
          result.result = { tileId };
          break;
        }
        case "reveal": {
          // Activating a scene switches the whole table's view to it —
          // the GM's call, and the reason reveal is a deliberate step,
          // not a side effect of building. Unhiding a tile/token/light
          // just makes that one document visible.
          if (step.what === "scene") {
            await live.modifyDocument("Scene", "update", {
              updates: [{ _id: step.id, navigation: true, active: true }],
            });
            result.result = { sceneId: step.id, active: true };
          } else {
            if (!step.sceneId) throw new Error(`reveal ${step.what} needs sceneId.`);
            const scene = resolveScene(live, step.sceneId);
            const type =
              step.what === "tile" ? "Tile" : step.what === "token" ? "Token" : "AmbientLight";
            await live.modifyDocument(type, "update", {
              updates: [{ _id: step.id, hidden: false }],
              parentUuid: `Scene.${scene._id}`,
            });
            result.result = { what: step.what, id: step.id, hidden: false };
          }
          break;
        }
        case "wait": {
          const waited = await live.waitForChat({
            timeout: step.timeout ?? 60,
            debounce: step.debounce ?? 3,
          });
          const messages = waited.newMessages.map((m) => ({
            id: m.id,
            author: m.author,
            content: m.content,
          }));
          const match = step.match;
          const matched =
            match !== undefined
              ? messages.some((m) => m.content.toLowerCase().includes(match.toLowerCase()))
              : undefined;
          result.result = { timedOut: waited.timedOut, matched, messages };
          break;
        }
        case "swapTile": {
          // FR-13: swap one tile's texture in place — the trap door
          // opens, the floor becomes a pit. An update is retry-safe
          // by nature (same texture twice is a no-op in effect).
          const target =
            step.tile !== undefined
              ? { tile: step.tile }
              : step.cell !== undefined
                ? { cell: step.cell }
                : null;
          if (!target) throw new Error("swapTile step needs tile (id) or cell ({x, y}).");
          result.result = await swapTileTexture(live, step.sceneId, target, step.to);
          break;
        }
      }
    } catch (err) {
      result.ok = false;
      result.error = err instanceof Error ? err.message : String(err);
      ok = false;
    }
    result.durationMs = Date.now() - stepStarted;
    results.push(result);
    opts.onStep?.(result);
    if (!result.ok && !opts.continueOnError) break;
  }

  return { steps: results, ok, durationMs: Date.now() - started };
}
