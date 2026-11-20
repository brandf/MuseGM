/**
 * @fileoverview Global cache instance singleton
 *
 * This module provides a singleton cache instance that's configured
 * from the application configuration.
 */
import { CacheService } from './cache.js';
/**
 * Global cache instance
 * Initialized with configuration from config system
 */
export declare const cache: CacheService;
/**
 * Cache key generators for consistent naming
 */
export declare const CacheKeys: {
    readonly worldInfo: () => string;
    readonly actor: (id: string) => string;
    readonly actorSearch: (query: string, type?: string, limit?: number) => string;
    readonly item: (id: string) => string;
    readonly itemSearch: (query: string, type?: string, rarity?: string, limit?: number) => string;
    readonly scene: (id?: string) => string;
    readonly rule: (query: string, system?: string) => string;
};
//# sourceMappingURL=cache-instance.d.ts.map