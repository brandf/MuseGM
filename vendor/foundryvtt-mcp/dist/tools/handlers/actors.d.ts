/**
 * @fileoverview Actor management tool handlers
 *
 * Handles searching for actors and retrieving detailed actor information.
 */
import type { FoundryClient } from '../../foundry/client.js';
/**
 * Handles actor search requests
 */
export declare function handleSearchActors(args: {
    query?: string;
    type?: string;
    limit?: number;
}, foundryClient: FoundryClient): Promise<{
    content: {
        type: string;
        text: string;
    }[];
}>;
/**
 * Handles detailed actor information requests
 */
export declare function handleGetActorDetails(args: {
    actorId: string;
}, foundryClient: FoundryClient): Promise<{
    content: {
        type: string;
        text: string;
    }[];
}>;
//# sourceMappingURL=actors.d.ts.map