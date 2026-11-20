/**
 * @fileoverview Compendium search tool handlers
 *
 * Read-only search across FoundryVTT compendium packs by name and metadata.
 * Compendium data is not part of the cached worldData snapshot, so this tool
 * requires the REST API module (FOUNDRY_API_KEY). Without it the search
 * returns gracefully empty and the handler explains why.
 */
import type { FoundryClient } from '../../foundry/client.js';
interface CompendiumFilters {
    compendiumId?: string;
    packType?: string;
    itemType?: string;
    spellLevel?: number;
    source?: string;
}
/**
 * Handles compendium search requests.
 *
 * Searches across all enabled compendiums by default; the `compendiumId`
 * filter scopes the search to a single pack. Returns enough metadata
 * (compendiumId, itemId, type, system.source.rules) to disambiguate
 * near-identical entries across rule revisions.
 */
export declare function handleSearchCompendium(args: {
    query: string;
    filters?: CompendiumFilters;
    limit?: number;
    cursor?: string;
}, foundryClient: FoundryClient): Promise<{
    content: {
        type: string;
        text: string;
    }[];
}>;
export {};
//# sourceMappingURL=compendium.d.ts.map