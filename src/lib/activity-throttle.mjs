/**
 * Bounded once-per-window throttle for the proxy's last_active_at write.
 *
 * The original unbounded Map leaked one entry per user for the lifetime of the
 * process. A later fixed-slot hash table bounded memory but could make two
 * distinct UUIDs indistinguishable when both its slot and truncated tag
 * collided. That low-probability collision suppressed a real activity signal.
 *
 * This bounded LRU keeps full verified user ids, so distinct users are never
 * aliases. At capacity the oldest entry is evicted; eviction can only cause one
 * extra database write, never a lost activity signal. The throttle is advisory
 * and process-local, while the memory bound is exact.
 */

export const ACTIVITY_THROTTLE_SLOTS = 4096;

/** @type {Map<string, number>} */
const stamps = new Map();

export function shouldRecordActivity(key, windowMs, now = Date.now()) {
  const stamped = stamps.get(key);
  if (stamped !== undefined && stamped <= now && now - stamped <= windowMs) {
    return false;
  }

  if (stamped !== undefined) stamps.delete(key);
  while (stamps.size >= ACTIVITY_THROTTLE_SLOTS) {
    const oldest = stamps.keys().next().value;
    if (oldest === undefined) break;
    stamps.delete(oldest);
  }
  stamps.set(key, now);
  return true;
}

export function resetActivityThrottle() {
  stamps.clear();
}

export function activityThrottleSize() {
  return stamps.size;
}
