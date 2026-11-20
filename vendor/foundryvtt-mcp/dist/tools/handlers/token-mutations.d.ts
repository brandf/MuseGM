/**
 * @fileoverview Token manipulation mutation tool handlers (FR-019)
 *
 * Provides GM-gated token-control tools that operate on tokens placed on
 * scenes: moving a token to new coordinates, and applying/removing a status
 * condition (ActiveEffect) on the token's actor. All are WRITE operations —
 * they require FOUNDRY_WRITE_ENABLED=true and an active Socket.IO connection
 * (mutations use the core `modifyDocument` protocol), and the connected user
 * needs GM/owner permission.
 */
import type { FoundryClient } from '../../foundry/client.js';
/**
 * Moves a token to x/y coordinates on its scene (FR-019).
 *
 * The token is resolved from the cached worldData; `sceneId` is optional and
 * only scopes the lookup (the parent scene is derived from the located token).
 */
export declare function handleMoveToken(args: {
    tokenId: string;
    x: number;
    y: number;
    sceneId?: string;
}, foundryClient: FoundryClient): Promise<{
    content: {
        type: string;
        text: string;
    }[];
}>;
/**
 * Applies or removes a status condition (ActiveEffect) on a token's actor
 * (FR-019).
 *
 * `active` defaults to `true` (apply). Mirrors `Actor#toggleStatusEffect`:
 * the effect is matched by its `statuses` array, so re-applying an already
 * present condition (or removing an absent one) is a no-op. Linked actors
 * resolve to `Actor.<id>`; unlinked tokens target their synthetic actor at
 * `Scene.<sid>.Token.<tid>.Actor.<aid>`.
 */
export declare function handleApplyStatusEffect(args: {
    tokenId: string;
    statusId: string;
    active?: boolean;
    sceneId?: string;
}, foundryClient: FoundryClient): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=token-mutations.d.ts.map