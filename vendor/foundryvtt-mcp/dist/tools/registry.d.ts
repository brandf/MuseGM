/**
 * @fileoverview Tool registry for the new tool system
 *
 * This module manages tool registration and provides a clean interface
 * for tool execution with automatic validation.
 */
import type { Tool, ToolContext, ToolResult } from './base.js';
/**
 * Tool registry manages all available tools
 */
export declare class ToolRegistry {
    private tools;
    constructor();
    /**
     * Register a tool in the registry
     */
    register(tool: Tool): void;
    /**
     * Execute a tool by name with given arguments
     */
    execute(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
    /**
     * Get all registered tool names
     */
    getToolNames(): string[];
    /**
     * Get tool definitions for MCP
     */
    getToolDefinitions(): Array<{
        name: string;
        description: string;
        inputSchema: object;
    }>;
    /**
     * Check if a tool is registered
     */
    has(name: string): boolean;
    /**
     * Get a specific tool instance
     */
    get(name: string): Tool | undefined;
    /**
     * Register all default tools
     */
    private registerDefaultTools;
}
/**
 * Global tool registry instance
 */
export declare const toolRegistry: ToolRegistry;
//# sourceMappingURL=registry.d.ts.map