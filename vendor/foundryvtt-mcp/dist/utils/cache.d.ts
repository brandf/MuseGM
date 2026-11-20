/**
 * @fileoverview Caching utility with TTL (Time To Live) support
 *
 * This module provides a simple in-memory cache with automatic expiration
 * and configurable size limits to improve performance for quasi-static data.
 */
/**
 * Cache statistics for monitoring
 */
export interface CacheStats {
    hits: number;
    misses: number;
    hitRate: number;
    size: number;
    maxSize: number;
    evictions: number;
}
/**
 * Cache configuration options
 */
export interface CacheConfig {
    enabled: boolean;
    ttlSeconds: number;
    maxSize: number;
}
/**
 * Simple in-memory cache with TTL and LRU eviction
 */
export declare class CacheService {
    private config;
    private cache;
    private stats;
    private cleanupInterval;
    /**
     * Incremented on every set and cache hit. Date.now() has millisecond
     * resolution, so accesses within one millisecond would tie (#258).
     */
    private accessClock;
    constructor(config: CacheConfig);
    /**
     * Get a value from the cache
     */
    get<T>(key: string): T | undefined;
    /**
     * Set a value in the cache with custom TTL
     */
    set<T>(key: string, value: T, customTtlSeconds?: number): void;
    /**
     * Delete a specific key from the cache
     */
    delete(key: string): boolean;
    /**
     * Clear all entries from the cache
     */
    clear(): void;
    /**
     * Get or set a value using a factory function
     */
    getOrSet<T>(key: string, factory: () => Promise<T>, customTtlSeconds?: number): Promise<T>;
    /**
     * Get cache statistics
     */
    getStats(): CacheStats;
    /**
     * Check if cache is enabled
     */
    isEnabled(): boolean;
    /**
     * Destroy the cache service and release resources
     */
    destroy(): void;
    /**
     * Get cache keys (for debugging)
     */
    getKeys(): string[];
    /**
     * Cleanup expired entries
     */
    private cleanup;
    /**
     * Evict least recently used entry
     */
    private evictLeastRecentlyUsed;
}
//# sourceMappingURL=cache.d.ts.map