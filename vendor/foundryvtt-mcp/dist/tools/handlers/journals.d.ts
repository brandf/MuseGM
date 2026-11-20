/**
 * Journal entry tool handlers
 */
import type { FoundryClient } from '../../foundry/client.js';
export declare function handleSearchJournals(args: {
    query: string;
    limit?: number;
}, foundryClient: FoundryClient): Promise<{
    content: {
        type: string;
        text: string;
    }[];
}>;
export declare function handleGetJournal(args: {
    journalId: string;
}, foundryClient: FoundryClient): Promise<{
    content: {
        type: string;
        text: string;
    }[];
}>;
//# sourceMappingURL=journals.d.ts.map