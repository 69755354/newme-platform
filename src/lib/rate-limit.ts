import { createHash } from "node:crypto";

/**
 * Fixed-window rate limiter over a fixed-size slot table.
 *
 * Server-side password authentication concentrates every user's login attempts
 * behind one origin IP, which collapses the upstream per-IP brute-force
 * protection into a single bucket. This limiter restores a per-client bound.
 *
 * Scope: one Node process. The production deployment runs a single app process
 * behind nginx, so this is the whole surface today. A multi-process or
 * multi-host rollout must move these counters to a shared store.
 *
 * REVISED 2026-08-11 after independent review. The previous implementation kept
 * a `Map<string, Bucket>` that grew with every distinct key, and had three
 * defects:
 *
 *  1. LIMITER BYPASS. Its overflow backstop deleted entries in Map *insertion*
 *     order:
 *         for (const key of buckets.keys()) { buckets.delete(key); ... }
 *     Insertion order is oldest-first, and the oldest buckets are precisely the
 *     ones mid-window that are actively refusing an attacker. So an attacker who
 *     exhausted the 8-per-15-minutes budget for a victim's account could flush
 *     their own limit by sending ~10k requests with distinct spoofed
 *     X-Forwarded-For values, then resume guessing. The backstop meant to bound
 *     memory was a documented way to defeat the limiter.
 *  2. O(n) WORK ON EVERY REQUEST. prune() swept the entire Map on each call, so
 *     the cost of one login attempt grew with the number of tracked keys — the
 *     attacker controls both.
 *  3. UNBOUNDED KEY LENGTH. Keys embedded a caller-supplied email with no length
 *     bound, so each tracked entry could be arbitrarily large.
 *
 * All three are structural consequences of a growable, keyed table, so the table
 * is gone. Keys are hashed into a fixed number of slots:
 *
 *   * memory is bounded by construction — no eviction policy exists to get
 *     wrong, and no request can ever cause another key's counter to be dropped;
 *   * every operation is O(1) — no sweep, so cost does not depend on traffic;
 *   * nothing derived from the key is retained, so no caller-supplied string
 *     (and no email address) is held in memory at all.
 *
 * Trade-off, accepted deliberately: two distinct keys can hash to the same slot
 * and then share a budget. That direction is the safe one — a collision can only
 * make limiting STRICTER, never grant an extra attempt, so it cannot be used as
 * a bypass. It does mean a colliding client can consume a victim's login budget;
 * that is not a new capability, since anyone can already exhaust a victim's
 * per-account budget by submitting wrong passwords for their address. With 16384
 * slots and the small number of concurrently-active clients this deployment
 * sees, collisions are rare.
 */

const SLOT_COUNT = 16384; // power of two: mask instead of modulo, no bias
const SLOT_MASK = SLOT_COUNT - 1;

// Parallel arrays rather than objects: fixed allocation, no per-entry GC.
const counts = new Int32Array(SLOT_COUNT);
const resetAt = new Float64Array(SLOT_COUNT);

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

/**
 * Map a key of any length to a slot. The full key is hashed, so a caller cannot
 * steer two keys into the same slot by controlling a prefix, and an
 * arbitrarily long key costs a bounded amount of memory.
 */
function slotFor(key: string): number {
  const digest = createHash("sha256").update(key).digest();
  return digest.readUInt32LE(0) & SLOT_MASK;
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
  const slot = slotFor(key);

  // Window elapsed (or slot never used): start a fresh window.
  if (resetAt[slot] <= now) {
    counts[slot] = 1;
    resetAt[slot] = now + options.windowMs;
    return { allowed: true, remaining: options.limit - 1, retryAfterSeconds: 0 };
  }

  // Saturate rather than wrap: a sustained flood must not roll Int32 negative
  // and hand out a fresh budget.
  if (counts[slot] < 0x7fffffff) counts[slot] += 1;

  if (counts[slot] > options.limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt[slot] - now) / 1000)),
    };
  }
  return {
    allowed: true,
    remaining: options.limit - counts[slot],
    retryAfterSeconds: 0,
  };
}

/** Test-only reset so suites do not leak counters between cases. */
export function resetRateLimits(): void {
  counts.fill(0);
  resetAt.fill(0);
}
