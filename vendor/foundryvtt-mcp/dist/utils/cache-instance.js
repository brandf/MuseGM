/**
 * @fileoverview Global cache instance singleton
 *
 * This module provides a singleton cache instance that's configured
 * from the application configuration.
 */
import { config } from '../config/index.js';
import { CacheService } from './cache.js';
/**
 * Global cache instance
 * Initialized with configuration from config system
 */
export const cache = new CacheService(config?.cache || {
    enabled: false,
    ttlSeconds: 300,
    maxSize: 1000,
});
/**
 * Cache key generators for consistent naming
 */
export const CacheKeys = {
    worldInfo: () => 'world:info',
    actor: (id) => `actor:${id}`,
    actorSearch: (query, type, limit) => `actor:search:${query}:${type || 'all'}:${limit || 10}`,
    item: (id) => `item:${id}`,
    itemSearch: (query, type, rarity, limit) => `item:search:${query}:${type || 'all'}:${rarity || 'all'}:${limit || 10}`,
    scene: (id) => (id ? `scene:${id}` : 'scene:current'),
    rule: (query, system) => `rule:${query}:${system || 'default'}`,
};
//# sourceMappingURL=cache-instance.js.map