/**
 * @fileoverview Scene management tool handlers
 *
 * Handles scene information retrieval and management.
 */
import type { FoundryClient } from '../../foundry/client.js';
/**
 * Handles scene information requests
 */
export declare function handleGetSceneInfo(args: {
    sceneId?: string;
}, foundryClient: FoundryClient): Promise<{
    content: {
        type: string;
        text: string;
    }[];
}>;
//# sourceMappingURL=scenes.d.ts.map