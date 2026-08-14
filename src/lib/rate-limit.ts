import { createHmac, randomBytes } from "node:crypto";

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
 * is gone. Keys are hashed into a fixed, four-way set-associative table:
 *
 *   * memory is bounded by construction — no eviction policy exists to get
 *     wrong, and no request can ever cause another key's counter to be dropped;
 *   * every operation is O(1) — no sweep, so cost does not depend on traffic;
 *   * only a process-keyed 64-bit fingerprint is retained, so no caller-supplied
 *     string (and no email address) is held in memory at all.
 *
 * Distinct keys never share a counter merely because they land in the same set.
 * An entry that has reached its allowance is protected until its window expires;
 * an entry still below its allowance may be replaced when all four ways are in
 * use. If all four ways are protected, the new key fails closed until the first
 * protected window expires. The process-random HMAC key prevents an anonymous
 * caller from precomputing a chosen set collision from this public source tree.
 */

const SLOT_COUNT = 16384;
const WAY_COUNT = 4;
const SET_COUNT = SLOT_COUNT / WAY_COUNT;
const SET_MASK = SET_COUNT - 1;
const HASH_KEY = randomBytes(32);

// Parallel arrays rather than objects: fixed allocation, no per-entry GC.
const counts = new Int32Array(SLOT_COUNT);
const resetAt = new Float64Array(SLOT_COUNT);
const limits = new Float64Array(SLOT_COUNT);
const windowMs = new Float64Array(SLOT_COUNT);
const fingerprintHigh = new Uint32Array(SLOT_COUNT);
const fingerprintLow = new Uint32Array(SLOT_COUNT);

/**
 * Client identity for limiting. The release nginx config always overwrites
 * X-Real-IP with its post-realip-module `$remote_addr`: for a trusted Cloudflare
 * peer that is the validated CF-Connecting-IP, and for a direct origin request it
 * is the actual TCP peer. Prefer that derived value over either caller-supplied
 * forwarding header. The fallbacks cover local tests and deployments that have
 * not yet installed the canonical nginx asset.
 */
export function clientIdentifier(request: Request): string {
  return (
    request.headers.get("x-real-ip")?.trim()
    || request.headers.get("cf-connecting-ip")?.trim()
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown"
  );
}

/**
 * Map a key of any length to one set and a 64-bit identity tag. The HMAC key is
 * generated per process and never exposed, so the public key format does not let
 * a caller calculate a chosen collision. The input itself is not retained.
 */
function identityFor(key: string): {
  setStart: number;
  high: number;
  low: number;
} {
  const digest = createHmac("sha256", HASH_KEY).update(key).digest();
  return {
    setStart: (digest.readUInt32LE(0) & SET_MASK) * WAY_COUNT,
    high: digest.readUInt32LE(4),
    low: digest.readUInt32LE(8),
  };
}

function startWindow(
  slot: number,
  identity: { high: number; low: number },
  options: { limit: number; windowMs: number },
  now: number,
): RateLimitResult {
  fingerprintHigh[slot] = identity.high;
  fingerprintLow[slot] = identity.low;
  counts[slot] = 1;
  resetAt[slot] = now + options.windowMs;
  limits[slot] = options.limit;
  windowMs[slot] = options.windowMs;
  return { allowed: true, remaining: options.limit - 1, retryAfterSeconds: 0 };
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
  const identity = identityFor(key);
  let matchingSlot = -1;
  let emptySlot = -1;
  let replaceableSlot = -1;
  let protectedReset = Number.POSITIVE_INFINITY;

  for (let way = 0; way < WAY_COUNT; way += 1) {
    const slot = identity.setStart + way;
    if (resetAt[slot] <= now) {
      if (emptySlot === -1) emptySlot = slot;
      continue;
    }
    if (
      fingerprintHigh[slot] === identity.high
      && fingerprintLow[slot] === identity.low
    ) {
      matchingSlot = slot;
      break;
    }
    // Once a key has consumed its complete allowance, keep its identity until
    // expiry. That prevents a distinct-key flood from evicting an exhausted
    // victim and restoring a brute-force budget.
    if (counts[slot] < limits[slot]) {
      if (
        replaceableSlot === -1
        || resetAt[slot] < resetAt[replaceableSlot]
      ) {
        replaceableSlot = slot;
      }
    } else {
      protectedReset = Math.min(protectedReset, resetAt[slot]);
    }
  }

  if (matchingSlot === -1) {
    const available = emptySlot !== -1 ? emptySlot : replaceableSlot;
    if (available !== -1) return startWindow(available, identity, options, now);
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((protectedReset - now) / 1000)),
    };
  }

  const slot = matchingSlot;
  // The same logical key must not be reused with a weaker policy while its
  // bucket is active.
  if (limits[slot] !== options.limit || windowMs[slot] !== options.windowMs) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt[slot] - now) / 1000)),
    };
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
  limits.fill(0);
  windowMs.fill(0);
  fingerprintHigh.fill(0);
  fingerprintLow.fill(0);
}
