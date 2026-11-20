/**
 * @fileoverview Combat control mutation tool handlers (FR-018)
 *
 * Provides GM-gated combat-control tools that operate on the *active* combat:
 * advancing the turn, ending the encounter, and setting a combatant's
 * initiative. All are WRITE operations — they require FOUNDRY_WRITE_ENABLED=true
 * and an active Socket.IO connection (mutations use the core `modifyDocument`
 * protocol), and the connected user needs GM/owner permission.
 */
import type { FoundryClient } from '../../foundry/client.js';
import type { WorldCombat } from '../../foundry/types.js';
/**
 * Computes the next `{ turn, round }` for an active combat.
 *
 * Advances to the next combatant in order; wrapping past the last combatant
 * rolls over to turn 0 of the next round.
 *
 * `Combat#turn` is an index into the **initiative-sorted** turn order (see
 * `combat-order.ts`), *not* into the stored/creation order of
 * `combat.combatants` — the same order `get_combat_state` renders (#214).
 *
 * When `skipDefeated` is true, `defeated` combatants are skipped — mirroring
 * Foundry's `Combat#nextTurn`/`nextRound` with the `skipDefeated` setting. If
 * every combatant is defeated, the round still advances (turn 0), matching
 * Foundry's "none remaining" fallback rather than hanging.
 *
 * @throws if the combat has no combatants (cannot advance an empty encounter).
 */
export declare function computeNextTurn(combat: WorldCombat, skipDefeated?: boolean): {
    turn: number;
    round: number;
};
/**
 * Advances the active combat to the next turn (FR-018).
 *
 * Accepts an optional `skipDefeated` argument; when omitted it falls back to the
 * combat's `settings.skipDefeated` (if present in the worldData snapshot), then
 * to `false`.
 */
export declare function handleNextTurn(args: {
    skipDefeated?: boolean;
}, foundryClient: FoundryClient): Promise<{
    content: {
        type: string;
        text: string;
    }[];
}>;
/**
 * Ends (deletes) the active combat encounter (FR-018).
 */
export declare function handleEndCombat(_args: Record<string, unknown>, foundryClient: FoundryClient): Promise<{
    content: {
        type: string;
        text: string;
    }[];
}>;
/**
 * Sets a combatant's initiative in the active combat (FR-018).
 *
 * `combatId` defaults to the active combat when omitted.
 *
 * Writing an initiative re-sorts the turn order underneath the stored
 * `Combat#turn`, which indexes that order (#214) — so a different combatant can
 * slide under the stored index. FoundryVTT's `Combat#setupTurns` re-finds the
 * combatant that was acting and re-points `turn` at its new index; this handler
 * mirrors that, so the MCP and Foundry never disagree about whose turn it is
 * after an initiative correction. The re-anchor is skipped when there is
 * nothing to anchor: no combatant is acting yet (round-0 setup, `turn` null, or
 * a stale index), the acting combatant's index is unchanged, or the write
 * targets a combat other than the active one (the only one readable here).
 */
export declare function handleSetInitiative(args: {
    combatantId: string;
    initiative: number;
    combatId?: string;
}, foundryClient: FoundryClient): Promise<{
    content: {
        type: string;
        text: string;
    }[];
}>;
/**
 * Starts a new combat encounter, seeding combatants from tokens (FR-018, #172).
 *
 * Resolves the target scene (explicit `sceneId`, else the active scene), then
 * builds combatant seeds from the requested `tokenIds` (or every token on the
 * scene when none are given) and delegates the two-step create to the client.
 */
export declare function handleStartCombat(args: {
    tokenIds?: string[];
    sceneId?: string;
}, foundryClient: FoundryClient): Promise<{
    content: {
        type: string;
        text: string;
    }[];
}>;
//# sourceMappingURL=combat-mutations.d.ts.map