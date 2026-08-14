import { createHmac, randomBytes } from "node:crypto";

/**
 * Sliding-window rate limiter over fixed-size, process-keyed Count-Min sketches.
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
 * All three are structural consequences of a growable, keyed table. A later
 * four-way cache removed the memory leak but introduced another bypass: an
 * active bucket below its limit was replaceable, so a distinct-key flood could
 * reset a victim from 7/8 attempts back to 1/8. Protecting every cache entry
 * would instead turn cardinality into a global login-denial switch.
 *
 * The rolling sketches have neither failure mode:
 *
 *   * counters are never evicted inside their window, so traffic cannot restore
 *     a consumed budget;
 *   * collisions only increase an estimate. They can conservatively refuse a
 *     request but can never grant an extra attempt;
 *   * account and IP policies have separate developer-chosen namespaces, so a
 *     high-cardinality account stream cannot contaminate the IP boundary;
 *   * memory and work are bounded, and only process-keyed hashes are retained.
 *
 * Thirty-two time slices bound the sliding-window approximation to less than
 * one slice. The process-random HMAC key prevents a remote caller from choosing
 * collisions from the public source tree.
 */

const SKETCH_WIDTH = 1 << 16;
const SKETCH_MASK = SKETCH_WIDTH - 1;
const SKETCH_DEPTH = 4;
const TIME_SLICES = 32;
const MAX_NAMESPACES = 8;
const HASH_KEY = randomBytes(32);

type RateLimitOptions = {
  limit: number;
  windowMs: number;
  /** A static call-site name. Never pass caller-controlled input here. */
  namespace?: string;
};

type NamespaceState = {
  counts: Uint8Array;
  generations: Int32Array;
  limit: number;
  namespace: string;
  originAt: number;
  sliceMs: number;
  windowMs: number;
};

const namespaceStates = new Map<string, NamespaceState>();

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

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

function refusal(retryAfterSeconds: number): RateLimitResult {
  return {
    allowed: false,
    remaining: 0,
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)),
  };
}

function stateFor(options: RateLimitOptions, now: number): NamespaceState | null {
  const namespace = options.namespace ?? "default";
  if (
    !Number.isSafeInteger(options.limit)
    || options.limit < 1
    || options.limit > 255
    || !Number.isFinite(options.windowMs)
    || options.windowMs < TIME_SLICES
    || typeof namespace !== "string"
    || namespace.length < 1
    || namespace.length > 64
  ) {
    return null;
  }

  const existing = namespaceStates.get(namespace);
  if (existing) {
    if (existing.limit !== options.limit || existing.windowMs !== options.windowMs) return null;
    if (now < existing.originAt) {
      existing.counts.fill(0);
      existing.generations.fill(-1);
      existing.originAt = now;
    }
    return existing;
  }
  if (namespaceStates.size >= MAX_NAMESPACES) return null;

  const state: NamespaceState = {
    counts: new Uint8Array(TIME_SLICES * SKETCH_DEPTH * SKETCH_WIDTH),
    generations: new Int32Array(TIME_SLICES),
    limit: options.limit,
    namespace,
    originAt: now,
    sliceMs: Math.ceil(options.windowMs / TIME_SLICES),
    windowMs: options.windowMs,
  };
  state.generations.fill(-1);
  namespaceStates.set(namespace, state);
  return state;
}

function counterOffset(slice: number, depth: number, index: number): number {
  return ((slice * SKETCH_DEPTH + depth) * SKETCH_WIDTH) + index;
}

function indicesFor(namespace: string, key: string): number[] {
  const digest = createHmac("sha256", HASH_KEY)
    .update(namespace)
    .update("\0")
    .update(key)
    .digest();
  return [0, 4, 8, 12].map((offset) => digest.readUInt32LE(offset) & SKETCH_MASK);
}

export function consumeRateLimit(
  key: string,
  options: RateLimitOptions,
  now: number = Date.now(),
): RateLimitResult {
  const safeNow = Number.isFinite(now) ? now : Date.now();
  const state = stateFor(options, safeNow);
  if (!state) return refusal(options.windowMs / 1000);

  const generation = Math.floor((safeNow - state.originAt) / state.sliceMs);
  const currentSlice = generation % TIME_SLICES;
  if (state.generations[currentSlice] !== generation) {
    const start = currentSlice * SKETCH_DEPTH * SKETCH_WIDTH;
    state.counts.fill(0, start, start + SKETCH_DEPTH * SKETCH_WIDTH);
    state.generations[currentSlice] = generation;
  }

  const indices = indicesFor(state.namespace, key);
  const oldestGeneration = Math.max(0, generation - TIME_SLICES + 1);
  let estimate = Number.POSITIVE_INFINITY;
  for (let depth = 0; depth < SKETCH_DEPTH; depth += 1) {
    let depthTotal = 0;
    for (let active = oldestGeneration; active <= generation; active += 1) {
      const slice = active % TIME_SLICES;
      if (state.generations[slice] !== active) continue;
      depthTotal += state.counts[counterOffset(slice, depth, indices[depth])];
    }
    estimate = Math.min(estimate, depthTotal);
  }

  for (let depth = 0; depth < SKETCH_DEPTH; depth += 1) {
    const offset = counterOffset(currentSlice, depth, indices[depth]);
    if (state.counts[offset] < 255) state.counts[offset] += 1;
  }

  const nextEstimate = estimate + 1;
  if (nextEstimate > state.limit) {
    // This upper bound waits until every contribution visible in the current
    // slice has left the rolling window. It may be stricter than necessary after
    // a collision, but it never promises a retry time that restores budget early.
    const fullyResetAt = state.originAt + (generation + TIME_SLICES) * state.sliceMs;
    return refusal((fullyResetAt - safeNow) / 1000);
  }
  return {
    allowed: true,
    remaining: state.limit - nextEstimate,
    retryAfterSeconds: 0,
  };
}

/** Test-only reset so suites do not leak counters between cases. */
export function resetRateLimits(): void {
  namespaceStates.clear();
}
