/**
 * Chat message tool handler
 */
import type { FoundryClient } from '../../foundry/client.js';
export declare function handleGetChatMessages(args: {
    limit?: number;
}, foundryClient: FoundryClient): Promise<{
    content: {
        type: string;
        text: string;
    }[];
}>;
//# sourceMappingURL=chat.d.ts.map