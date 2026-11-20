/**
 * @fileoverview Shared combatant turn-order helper (#214).
 *
 * FoundryVTT resolves `Combat#turn` against the **initiative-sorted** turn
 * order, not the stored (creation) order of `Combat#combatants`. Every handler
 * that maps a `turn` index onto a combatant — the read path
 * (`get_combat_state`) and the write path (`next_turn`) alike — must therefore
 * derive that list here, so the two can never drift apart through slightly
 * different comparators.
 *
 * The comparator mirrors core's `Combat._sortCombatants`: initiative
 * descending, non-numeric (un-rolled) initiative last, ties broken by document
 * id so the order is deterministic and stable.
 */
import type { WorldCombat } from '../../foundry/types.js';
/** A single combatant embedded in a `WorldCombat` document. */
export type WorldCombatant = WorldCombat['combatants'][number];
/**
 * Compares two combatants by Foundry's turn-order rules.
 *
 * Initiative descending; combatants without a rolled initiative go last; ties
 * (including two un-rolled combatants, whose difference is `NaN`) fall back to
 * the document id so the ordering is total and deterministic.
 */
export declare function compareCombatants(a: WorldCombatant, b: WorldCombatant): number;
/**
 * Returns the combatants of `combat` in turn order.
 *
 * Sorts a **copy** — `combat` is a live reference into the world-data cache, so
 * sorting in place would silently reorder cached state as a side effect of a
 * read.
 */
export declare function getTurnOrder(combat: WorldCombat): WorldCombatant[];
/**
 * Whether the encounter is under way, derived the way core derives it.
 *
 * `Combat#started` is a **client-side getter** (`turns.length > 0 && round >
 * 0`), not schema data: `BaseCombat.defineSchema()` does not declare it, so a
 * Combat document read out of `worldData` never carries the key. Reading
 * `combat.started` therefore evaluates to `undefined` on every real world —
 * only hand-written fixtures have it — so started-ness is computed here from
 * the two fields the transport does deliver.
 */
export declare function isCombatStarted(combat: WorldCombat): boolean;
/**
 * Returns the combatant `combat.turn` currently points at, if any.
 *
 * Yields `undefined` when nobody is acting yet — the encounter has not been
 * started (initiatives are commonly assigned during round 0 setup), `turn` is
 * null, or the stored index no longer resolves to a combatant.
 */
export declare function getCurrentCombatant(combat: WorldCombat): WorldCombatant | undefined;
/**
 * Computes where `actingCombatantId` lands in the turn order once `change` is
 * applied — i.e. the `turn` index that keeps the same combatant acting.
 *
 * The change is projected onto a copy rather than read back from the cache:
 * `setCombatantInitiative` resolves on the `modifyDocument` ack, while the
 * cache is updated by the separate broadcast, so the cached initiative may or
 * may not have caught up by the time this runs. Projecting is correct either
 * way (re-applying the same value is a no-op).
 *
 * @returns the new index, or `undefined` if the acting combatant is gone.
 */
export declare function turnIndexAfterInitiativeChange(combat: WorldCombat, change: {
    combatantId: string;
    initiative: number;
}, actingCombatantId: string): number | undefined;
//# sourceMappingURL=combat-order.d.ts.map