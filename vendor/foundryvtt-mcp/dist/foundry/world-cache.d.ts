/**
 * @fileoverview Applies FoundryVTT `modifyDocument` broadcasts to the cached world state.
 *
 * `worldData` is loaded once at connect time (ADR-004) and was, until #205, never
 * updated afterwards — so a write followed by a read returned pre-write data, and
 * changes made by other users (a player moving a token, the GM editing in the
 * Foundry UI) were invisible for the life of the connection.
 *
 * FoundryVTT broadcasts every accepted document mutation to connected clients on
 * the `modifyDocument` event. This module turns one such broadcast into an
 * in-place edit of the cached snapshot.
 *
 * **Idempotent by construction.** `create` upserts by `_id` rather than pushing,
 * and `delete` tolerates an id that is already gone. So it does not matter
 * whether FoundryVTT echoes a client's own writes back to it — applying the same
 * broadcast twice lands on the same state as applying it once.
 */
import type { WorldData } from './types.js';
/** A `modifyDocument` broadcast, once validated. */
export interface DocumentBroadcast {
    /** Document name — "Actor", "JournalEntry", "Token", … */
    type: string;
    action: 'create' | 'update' | 'delete';
    /** Created/updated document data, or deleted ids. */
    result: unknown[];
    /** Present for embedded documents: "Actor.<id>", "Scene.<id>", … */
    parentUuid?: string;
}
/**
 * Validates a raw socket payload as a `modifyDocument` broadcast.
 *
 * Returns `null` for anything unrecognized — a payload shape we do not model is
 * dropped rather than guessed at, leaving the cache untouched (and stale) rather
 * than corrupted.
 */
export declare function parseDocumentBroadcast(payload: unknown): DocumentBroadcast | null;
/**
 * Applies a validated broadcast to the cached world state, in place.
 *
 * @returns true if the cache changed; false when the broadcast targets something
 *   not cached (an unmodelled document type, an unknown parent, a synthetic
 *   token actor), in which case the cache is left untouched.
 */
export declare function applyDocumentBroadcast(worldData: WorldData, broadcast: DocumentBroadcast): boolean;
/** A validated `userActivity` broadcast: who, and whether they are present. */
export interface UserActivity {
    userId: string;
    active: boolean;
}
/**
 * Validates a raw `userActivity` socket payload (#218).
 *
 * This is untrusted network data, so it is schema-checked rather than cast.
 * Returns `null` for anything unrecognized, leaving presence as it was.
 */
export declare function parseUserActivity(userId: unknown, activityData: unknown): UserActivity | null;
/**
 * Applies a presence change to `worldData.activeUsers`, in place.
 *
 * `activeUsers` is a top-level `WorldData` field rather than a document
 * collection, which is exactly why `modifyDocument` broadcasts never reached it
 * and presence stayed frozen at the connect-time snapshot (#218).
 *
 * @returns true if the active-user list changed
 */
export declare function applyUserActivity(worldData: WorldData, activity: UserActivity): boolean;
//# sourceMappingURL=world-cache.d.ts.map