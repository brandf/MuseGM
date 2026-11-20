/**
 * @fileoverview Diagnostic utilities for enhanced user experience
 *
 * Provides smart error analysis, problem detection, and actionable suggestions
 * to help users troubleshoot and resolve common issues.
 */
import { type FoundryClient } from '../foundry/client.js';
/**
 * Diagnostic result containing problem analysis and suggestions
 */
export interface DiagnosticResult {
    /** Brief explanation of the issue */
    explanation: string;
    /** Actionable suggestions for resolution */
    suggestions: string;
    /** Severity level of the issue */
    severity: 'info' | 'warning' | 'error' | 'critical';
    /** Whether the feature can function with limitations */
    canContinue: boolean;
    /** Link to relevant documentation */
    documentationUrl?: string;
}
/**
 * Health check report for system status
 */
export interface HealthReport {
    connectivity: {
        status: 'connected' | 'limited' | 'offline';
        emoji: string;
        details: string;
    };
    authentication: {
        method: 'api-key' | 'credentials' | 'none';
        status: 'valid' | 'invalid' | 'untested';
        emoji: string;
    };
    features: {
        diceRolling: boolean;
        actorSearch: boolean;
        itemSearch: boolean;
        sceneData: boolean;
        diagnostics: boolean;
    };
    restApiAvailable: boolean;
    websocketAvailable: boolean;
}
/**
 * Enhanced diagnostic system for FoundryVTT MCP integration
 */
export declare class DiagnosticSystem {
    private foundryClient;
    constructor(foundryClient: FoundryClient);
    /**
     * Diagnose why a specific feature isn't working
     */
    diagnoseFeatureProblem(feature: 'actors' | 'items' | 'scenes' | 'diagnostics'): Promise<DiagnosticResult>;
    /**
     * Perform comprehensive health check
     */
    performHealthCheck(): Promise<HealthReport>;
    /**
     * Format health report for user display
     */
    formatHealthReport(report: HealthReport): string;
    /**
     * Create diagnostic for connectivity issues
     */
    private createConnectivityDiagnostic;
    /**
     * Create diagnostic for REST API issues
     */
    private createRestApiDiagnostic;
    /**
     * Create diagnostic for authentication issues
     */
    private createAuthenticationDiagnostic;
    /**
     * Create feature-specific diagnostic
     */
    private createFeatureSpecificDiagnostic;
    /**
     * Create generic error diagnostic
     */
    private createGenericErrorDiagnostic;
    /**
     * Test if feature requires REST API
     */
    private requiresRestApi;
    /**
     * Test REST API availability: the module answers its authenticated
     * /api/world route with JSON (#230). Same probe as `FoundryClient.connect()`.
     */
    private testRestApiAvailability;
    /**
     * Test authentication
     */
    private testAuthentication;
    /**
     * Test dice rolling functionality
     */
    private testDiceRolling;
    /**
     * Test actor search functionality
     */
    private testActorSearch;
    /**
     * Test item search functionality
     */
    private testItemSearch;
    /**
     * Test scene data functionality
     */
    private testSceneData;
}
//# sourceMappingURL=diagnostics.d.ts.map