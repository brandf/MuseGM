/**
 * @fileoverview Diagnostics and logging tool handlers
 *
 * Handles system diagnostics, logging, and health monitoring.
 */
import type { DiagnosticsClient } from '../../diagnostics/client.js';
import type { FoundryClient } from '../../foundry/client.js';
import type { DiagnosticSystem } from '../../utils/diagnostics.js';
/**
 * Handles recent log retrieval requests
 *
 * Filtering is applied after fetching all logs from the underlying source:
 * - `limit`: clamps result count (default 20, hard cap 1000)
 * - `level`: case-insensitive match against log entry level; unrecognized values are silently ignored
 * - `since`: ISO 8601 timestamp; entries older than this are excluded; unparseable values are silently ignored
 */
export declare function handleGetRecentLogs(args: {
    limit?: number;
    level?: string | string[];
    since?: string;
}, diagnosticsClient: DiagnosticsClient): Promise<{
    content: {
        type: string;
        text: string;
    }[];
}>;
/**
 * Handles log search requests
 *
 * `searchLogs()` resolves to a `LogSearchResponse` object; matched entries live
 * under `response.logs` and the upstream match count under `response.matches`.
 *
 * - `level`: forwarded to the search request when it names a real log level
 * - `limit`: applied to the rendered entries (default 50, hard cap 1000); it
 *   does not shrink the reported `matches` total
 */
export declare function handleSearchLogs(args: {
    query: string;
    level?: string;
    limit?: number;
}, diagnosticsClient: DiagnosticsClient): Promise<{
    content: {
        type: string;
        text: string;
    }[];
}>;
/**
 * Handles system health requests
 *
 * Every value rendered here is a field `SystemHealthSchema` actually declares.
 * The schema strips unknown keys, so metrics it does not model (CPU, disk,
 * response time, throughput) cannot be reported and are deliberately absent
 * rather than rendered as a permanent `N/A`. Optional fields (`server.uptime`,
 * `performance.memory`) are omitted when the server does not supply them.
 */
export declare function handleGetSystemHealth(_args: Record<string, unknown>, diagnosticsClient: DiagnosticsClient): Promise<{
    content: {
        type: string;
        text: string;
    }[];
}>;
/**
 * Handles error diagnosis requests
 */
export declare function handleDiagnoseErrors(args: {
    category?: string;
}, _diagnosticSystem: DiagnosticSystem): Promise<{
    content: {
        type: string;
        text: string;
    }[];
}>;
/**
 * Handles comprehensive health status requests
 *
 * The system-health section reads the nested fields `SystemHealthSchema`
 * declares. Playtime is not reported: `getWorldInfo()` has no genuine source
 * for it and hard-codes 0.
 *
 * The world section carries {@link STALE_WORLD_DATA_NOTICE} whenever the cache
 * has stopped following live document changes (#217). Reads keep being served
 * from that snapshot, which is the right call — a flagged answer beats no
 * answer — but rendering it bare presents a point-in-time copy as though it
 * were live. It matters most right after an automatic reconnect, where the
 * connection line legitimately reads "✅ Connected" while the cache is still
 * missing every broadcast the outage swallowed.
 */
export declare function handleGetHealthStatus(_args: Record<string, unknown>, foundryClient: FoundryClient, diagnosticsClient: DiagnosticsClient): Promise<{
    content: {
        type: string;
        text: string;
    }[];
}>;
//# sourceMappingURL=diagnostics.d.ts.map