/**
 * @fileoverview Base tool interface and implementation
 *
 * This module provides the foundation for the tool system with automatic
 * schema validation and consistent interface design.
 */
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { logger } from '../utils/logger.js';
/**
 * Base tool class with automatic validation
 */
export class BaseTool {
    static ajv = new Ajv({
        allErrors: true,
        verbose: true,
        strict: true,
    });
    /**
     * Execute the tool with automatic validation
     */
    async execute(args, context) {
        logger.debug(`Executing tool: ${this.name}`, { args });
        // Validate input arguments against schema
        this.validateArgs(args);
        try {
            return await this.executeValidated(args, context);
        }
        catch (error) {
            logger.error(`Tool execution failed: ${this.name}`, error);
            if (error instanceof McpError) {
                throw error;
            }
            throw new McpError(ErrorCode.InternalError, `Tool execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    /**
     * Validate arguments against the tool's schema
     */
    validateArgs(args) {
        const validate = BaseTool.ajv.compile(this.inputSchema);
        const valid = validate(args);
        if (!valid) {
            const errors = validate.errors
                ?.map((err) => {
                const instancePath = err.instancePath || 'root';
                return `${instancePath}: ${err.message}`;
            })
                .join(', ') || 'Unknown validation error';
            throw new McpError(ErrorCode.InvalidParams, `Invalid parameters for tool '${this.name}': ${errors}`);
        }
    }
    /**
     * Helper method to create a text response
     */
    createTextResponse(text) {
        return {
            content: [
                {
                    type: 'text',
                    text,
                },
            ],
        };
    }
    /**
     * Helper method to create an error response
     */
    createErrorResponse(error) {
        return this.createTextResponse(`❌ **Error**: ${error.message}`);
    }
}
//# sourceMappingURL=base.js.map