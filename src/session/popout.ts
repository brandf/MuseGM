/**
 * Reveal popout (BRA-236, FR-18 phase three) — the client-side half of
 * the image reveal.
 *
 * The vision-doc Act Four moment: "an image generated on the spot, from
 * this room and this corpse and this moment, fills the players' screens
 * before any stat block does. They see it first." The reveal step
 * already posts the image inline in chat; this module pops it up
 * full-screen on every connected client.
 *
 * Design — the three decisions, and why:
 *
 * 1. TRIGGER: a Foundry module socket message, `game.socket.emit(
 *    "module.meroki-reveal", payload)`, sent by the GM side (Muse, over
 *    the same MCP-client socket that already emits `userActivity`
 *    pings/cursors — see live.ts). This is Foundry's standard
 *    module-socket pattern, not a new transport: the server relays the
 *    message to every connected client, and the meroki-reveal client
 *    module (modules/meroki-reveal/) listens for it. No new server
 *    component, no polling, no document to watch.
 *
 *    The emit path lives here, not in live.ts: live.ts owns socket
 *    emission for pings/cursors and its rawSocket() is private, and
 *    live.ts is outside the reveal path. `emitPopout` reaches the
 *    socket the same way live.ts's own rawSocket() does
 *    (`live.raw()` cast to `{ socket }`), contained in this one file,
 *    and it never throws — a missing socket or a failed emit comes
 *    back as `{ emitted: false, reason }` so the reveal step can
 *    report it. If a public emit method is ever added to FoundryLive,
 *    this helper should call it instead.
 *
 *    Plain `emit`, not `volatile.emit`: a ping is fire-and-forget
 *    (a dropped ping is invisible), but a reveal is a deliberate GM
 *    moment — socket.io queues a plain emit until the transport is
 *    ready. And even if it never arrives, the chat image is the
 *    fallback (see 3).
 *
 * 2. SECOND REVEAL WHILE ONE IS OPEN: REPLACE. A reveal is "this
 *    moment" — the newest moment supersedes. Queueing would show a
 *    stale moment after the table has moved on, and a queue the GM
 *    cannot see is hidden state. The client module keeps at most one
 *    overlay; a new show swaps the image + caption in place. The GM
 *    closes the popout on every client with a `dismissReveal` step
 *    (or by sending a dismiss message); a player closing it locally
 *    only closes their own screen — a player can always get rid of a
 *    popout on their own screen, and the GM can always clear everyone
 *    else's.
 *
 *    No sender authentication on the socket message: Foundry's
 *    module-socket pattern does not attach a sender id, so the module
 *    validates the message shape and nothing else. In practice only
 *    Muse's tooling emits these, and the GM can dismiss anything
 *    that appears. A forged popout is an annoyance, not a data leak —
 *    it carries only an image URL and a caption.
 *
 * 3. DEGRADED PATH: the inline chat image. The reveal step ALWAYS
 *    posts the chat image first, then attempts the popout on top of
 *    it. A player without the meroki-reveal module installed/enabled
 *    has no socket listener, so nothing pops for them — they see the
 *    chat image, never nothing. A failed emit is reported in the step
 *    result (`popout: false` + the reason), never silently swallowed.
 *    A broken image URL in the module shows the caption plus a
 *    "see the chat log" line, and dismiss is always available — the
 *    overlay can never trap a player on a dead image.
 *
 * Pure except `emitPopout`, which needs the live connection. No
 * orchestration-framework references anywhere in this module.
 */
import type { FoundryLive } from "../live.js";

/** Client module id — must match modules/meroki-reveal/module.json. */
export const POPOUT_MODULE_ID = "meroki-reveal";

/** Socket event the client module listens on. */
export const POPOUT_SOCKET_EVENT = `module.${POPOUT_MODULE_ID}`;

export interface PopoutShowMessage {
  action: "show";
  /** Image URL — the same uploaded path the chat <img> uses. */
  image: string;
  /** Optional caption under the image. */
  caption?: string;
  /** Correlation id, so a dismiss can name this popout. */
  id: string;
}

export interface PopoutDismissMessage {
  action: "dismiss";
  /** Popout id to close; omitted = close whatever is open. */
  id?: string;
}

export type PopoutMessage = PopoutShowMessage | PopoutDismissMessage;

/** Correlation id for a popout. Unique per reveal; a re-run replaces. */
export function newPopoutId(): string {
  return `popout-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build a show message. Returns every validation error found — the
 * caller reports them, never swallows a failed popout.
 */
export function buildPopoutShow(
  image: unknown,
  caption?: unknown,
  id?: string,
): { ok: true; message: PopoutShowMessage } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof image !== "string" || image.length === 0) {
    errors.push(`popout (show): "image" must be a non-empty string (the uploaded image path).`);
  }
  if (caption !== undefined && typeof caption !== "string") {
    errors.push(`popout (show): "caption" must be a string.`);
  }
  if (id !== undefined && (typeof id !== "string" || id.length === 0)) {
    errors.push(`popout (show): "id" must be a non-empty string when present.`);
  }
  if (errors.length > 0) return { ok: false, errors };
  const message: PopoutShowMessage = {
    action: "show",
    image: image as string,
    id: id ?? newPopoutId(),
  };
  if (typeof caption === "string") message.caption = caption;
  return { ok: true, message };
}

/** Build a dismiss message. `id` omitted = close whatever is open. */
export function buildPopoutDismiss(id?: string): PopoutDismissMessage {
  return id === undefined ? { action: "dismiss" } : { action: "dismiss", id };
}

/**
 * Validate an incoming socket message (the client module's side of
 * the contract — same shape rules as the builders above). Returns
 * every error found; the module ignores invalid messages with a
 * console warning, never throws into Foundry's socket dispatch.
 */
export function validatePopoutMessage(
  value: unknown,
): { ok: true; message: PopoutMessage } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, errors: [`popout: message must be an object, got ${Array.isArray(value) ? "array" : typeof value}.`] };
  }
  const msg = value as Record<string, unknown>;
  if (msg.action === "show") {
    if (typeof msg.image !== "string" || msg.image.length === 0) {
      errors.push(`popout (show): "image" must be a non-empty string.`);
    }
    if (msg.caption !== undefined && typeof msg.caption !== "string") {
      errors.push(`popout (show): "caption" must be a string.`);
    }
    if (typeof msg.id !== "string" || msg.id.length === 0) {
      errors.push(`popout (show): "id" must be a non-empty string.`);
    }
  } else if (msg.action === "dismiss") {
    if (msg.id !== undefined && (typeof msg.id !== "string" || msg.id.length === 0)) {
      errors.push(`popout (dismiss): "id" must be a non-empty string when present.`);
    }
  } else {
    errors.push(`popout: "action" must be "show" or "dismiss", got ${JSON.stringify(msg.action)}.`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, message: msg as unknown as PopoutMessage };
}

type RawSocketLike = {
  emit(event: string, ...args: unknown[]): void;
};

/**
 * Emit a popout message on the MCP client's socket. Never throws:
 * a missing socket or a failed emit comes back as
 * `{ emitted: false, reason }` so the reveal step can report it —
 * and the inline chat image (posted first) is already the fallback.
 */
export function emitPopout(
  live: FoundryLive,
  message: PopoutMessage,
): { emitted: true } | { emitted: false; reason: string } {
  let socket: RawSocketLike | null = null;
  try {
    const raw = live.raw() as unknown as { socket?: RawSocketLike | null };
    socket = raw.socket ?? null;
  } catch (e) {
    return { emitted: false, reason: `Could not reach the socket: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!socket) {
    return { emitted: false, reason: "Socket is not connected — no popout was sent." };
  }
  try {
    socket.emit(POPOUT_SOCKET_EVENT, message);
  } catch (e) {
    return { emitted: false, reason: `Socket emit failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { emitted: true };
}
