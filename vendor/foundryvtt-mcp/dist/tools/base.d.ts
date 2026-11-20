/**
 * @fileoverview Base tool interface and implementation
 *
 * This module provides the foundation for the tool system with automatic
 * schema validation and consistent interface design.
 */
import type { DiagnosticsClient } from '../diagnostics/client.js';
import type { FoundryClient } from '../foundry/client.js';
import type { DiagnosticSystem } from '../utils/diagnostics.js';
/**
 * Tool execution context containing all necessary dependencies
 */
export interface ToolContext {
    foundryClient: FoundryClient;
    diagnosticsClient?: DiagnosticsClient;
    diagnosticSystem?: DiagnosticSystem;
}
/**
 * Tool execution result matching the MCP CallToolResult shape.
 * Uses a structural interface to avoid pulling in zod-inferred literal types
 * while still enforcing the required content array structure.
 */
export interface ToolResult {
    content: Array<{
        type: string;
        text?: string;
        data?: string;
        mimeType?: string;
        [key: string]: unknown;
    }>;
    isError?: boolean;
}
/**
 * Base interface for all tools
 */
export interface Tool {
    /** Tool name (must match schema name) */
    readonly name: string;
    /** Tool description */
    readonly description: string;
    /** JSON Schema for input validation */
    readonly inputSchema: object;
    /**
     * Execute the tool with validated arguments
     * @param args - Validated input arguments
     * @param context - Tool execution context
     * @returns Tool execution result
     */
    execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}
/**
 * Base tool class with automatic validation
 */
export declare abstract class BaseTool implements Tool {
    private static readonly ajv;
    abstract readonly name: string;
    abstract readonly description: string;
    abstract readonly inputSchema: object;
    /**
     * Execute the tool with automatic validation
     */
    execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
    /**
     * Execute the tool with validated arguments (must be implemented by subclasses)
     */
    protected abstract executeValidated(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
    /**
     * Validate arguments against the tool's schema
     */
    private validateArgs;
    /**
     * Helper method to create a text response
     */
    protected createTextResponse(text: string): ToolResult;
    /**
     * Helper method to create an error response
     */
    protected createErrorResponse(error: Error): ToolResult;
}
//# sourceMappingURL=base.d.ts.map