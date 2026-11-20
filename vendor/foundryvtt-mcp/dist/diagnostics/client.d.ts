/**
 * @fileoverview DiagnosticsClient for accessing FoundryVTT logs and system health
 *
 * This module provides a client interface for accessing diagnostic information
 * from FoundryVTT through the REST API module's diagnostic endpoints.
 *
 * @version 0.1.0
 * @author FoundryVTT MCP Team
 */
import type { z } from 'zod';
import type { FoundryClient } from '../foundry/client.js';
import type { LogPatternSearchParams, LogSearchParams } from './types.js';
import { ErrorDiagnosisSchema, type LogEntrySchema, LogResponseSchema, LogSearchResponseSchema, SystemHealthSchema } from './types.js';
type LogEntry = z.infer<typeof LogEntrySchema>;
type LogResponse = z.infer<typeof LogResponseSchema>;
type LogSearchResponse = z.infer<typeof LogSearchResponseSchema>;
type SystemHealth = z.infer<typeof SystemHealthSchema>;
type ErrorDiagnosis = z.infer<typeof ErrorDiagnosisSchema>;
/**
 * Client for accessing FoundryVTT diagnostic and logging information
 *
 * Provides methods to retrieve logs, search for specific patterns,
 * monitor system health, and analyze errors through the REST API.
 *
 * @class DiagnosticsClient
 * @example
 * ```typescript
 * const diagnostics = new DiagnosticsClient(foundryClient);
 *
 * // Get recent errors
 * const errors = await diagnostics.getRecentLogs({ level: 'error', lines: 20 });
 *
 * // Search for specific patterns
 * const matches = await diagnostics.searchLogs({ pattern: 'TypeError', timeframe: '3600' });
 *
 * // Check system health
 * const health = await diagnostics.getSystemHealth();
 * ```
 */
export declare class DiagnosticsClient {
    private foundryClient;
    /**
     * Create a new DiagnosticsClient instance
     *
     * @param foundryClient - The FoundryClient instance to use for API calls
     */
    constructor(foundryClient: FoundryClient);
    /**
     * Get recent log entries with optional filtering
     *
     * @param params - Search parameters for filtering logs
     * @returns Promise resolving to log response with entries and metadata
     *
     * @example
     * ```typescript
     * // Get last 50 log entries
     * const logs = await diagnostics.getRecentLogs();
     *
     * // Get only error logs from the last hour
     * const errors = await diagnostics.getRecentLogs({
     *   level: 'error',
     *   since: new Date(Date.now() - 3600000).toISOString()
     * });
     *
     * // Get logs with stack traces included
     * const detailed = await diagnostics.getRecentLogs({
     *   lines: 100,
     *   includeStack: true
     * });
     * ```
     */
    getRecentLogs(params?: LogSearchParams): Promise<LogResponse>;
    /**
     * Search log entries for specific patterns using regular expressions
     *
     * @param params - Search parameters including pattern and filters
     * @returns Promise resolving to matching log entries
     *
     * @example
     * ```typescript
     * // Search for any TypeError occurrences
     * const typeErrors = await diagnostics.searchLogs({
     *   pattern: 'TypeError'
     * });
     *
     * // Search for network errors in the last hour
     * const networkErrors = await diagnostics.searchLogs({
     *   pattern: 'Failed to fetch|Network Error',
     *   timeframe: '3600',
     *   level: 'error'
     * });
     *
     * // Case-sensitive search for specific module errors
     * const moduleErrors = await diagnostics.searchLogs({
     *   pattern: 'Module.*failed',
     *   caseSensitive: true
     * });
     * ```
     */
    searchLogs(params: LogPatternSearchParams): Promise<LogSearchResponse>;
    /**
     * Get comprehensive system health and performance metrics
     *
     * @returns Promise resolving to complete system health information
     *
     * @example
     * ```typescript
     * const health = await diagnostics.getSystemHealth();
     *
     * console.log(`Server status: ${health.status}`);
     * console.log(`Active users: ${health.users.active}/${health.users.total}`);
     * console.log(`Recent errors: ${health.logs.recentErrors}`);
     *
     * if (health.status === 'critical') {
     *   console.warn('Server requires immediate attention!');
     * }
     * ```
     */
    getSystemHealth(): Promise<SystemHealth>;
    /**
     * Analyze recent errors and get diagnostic suggestions
     *
     * @param timeframe - Time window in seconds to analyze (default: 3600)
     * @returns Promise resolving to error diagnosis with suggestions
     *
     * @example
     * ```typescript
     * // Analyze errors from the last hour
     * const diagnosis = await diagnostics.diagnoseErrors();
     *
     * // Analyze errors from the last 30 minutes
     * const recentDiagnosis = await diagnostics.diagnoseErrors(1800);
     *
     * console.log(`Health score: ${diagnosis.healthScore}/100`);
     * console.log(`Total errors: ${diagnosis.summary.totalErrors}`);
     *
     * // Display suggestions
     * diagnosis.suggestions.forEach(suggestion => {
     *   console.log(`${suggestion.priority.toUpperCase()}: ${suggestion.suggestion}`);
     * });
     * ```
     */
    diagnoseErrors(timeframe?: number): Promise<ErrorDiagnosis>;
    /**
     * Get errors filtered by severity and time window
     *
     * @param timeframe - Time window in seconds (default: 3600)
     * @param level - Log level to filter by (default: 'error')
     * @returns Promise resolving to filtered log entries
     *
     * @example
     * ```typescript
     * // Get all errors from the last 2 hours
     * const errors = await diagnostics.getErrorsOnly(7200);
     *
     * // Get warnings from the last 30 minutes
     * const warnings = await diagnostics.getErrorsOnly(1800, 'warn');
     * ```
     */
    getErrorsOnly(timeframe?: number, level?: LogEntry['level']): Promise<LogEntry[]>;
    /**
     * Monitor system health and return status summary
     *
     * Only the overall status: there is no numeric score behind it. The
     * signature used to declare an optional `score` and the example used to show
     * one, but nothing ever set it and {@link SystemHealth} has no such field —
     * so a caller that read it got `undefined` from a documented field.
     *
     * @returns Promise resolving to the overall status, `'critical'` if health
     *   could not be retrieved at all
     *
     * @example
     * ```typescript
     * const status = await diagnostics.getHealthStatus();
     * // Returns: { status: 'healthy' | 'warning' | 'critical' }
     * ```
     */
    getHealthStatus(): Promise<{
        status: SystemHealth['status'];
    }>;
    /**
     * Check if diagnostics API is available
     *
     * @returns Promise resolving to boolean indicating availability
     *
     * @example
     * ```typescript
     * const available = await diagnostics.isAvailable();
     * if (!available) {
     *   console.log('Diagnostics API not available - check module installation');
     * }
     * ```
     */
    isAvailable(): Promise<boolean>;
}
export {};
//# sourceMappingURL=client.d.ts.map