/**
 * User management tool handler
 */
import type { FoundryClient } from '../../foundry/client.js';
export declare function handleGetUsers(_args: Record<string, unknown>, foundryClient: FoundryClient): Promise<{
    content: {
        type: string;
        text: string;
    }[];
}>;
//# sourceMappingURL=users.d.ts.map