/**
 * Idempotency helpers — retry-safe operations for the core.
 *
 * If a CLI command is interrupted and re-run (a crash mid-dispatch, a
 * retried invocation), the re-run must not double-apply. The mechanism
 * is a client-generated key carried in the document's `flags`
 * (`flags: { "foundry-live": { <field>: <key> } }`): before creating,
 * the writer scans current world state for a document already carrying
 * the key and returns it instead of creating a second one. Everything
 * here is pure — no Foundry, no I/O — so it unit-tests with no connection.
 *
 * Honest limits (do not paper over these):
 * - The check-then-create is NOT atomic. Two processes racing with the
 *   same key can both miss and both create. The window is tiny (one
 *   cache read + one socket round-trip) and the realistic hazard is a
 *   crash re-dispatch, which is strictly sequential, not concurrent —
 *   but a true concurrent double-send is still possible.
 * - The chat scan reads the last 50 messages (`getChatMessages(50)`).
 *   A deduped message that has scrolled past 50 newer messages is
 *   invisible to the check, and a re-run would post again. For crash
 *   re-dispatch (seconds later) the window is plenty; it is not a
 *   forever-guarantee.
 * - Flags must survive the round trip (create accepts them, the world
 *   payload returns them). Verified in the vendored client code
 *   (modifyDocument passes `operation` through; getChatMessages /
 *   getScenes return raw world-payload documents) — needs one live
 *   confirmation against a real Foundry 14 server.
 */

export const FLAG_SCOPE = "foundry-live";

/** Flag field names, one per document type. */
export const FLAG_FIELDS = {
  chatDedupe: "dedupeKey",
  sceneBuild: "buildKey",
  tokenPlace: "placeKey",
  combatEncounter: "encounterKey",
  chest: "chestKey",
  /** Per-embed key on a tile room's Tile/Wall/AmbientLight docs:
   *  `<buildKey>:tile|wall|light:<index>` (BRA-202). */
  tileRoom: "tileRoomKey",
} as const;

/** FNV-1a 32-bit hash of a string — deterministic seed input. */
export function hashStringToSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic RNG (mulberry32). Same algorithm as `rngFromSeed` in
 * session/loot.ts — duplicated here on purpose so this module stays
 * import-free (loot.ts is a live module; unifying them is a later
 * cleanup, not this change).
 */
export function rngFromSeed(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build a stable dedupe/build key from parts: "run-7:chat:3". */
export function dedupeKeyFor(...parts: (string | number)[]): string {
  return parts.map((p) => String(p)).join(":");
}

/** The `flags` payload that stores one key on a created document. */
export function flagValue(field: string, value: string): Record<string, unknown> {
  return { [FLAG_SCOPE]: { [field]: value } };
}

/**
 * Raw document shape, as far as flags are concerned. Deliberately no
 * index signature: a type with `[key: string]: unknown` is not assignable
 * from the concrete document types (SceneToken, ChatMessage, ...), which
 * breaks `findDocByFlag` callers. Only `flags` (and `_id`, which every
 * Foundry doc carries) is ever read here.
 */
export type FlaggedDoc = {
  _id?: string;
  flags?: Record<string, Record<string, unknown> | undefined> | null;
};

/** True when the document carries `flags["foundry-live"][field] === value`. */
export function docHasFlag(doc: FlaggedDoc, field: string, value: string): boolean {
  const scope = doc.flags?.[FLAG_SCOPE];
  return scope?.[field] === value;
}

/** First document in the list carrying the flag, or undefined. */
export function findDocByFlag<T extends FlaggedDoc>(
  docs: T[],
  field: string,
  value: string,
): T | undefined {
  return docs.find((d) => docHasFlag(d, field, value));
}

/** A normalized chat message, as far as dedupe is concerned. */
export interface DedupeMessage {
  id: string;
  author: string;
  flags?: Record<string, Record<string, unknown> | undefined> | null;
}

/**
 * True when this message is a previous send of the same deduped operation:
 * same author AND same dedupe key in its flags. Author must match so one
 * Muse's key can never claim another user's message.
 */
export function messageHasDedupeKey(
  msg: DedupeMessage,
  key: string,
  authorId?: string,
): boolean {
  if (authorId !== undefined && msg.author !== authorId) return false;
  return docHasFlag(msg, FLAG_FIELDS.chatDedupe, key);
}

/** Find a previous send of this deduped operation in a message list. */
export function findMessageByDedupeKey(
  messages: DedupeMessage[],
  key: string,
  authorId?: string,
): DedupeMessage | undefined {
  return messages.find((m) => messageHasDedupeKey(m, key, authorId));
}
