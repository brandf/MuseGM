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
 */
import type { FoundryLive, PingStyle } from "../live.js";
import { moveTokenTo, placeToken, deleteToken } from "./movement.js";

export type SequenceStep =
  | { kind: "place"; sceneId: string; actor: string; x: number; y: number; name?: string }
  | { kind: "deleteToken"; sceneId: string; token: string }
  | { kind: "move"; sceneId: string; token: string; x: number; y: number; speed?: number; stepPx?: number }
  | { kind: "pause"; ms: number }
  | { kind: "chat"; content: string; alias?: string }
  | { kind: "roll"; formula: string; flavor?: string; showInChat?: boolean }
  | { kind: "damage"; actorId: string; amount: number }
  | { kind: "heal"; actorId: string; amount: number }
  | { kind: "effect"; actorId: string; statusId: string; name?: string }
  | { kind: "ping"; x: number; y: number; sceneId?: string; style?: PingStyle; pull?: boolean }
  | { kind: "cursor"; x: number; y: number; sceneId?: string }
  | { kind: "waitChat"; timeout?: number; debounce?: number };

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
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const KNOWN_KINDS = new Set([
  "place", "deleteToken", "move", "pause", "chat", "roll", "damage", "heal", "effect", "ping", "cursor", "waitChat",
]);

type RawActorAccess = {
  getRawActor(id: string): { system?: { attributes?: { hp?: { value?: number; max?: number } } } } | undefined;
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
          const tokenId = await placeToken(live, step.sceneId, actorId, step.x, step.y, {
            name: step.name,
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
        case "chat":
          result.result = { id: await live.sendChat(step.content, { alias: step.alias }) };
          break;
        case "roll": {
          const roll = await live.rollDice(step.formula, {
            flavor: step.flavor,
            showInChat: step.showInChat,
          });
          result.result = { formula: roll.formula, total: roll.total, breakdown: roll.breakdown };
          break;
        }
        case "damage": {
          const raw = live.raw() as unknown as RawActorAccess;
          const { value } = await hpOf(live, step.actorId);
          const next = Math.max(0, value - step.amount);
          await raw.updateActorAttribute(step.actorId, { "attributes.hp.value": next });
          result.result = { actorId: step.actorId, hpBefore: value, hpAfter: next };
          break;
        }
        case "heal": {
          const raw = live.raw() as unknown as RawActorAccess;
          const { value, max } = await hpOf(live, step.actorId);
          const next = Math.min(max || value, value + step.amount);
          await raw.updateActorAttribute(step.actorId, { "attributes.hp.value": next });
          result.result = { actorId: step.actorId, hpBefore: value, hpAfter: next };
          break;
        }
        case "effect": {
          const raw = live.raw() as unknown as RawActorAccess;
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
