/**
 * World-level tool handlers: cross-collection search, summary, refresh
 */
import type { FoundryClient } from '../../foundry/client.js';
export declare function handleSearchWorld(args: {
    query: string;
    limit?: number;
}, foundryClient: FoundryClient): Promise<{
    content: {
        type: string;
        text: string;
    }[];
}>;
export declare function handleGetWorldSummary(_args: Record<string, unknown>, foundryClient: FoundryClient): Promise<{
    content: {
        type: string;
        text: string;
    }[];
}>;
export declare function handleRefreshWorldData(_args: Record<string, unknown>, foundryClient: FoundryClient): Promise<{
    content: {
        type: string;
        text: string;
    }[];
}>;
//# sourceMappingURL=world.d.ts.map