/**
 * Tool routing and handler coordination
 */
import type { DiagnosticsClient } from '../diagnostics/client.js';
import type { FoundryClient } from '../foundry/client.js';
import type { DiagnosticSystem } from '../utils/diagnostics.js';
import type { ToolResult } from './base.js';
/**
 * Routes tool requests to appropriate handlers
 */
export declare function routeToolRequest(name: string, args: Record<string, unknown>, foundryClient: FoundryClient, diagnosticsClient: DiagnosticsClient, diagnosticSystem: DiagnosticSystem): Promise<ToolResult>;
/**
 * Routes resource requests to appropriate handlers
 */
export declare function routeResourceRequest(uri: string, foundryClient: FoundryClient, diagnosticsClient: DiagnosticsClient): Promise<{
    contents: {
        uri: string;
        mimeType: string;
        text: string;
    }[];
}>;
//# sourceMappingURL=router.d.ts.map