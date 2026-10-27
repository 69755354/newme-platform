/**
 * Declarations for src/lib/api-cache.mjs.
 *
 * There is deliberately no eviction or invalidation export here. The reason, and
 * the list of reads that must not use this cache at all, are in the module header.
 */
export function getCached<T>(key: string): T | null;
export function setCache<T>(key: string, data: T, ttlSeconds: number): void;
export function cacheSize(): number;
