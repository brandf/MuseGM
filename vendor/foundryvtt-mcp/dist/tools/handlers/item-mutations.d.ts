/**
 * @fileoverview Actor item mutation tool handlers (create / update / delete)
 *
 * WRITE operations — require FOUNDRY_WRITE_ENABLED=true and an active Socket.IO
 * connection (mutations use the core `modifyDocument` protocol). The canonical
 * mutation target is the D&D 5e v4+ activity schema; item `system` patches
 * honour JSON-merge-patch semantics on nested paths such as
 * `activities.{id}.consumption.targets`.
 */
import type { FoundryClient } from '../../foundry/client.js';
import type { ActorItemCreateSource } from '../../foundry/types.js';
/**
 * Handles creating an item on an actor from a compendium reference or an inline
 * item document.
 */
export declare function handleCreateActorItem(args: {
    actorId: string;
    source: ActorItemCreateSource;
}, foundryClient: FoundryClient): Promise<{
    content: {
        type: string;
        text: string;
    }[];
}>;
/**
 * Handles applying a JSON merge patch to an item's `system` data. Supports
 * nested paths (e.g. `activities.{id}.consumption.targets`).
 */
export declare function handleUpdateActorItem(args: {
    actorId: string;
    itemId: string;
    patch: Record<string, unknown>;
}, foundryClient: FoundryClient): Promise<{
    content: {
        type: string;
        text: string;
    }[];
}>;
/**
 * Handles deleting an item owned by an actor.
 */
export declare function handleDeleteActorItem(args: {
    actorId: string;
    itemId: string;
}, foundryClient: FoundryClient): Promise<{
    content: {
        type: string;
        text: string;
    }[];
}>;
//# sourceMappingURL=item-mutations.d.ts.map