/**
 * Resource access handlers
 */
import type { DiagnosticsClient } from '../../diagnostics/client.js';
import type { FoundryClient } from '../../foundry/client.js';
export declare function handleReadResource(uri: string, foundryClient: FoundryClient, diagnosticsClient: DiagnosticsClient): Promise<{
    contents: {
        uri: string;
        mimeType: string;
        text: string;
    }[];
}>;
//# sourceMappingURL=resources.d.ts.map