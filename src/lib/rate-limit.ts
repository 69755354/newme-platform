/**
 * Fixed-window in-process rate limiter.
 *
 * Server-side password authentication concentrates every user's login attempts
 * behind one origin IP, which collapses the upstream per-IP brute-force
 * protection into a single bucket. This limiter restores a per-client bound.
 *
 * Scope: one Node process. The production deployment runs a single app process
 * behind nginx, so this is the whole surface today. A multi-process or
 * multi-host rollout must move these counters to a shared store.
 */

type Bucket = { count: number; resetAt: number };

const MAX_TRACKED_KEYS = 10_000;
const buckets = new Map<string, Bucket>();

/**
 * Client identity for limiting. CF-Connecting-IP is set by Cloudflare and is
 * the only forwarded value that a client cannot spoof end to end; the
 * X-Forwarded-For fallback covers direct-to-origin and local requests.
 */
export function clientIdentifier(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip")?.trim()
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")?.trim()
    || "unknown"
  );
}

function prune(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  // Backstop against unbounded growth under a distributed source of requests.
  if (buckets.size > MAX_TRACKED_KEYS) {
    const excess = buckets.size - MAX_TRACKED_KEYS;
    let dropped = 0;
    for (const key of buckets.keys()) {
      buckets.delete(key);
      if (++dropped >= excess) break;
    }
  }
}

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

export function consumeRateLimit(
  key: string,
  options: { limit: number; windowMs: number },
  now: number = Date.now(),
): RateLimitResult {
  prune(now);

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + options.windowMs });
    return { allowed: true, remaining: options.limit - 1, retryAfterSeconds: 0 };
  }

  bucket.count += 1;
  if (bucket.count > options.limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }
  return {
    allowed: true,
    remaining: options.limit - bucket.count,
    retryAfterSeconds: 0,
  };
}

/** Test-only reset so suites do not leak buckets between cases. */
export function resetRateLimits(): void {
  buckets.clear();
}
