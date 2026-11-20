/**
 * @fileoverview Content generation tool handlers
 *
 * Handles NPC generation, loot generation, and rule lookups.
 */
import type { FoundryClient } from '../../foundry/client.js';
/**
 * Handles NPC generation requests
 */
export declare function handleGenerateNPC(args: {
    level?: number;
    race?: string;
    class?: string;
}, _foundryClient: FoundryClient): Promise<{
    content: {
        type: string;
        text: string;
    }[];
}>;
/**
 * Handles loot generation requests
 */
export declare function handleGenerateLoot(args: {
    challengeRating?: number;
    treasureType?: string;
}, _foundryClient: FoundryClient): Promise<{
    content: {
        type: string;
        text: string;
    }[];
}>;
/**
 * Handles rule lookup requests
 */
export declare function handleLookupRule(args: {
    query: string;
    system?: string;
}, _foundryClient: FoundryClient): Promise<{
    content: {
        type: string;
        text: string;
    }[];
}>;
//# sourceMappingURL=generation.d.ts.map