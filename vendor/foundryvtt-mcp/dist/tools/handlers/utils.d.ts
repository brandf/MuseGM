/**
 * Shared utilities for tool handlers
 */
/**
 * Wraps an async handler function with standard error logging and McpError conversion.
 *
 * @param toolName - Label used in error log messages (e.g. 'search actors')
 * @param fn - Async function containing the handler logic
 */
export declare function withToolError<T>(toolName: string, fn: () => Promise<T>): Promise<T>;
//# sourceMappingURL=utils.d.ts.map