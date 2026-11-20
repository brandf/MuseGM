/**
 * Token movement (P1) — smooth stepped movement plus the resolve/place/
 * delete helpers the CLIs and the sequence runner build on.
 *
 * Everything here reads CURRENT scene state at call time: the scene can
 * change under you (tokens placed, replaced, or deleted by the GM or
 * another agent), so a token _id or position captured in an earlier probe
 * is never trusted. `resolveToken` / `moveTokenTo` re-read the scene's
 * token list from the live cache first, and throw a clear error when the
 * token is gone.
 *
 * Native animation note (from the Foundry 14 client bundle): a single
 * Token position update already animates on clients — the `animate`
 * update option defaults to true — so a short hop glides without any
 * stepping. Stepped movement is for the cases a single update does not
 * cover: long paths (a fixed-duration glide looks wrong over 2000px),
 * controlled speed (px/s, so a 25ft move takes the time a 25ft move
 * should), and waypoint pacing inside a sequence. Each step is its own
 * Token update, awaited, so the token never outruns the server.
 */
import type { FoundryLive } from "../live.js";

export interface SceneToken {
  _id: string;
  name: string;
  x: number;
  y: number;
  actorId?: string;
  width?: number;
  height?: number;
}

export interface MoveResult {
  tokenId: string;
  name: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  steps: number;
  durationMs: number;
}

type RawScene = {
  _id: string;
  name?: string;
  active?: boolean;
  tokens?: SceneToken[];
};

function scenesOf(live: FoundryLive): RawScene[] {
  const data = live.raw().getWorldData() as unknown as { scenes?: RawScene[] } | null;
  return data?.scenes ?? [];
}

/** Resolve a scene by _id or by name (case-insensitive) from current state. */
export function resolveScene(live: FoundryLive, sceneIdOrName: string): RawScene {
  const scenes = scenesOf(live);
  const byId = scenes.find((s) => s._id === sceneIdOrName);
  if (byId) return byId;
  const byName = scenes.find((s) => s.name?.toLowerCase() === sceneIdOrName.toLowerCase());
  if (byName) return byName;
  throw new Error(
    `Scene not found: ${sceneIdOrName} (scenes now: ${scenes.map((s) => s.name ?? s._id).join(", ")})`,
  );
}

/** All tokens on a scene, from current state. */
export function getSceneTokens(live: FoundryLive, sceneId: string): SceneToken[] {
  const scene = resolveScene(live, sceneId);
  return scene.tokens ?? [];
}

/**
 * Resolve a token on a scene by _id or by name (case-insensitive) from
 * current state. Throws when the token is not on the scene right now.
 */
export function resolveToken(
  live: FoundryLive,
  sceneId: string,
  tokenIdOrName: string,
): SceneToken {
  const tokens = getSceneTokens(live, sceneId);
  const byId = tokens.find((t) => t._id === tokenIdOrName);
  if (byId) return byId;
  const byName = tokens.find((t) => t.name?.toLowerCase() === tokenIdOrName.toLowerCase());
  if (byName) return byName;
  throw new Error(
    `Token not found on scene ${sceneId}: ${tokenIdOrName} (tokens now: ${tokens.map((t) => t.name).join(", ") || "none"})`,
  );
}

/** Place a token for an actor on a scene. Returns the token _id. */
export async function placeToken(
  live: FoundryLive,
  sceneId: string,
  actorId: string,
  x: number,
  y: number,
  opts: { name?: string; actorLink?: boolean; disposition?: number } = {},
): Promise<string> {
  const raw = live.raw() as unknown as {
    getRawActor(id: string): { name?: string; img?: string; prototypeToken?: { texture?: { src?: string } } } | undefined;
  };
  const actor = raw.getRawActor?.(actorId) ??
    ((await live.getActorDetails(actorId)) as { name?: string; img?: string; prototypeToken?: { texture?: { src?: string } } } | null);
  const name = opts.name ?? actor?.name ?? "Token";
  const created = await live.modifyDocument("Token", "create", {
    data: [{
      name,
      actorId,
      actorLink: opts.actorLink ?? true,
      x,
      y,
      width: 1,
      height: 1,
      texture: { src: actor?.prototypeToken?.texture?.src ?? actor?.img ?? "icons/svg/mystery-man.svg" },
      disposition: opts.disposition ?? 0,
    }],
    parentUuid: `Scene.${resolveScene(live, sceneId)._id}`,
  });
  const id = String(created[0]?._id ?? "");
  if (!id) throw new Error("Token create returned no _id.");
  return id;
}

/** Delete a token from a scene. */
export async function deleteToken(
  live: FoundryLive,
  sceneId: string,
  tokenId: string,
): Promise<void> {
  await live.modifyDocument("Token", "delete", {
    ids: [tokenId],
    parentUuid: `Scene.${resolveScene(live, sceneId)._id}`,
  });
}

/**
 * A token reference: a name/_id string, or a descriptor from a create
 * response (placeToken) with the position it was just created at.
 *
 * The descriptor matters because of the cache lag: a connection never sees
 * its OWN creates in its worldData cache, so a token this process just
 * placed is invisible to resolveToken. When the cache has the token, the
 * cache wins (current state beats any hint); when it does not, and the
 * caller hands us the create-time position, that is the authority — the
 * server accepted the create. A bare string with no cache hit still throws.
 */
export type TokenRef = string | { id: string; name?: string; x?: number; y?: number };

function tokenRefParts(token: TokenRef): { idOrName: string; fallback?: { id: string; name: string; x: number; y: number } } {
  if (typeof token === "string") return { idOrName: token };
  const fallback =
    token.x !== undefined && token.y !== undefined
      ? { id: token.id, name: token.name ?? token.id, x: token.x, y: token.y }
      : undefined;
  return { idOrName: token.id, fallback };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolve a token for movement: cache first (current state), descriptor
 * fallback for a token this process just created (invisible in our cache).
 */
function resolveForMove(
  live: FoundryLive,
  sceneId: string,
  token: TokenRef,
): SceneToken {
  const { idOrName, fallback } = tokenRefParts(token);
  try {
    return resolveToken(live, sceneId, idOrName);
  } catch (err) {
    if (fallback) {
      return { _id: fallback.id, name: fallback.name, x: fallback.x, y: fallback.y };
    }
    throw err;
  }
}

/**
 * Glide a token to (x, y) in small steps.
 *
 * The token's CURRENT position is read from live scene state at call time
 * — never a position captured earlier. Steps are `stepPx` apart (default
 * 50, one grid square) and paced so the token travels at `speed` px/s
 * (default 250 — 25ft, five squares, per second). Each step awaits its
 * Token update before the next is sent. A zero-distance move is a no-op.
 */
export async function moveTokenTo(
  live: FoundryLive,
  sceneId: string,
  token: TokenRef,
  x: number,
  y: number,
  opts: { speed?: number; stepPx?: number } = {},
): Promise<MoveResult> {
  const scene = resolveScene(live, sceneId);
  const resolved = resolveForMove(live, scene._id, token);
  const from = { x: resolved.x, y: resolved.y };
  const dx = x - from.x;
  const dy = y - from.y;
  const distance = Math.hypot(dx, dy);
  const speed = opts.speed ?? 250;
  const stepPx = opts.stepPx ?? 50;
  const started = Date.now();

  if (distance < 1) {
    return { tokenId: resolved._id, name: resolved.name, from, to: { x, y }, steps: 0, durationMs: 0 };
  }

  const steps = Math.max(1, Math.ceil(distance / stepPx));
  const stepMs = Math.max(40, (stepPx / speed) * 1000);
  for (let i = 1; i <= steps; i++) {
    const nx = Math.round(from.x + (dx * i) / steps);
    const ny = Math.round(from.y + (dy * i) / steps);
    await live.modifyDocument("Token", "update", {
      updates: [{ _id: resolved._id, x: nx, y: ny }],
      parentUuid: `Scene.${scene._id}`,
    });
    if (i < steps) await sleep(stepMs);
  }
  return {
    tokenId: resolved._id,
    name: resolved.name,
    from,
    to: { x, y },
    steps,
    durationMs: Date.now() - started,
  };
}
