/**
 * @fileoverview Journal entry mutation tool handlers (create)
 *
 * WRITE operations — require FOUNDRY_WRITE_ENABLED=true and an active Socket.IO
 * connection (mutations use the core `modifyDocument` protocol). `JournalEntry`
 * is a top-level document, so unlike the actor-item mutations there is no
 * parent to scope the write to.
 */
import type { FoundryClient } from '../../foundry/client.js';
import type { DocumentVisibility, JournalPageCreateSource } from '../../foundry/types.js';
/**
 * Handles creating a journal entry with one or more text pages.
 */
export declare function handleCreateJournalEntry(args: {
    name: string;
    pages: JournalPageCreateSource[];
    folder?: string;
    visibility?: DocumentVisibility;
}, foundryClient: FoundryClient): Promise<{
    content: {
        type: string;
        text: string;
    }[];
}>;
//# sourceMappingURL=journal-mutations.d.ts.map