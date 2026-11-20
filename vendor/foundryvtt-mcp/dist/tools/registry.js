/**
 * @fileoverview Tool registry for the new tool system
 *
 * This module manages tool registration and provides a clean interface
 * for tool execution with automatic validation.
 */
import { logger } from '../utils/logger.js';
import { RollDiceTool } from './handlers/dice.js';
/**
 * Tool registry manages all available tools
 */
export class ToolRegistry {
    tools = new Map();
    constructor() {
        this.registerDefaultTools();
    }
    /**
     * Register a tool in the registry
     */
    register(tool) {
        if (this.tools.has(tool.name)) {
            logger.warn(`Tool '${tool.name}' is already registered, replacing...`);
        }
        this.tools.set(tool.name, tool);
        logger.debug(`Registered tool: ${tool.name}`);
    }
    /**
     * Execute a tool by name with given arguments
     */
    async execute(name, args, context) {
        const tool = this.tools.get(name);
        if (!tool) {
            throw new Error(`Unknown tool: ${name}`);
        }
        return await tool.execute(args, context);
    }
    /**
     * Get all registered tool names
     */
    getToolNames() {
        return Array.from(this.tools.keys());
    }
    /**
     * Get tool definitions for MCP
     */
    getToolDefinitions() {
        return Array.from(this.tools.values()).map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
        }));
    }
    /**
     * Check if a tool is registered
     */
    has(name) {
        return this.tools.has(name);
    }
    /**
     * Get a specific tool instance
     */
    get(name) {
        return this.tools.get(name);
    }
    /**
     * Register all default tools
     */
    registerDefaultTools() {
        // Register the dice tool (converted to new system)
        this.register(new RollDiceTool());
        // TODO: Register other tools as they are converted
        logger.info(`Registered ${this.tools.size} tools`);
    }
}
/**
 * Global tool registry instance
 */
export const toolRegistry = new ToolRegistry();
//# sourceMappingURL=registry.js.map