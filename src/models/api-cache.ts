/**
 * Simple in-memory cache for server-side API routes.
 * Not distributed — each Next.js instance has its own cache.
 * TTL in seconds.
 */

interface CacheEntry<T> {
  data: T;
  expiry: number;
}

const store = new Map<string, CacheEntry<unknown>>();

export function getCached<T>(key: string): T | null {
  const entry = store.get(key) as CacheEntry<T> | undefined;
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    store.delete(key);
    return null;
  }
  return entry.data;
}

export function setCache<T>(key: string, data: T, ttlSeconds: number): void {
  store.set(key, { data, expiry: Date.now() + ttlSeconds * 1000 });
}

/** Periodic cleanup — runs every 5 minutes, removes expired entries */
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now > entry.expiry) store.delete(key);
    }
  }, 5 * 60 * 1000);
}
