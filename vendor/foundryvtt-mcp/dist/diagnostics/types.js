/**
 * @fileoverview Type definitions for FoundryVTT diagnostics and logging
 *
 * This module provides TypeScript interfaces for log entries, system health metrics,
 * and diagnostic data structures used by the MCP server for FoundryVTT monitoring.
 *
 * @version 0.1.0
 * @author FoundryVTT MCP Team
 */
import { z } from 'zod';
export const LogEntrySchema = z.object({
    timestamp: z.string(),
    level: z.enum(['log', 'warn', 'error', 'info', 'notification']),
    message: z.string(),
    stack: z.string().optional(),
    source: z.enum(['foundry', 'module', 'system', 'api', 'unknown']),
});
export const LogResponseSchema = z.object({
    logs: z.array(LogEntrySchema),
    total: z.number(),
    bufferSize: z.number().optional(),
    maxBufferSize: z.number().optional(),
});
export const LogSearchResponseSchema = z.object({
    logs: z.array(LogEntrySchema),
    matches: z.number(),
    pattern: z.string(),
    searchTimeframe: z.string(),
});
const ServerInfoSchema = z.object({
    foundryVersion: z.string(),
    systemVersion: z.string(),
    worldId: z.string(),
    uptime: z.number().optional(),
});
const UserInfoSchema = z.object({
    total: z.number(),
    active: z.number(),
    gm: z.number(),
});
const ModuleInfoSchema = z.object({
    total: z.number(),
    active: z.number(),
});
const PerformanceInfoSchema = z.object({
    memory: z
        .object({
        rss: z.number(),
        heapTotal: z.number(),
        heapUsed: z.number(),
        external: z.number(),
        arrayBuffers: z.number(),
    })
        .optional(),
    connectedClients: z.number(),
});
const LogInfoSchema = z.object({
    bufferSize: z.number(),
    recentErrors: z.number(),
    recentWarnings: z.number(),
    errorRate: z.number(),
});
export const SystemHealthSchema = z.object({
    timestamp: z.string(),
    server: ServerInfoSchema,
    users: UserInfoSchema,
    modules: ModuleInfoSchema,
    performance: PerformanceInfoSchema,
    logs: LogInfoSchema,
    status: z.enum(['healthy', 'warning', 'critical']),
});
const ErrorCategoriesSchema = z.record(z.string(), z.number());
const DiagnosticSuggestionSchema = z.object({
    category: z.string(),
    suggestion: z.string(),
    priority: z.enum(['low', 'medium', 'high', 'critical']),
});
const ErrorSummarySchema = z.object({
    totalErrors: z.number(),
    uniqueErrors: z.number(),
    categories: ErrorCategoriesSchema,
});
export const ErrorDiagnosisSchema = z.object({
    timestamp: z.string(),
    timeframe: z.string(),
    summary: ErrorSummarySchema,
    recentErrors: z.array(LogEntrySchema),
    suggestions: z.array(DiagnosticSuggestionSchema),
    healthScore: z.number(),
});
//# sourceMappingURL=types.js.map