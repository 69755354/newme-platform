/**
 * Simple in-memory response cache for server-side API routes.
 *
 * TTL in seconds. Not distributed — each Next.js instance has its own Map, so two
 * instances answer the same request from two different snapshots.
 *
 * ── What this cache may NOT hold ───────────────────────────────────────────────
 *
 * Anything derived from money: payments, payment_allocations, installment_plans,
 * kpi_targets, or contracts.first_payment_status / contract_amount.
 *
 * Round-4 finding R5. There is no invalidation path here, and there cannot be a
 * cheap one:
 *
 *   * nothing is exported that evicts a key. A write can only wait the TTL out.
 *   * `revalidatePath()`, which the payment write paths do call, invalidates
 *     Next's own render and fetch caches. It cannot reach module state in this
 *     file, so a route that consults this Map keeps answering from it for the rest
 *     of the TTL no matter how many paths are revalidated.
 *   * the keys are per-role/per-user/per-filter/per-page strings, so evicting
 *     "everything a payment could have changed" means a prefix sweep across keys
 *     several routes compose independently — and the write paths that would have to
 *     call it are server actions and RPC routes that do not know those key shapes.
 *
 * The measurable consequence, which is why the money routes were changed rather
 * than given an eviction API: confirm a payment and reload, and the dashboard
 * totals, the pipeline actuals, the analytics revenue and the contracts list's
 * first-payment badges keep showing the pre-confirmation figures for up to 30
 * seconds — while the payments page, which is force-dynamic, shows the new one. Two
 * pages, two answers, same money. void_payment() and allocate_payment() have the
 * same window in the other direction.
 *
 * So every money-reading route is force-dynamic and answers through
 * applyPrivateNoStore() instead, joining payments/list and leads/list, which were
 * already exempted for this reason. The rule is stated here as a rule rather than as
 * a list of route names on purpose: a list goes stale the moment a new route selects
 * a payments column, and a route that is missing from a list looks compliant.
 * tests/security/api-cache-money-boundary.test.mjs derives the set from what each
 * route actually queries — `from("payments")` and the embedded forms alike — and
 * fails if one of them imports this module again.
 *
 * Lead, task, team and alert reads still cache: a 30-second-old follow-up count is
 * a stale count, not a wrong ledger.
 *
 * @template T
 * @typedef {{ data: T, expiry: number }} CacheEntry
 */

/** @type {Map<string, CacheEntry<unknown>>} */
const store = new Map();
export const MAX_CACHE_ENTRIES = 4096;

/**
 * The cached value for `key`, or null if absent or expired.
 *
 * @template T
 * @param {string} key
 * @returns {T | null}
 */
export function getCached(key) {
  const entry = /** @type {CacheEntry<T> | undefined} */ (store.get(key));
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    store.delete(key);
    return null;
  }
  return entry.data;
}

/**
 * @template T
 * @param {string} key
 * @param {T} data
 * @param {number} ttlSeconds
 * @returns {void}
 */
export function setCache(key, data, ttlSeconds) {
  // Map preserves insertion order. Refreshing an existing key makes it newest;
  // a new key at capacity evicts exactly one oldest entry. Memory is therefore
  // bounded even when callers compose arbitrary filter strings into keys.
  if (store.has(key)) store.delete(key);
  while (store.size >= MAX_CACHE_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
  store.set(key, { data, expiry: Date.now() + ttlSeconds * 1000 });
}

/**
 * How many entries are held, expired ones included.
 *
 * Exported for tests/security/api-cache-money-boundary.test.mjs, which measures
 * the staleness window and the sweeper rather than asserting them from this text.
 * Deliberately not an eviction API: see the header.
 *
 * @returns {number}
 */
export function cacheSize() {
  return store.size;
}

/** Periodic cleanup — runs every 5 minutes, removes expired entries */
if (typeof setInterval !== "undefined") {
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now > entry.expiry) store.delete(key);
    }
  }, 5 * 60 * 1000);
  // A repeating timer holds Node's event loop open, so importing this module from
  // `node --test` would stop the runner from ever exiting. The sweeper is
  // housekeeping — nothing waits on it — and the getter above already expires an
  // entry on read, so unreferencing it changes no observable behaviour.
  sweeper?.unref?.();
}
