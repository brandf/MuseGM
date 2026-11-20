/**
 * @fileoverview Item management tool handlers
 *
 * Handles searching for items and retrieving detailed item information.
 */
import type { FoundryClient } from '../../foundry/client.js';
/**
 * Handles item search requests
 */
export declare function handleSearchItems(args: {
    query?: string;
    type?: string;
    rarity?: string;
    limit?: number;
}, foundryClient: FoundryClient): Promise<{
    content: {
        type: string;
        text: string;
    }[];
}>;
//# sourceMappingURL=items.d.ts.map