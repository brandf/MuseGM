/**
 * @fileoverview New tool routing implementation using registry pattern
 *
 * This module provides a cleaner routing system that uses the tool registry
 * and eliminates the need for manual switch statements and validation.
 */
import type { DiagnosticsClient } from '../diagnostics/client.js';
import type { FoundryClient } from '../foundry/client.js';
import type { DiagnosticSystem } from '../utils/diagnostics.js';
/**
 * Routes tool requests using the new registry system
 */
export declare function routeToolRequest(name: string, args: Record<string, unknown>, foundryClient: FoundryClient, diagnosticsClient: DiagnosticsClient, diagnosticSystem: DiagnosticSystem): Promise<import("./base.js").ToolResult | {
    content: {
        type: string;
        text: string;
    }[];
}>;
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
//# sourceMappingURL=new-router.d.ts.map