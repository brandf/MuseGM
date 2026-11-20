/**
 * @fileoverview Actor attribute mutation tool handlers (#143)
 *
 * Handles patching attributes on an actor's `system` object via dot-paths.
 * WRITE operation — requires FOUNDRY_WRITE_ENABLED=true and an active Socket.IO
 * connection (mutations use the core `modifyDocument` protocol).
 */
import type { AttributePatch, FoundryClient } from '../../foundry/client.js';
/**
 * Handles actor attribute update requests.
 *
 * `patch` keys are dot-paths into the actor's `system` object — e.g.
 * `attributes.hp.value`, `attributes.hp.temp`, `currency.gp`,
 * `resources.primary.value`, `spells.spell1.value`, `attributes.exhaustion`.
 * The post-update value of every patched path is echoed back.
 */
export declare function handleUpdateActorAttribute(args: {
    actorId: string;
    patch: AttributePatch;
}, foundryClient: FoundryClient): Promise<{
    content: {
        type: string;
        text: string;
    }[];
}>;
//# sourceMappingURL=actor-mutations.d.ts.map