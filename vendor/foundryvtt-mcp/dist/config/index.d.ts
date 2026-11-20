/**
 * @fileoverview Configuration management for FoundryVTT MCP Server
 *
 * This module handles loading and validating configuration from environment variables
 * using Zod schemas for type safety and runtime validation.
 *
 * @version 0.1.0
 * @author FoundryVTT MCP Team
 */
import { z } from 'zod';
/**
 * Zod schema for validating server configuration
 *
 * Defines the structure and validation rules for all configuration options,
 * including server settings, FoundryVTT connection details, and caching options.
 */
declare const ConfigSchema: z.ZodObject<{
    serverName: z.ZodDefault<z.ZodString>;
    serverVersion: z.ZodDefault<z.ZodString>;
    logLevel: z.ZodDefault<z.ZodEnum<{
        debug: "debug";
        info: "info";
        warn: "warn";
        error: "error";
    }>>;
    nodeEnv: z.ZodDefault<z.ZodEnum<{
        development: "development";
        production: "production";
        test: "test";
    }>>;
    foundry: z.ZodObject<{
        url: z.ZodString;
        apiKey: z.ZodOptional<z.ZodString>;
        username: z.ZodOptional<z.ZodString>;
        password: z.ZodOptional<z.ZodString>;
        userId: z.ZodOptional<z.ZodString>;
        socketPath: z.ZodDefault<z.ZodString>;
        timeout: z.ZodDefault<z.ZodNumber>;
        retryAttempts: z.ZodDefault<z.ZodNumber>;
        retryDelay: z.ZodDefault<z.ZodNumber>;
        writeEnabled: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>;
    cache: z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        ttlSeconds: z.ZodDefault<z.ZodNumber>;
        maxSize: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>;
}, z.core.$strip>;
/**
 * TypeScript type derived from the ConfigSchema
 *
 * This type provides compile-time type checking for configuration objects
 * and ensures consistency between the schema and type definitions.
 */
type Config = z.infer<typeof ConfigSchema>;
/**
 * Gets the global configuration instance
 *
 * This loads and caches the configuration on first access, allowing tests
 * to set environment variables before triggering configuration validation.
 *
 * @returns Validated configuration object
 * @example
 * ```typescript
 * import { config } from './config/index.js';
 *
 * console.log(`Connecting to ${config.foundry.url}`);
 * if (config.foundry.apiKey) {
 *   console.log('Using local REST API module with API key');
 * } else {
 *   console.log('Using WebSocket connection with username/password');
 * }
 * ```
 */
export declare const config: {
    serverName: string;
    serverVersion: string;
    logLevel: "debug" | "info" | "warn" | "error";
    nodeEnv: "development" | "production" | "test";
    foundry: {
        url: string;
        socketPath: string;
        timeout: number;
        retryAttempts: number;
        retryDelay: number;
        writeEnabled: boolean;
        apiKey?: string | undefined;
        username?: string | undefined;
        password?: string | undefined;
        userId?: string | undefined;
    };
    cache: {
        enabled: boolean;
        ttlSeconds: number;
        maxSize: number;
    };
};
/**
 * Resets the cached configuration - used for testing
 * @internal
 */
export declare function resetConfig(): void;
/**
 * Export the Config type for use in other modules
 *
 * @example
 * ```typescript
 * import type { Config } from './config/index.js';
 *
 * function processConfig(cfg: Config) {
 *   // Process configuration
 * }
 * ```
 */
export type { Config };
//# sourceMappingURL=index.d.ts.map