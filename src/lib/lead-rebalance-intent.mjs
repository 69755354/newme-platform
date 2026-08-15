export const LEAD_REBALANCE_PENDING_BATCH_KEY = "newme:lead-rebalance:pending-batch-v1";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Return the tab's durable pending rebalance key, creating and verifying it once.
 * Storage failures are fatal: sending a request whose key cannot survive a page
 * reload would recreate the partial-success replanning defect.
 */
export function leadRebalancePendingBatchStorageKey(actorId) {
  if (typeof actorId !== "string" || !UUID_PATTERN.test(actorId.trim())) {
    throw new Error("rebalance actor id is invalid");
  }
  return `${LEAD_REBALANCE_PENDING_BATCH_KEY}:${actorId.trim().toLowerCase()}`;
}

export function acquireLeadRebalanceBatchKey(storage, actorId, createKey) {
  if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
    throw new Error("rebalance session storage is unavailable");
  }
  const storageKey = leadRebalancePendingBatchStorageKey(actorId);
  const stored = storage.getItem(storageKey);
  if (typeof stored === "string" && UUID_PATTERN.test(stored.trim())) {
    return stored.trim().toLowerCase();
  }
  if (stored !== null) storage.removeItem(storageKey);
  const created = typeof createKey === "function" ? createKey() : "";
  if (typeof created !== "string" || !UUID_PATTERN.test(created)) {
    throw new Error("rebalance key generator did not return a uuid");
  }
  const normalized = created.toLowerCase();
  storage.setItem(storageKey, normalized);
  if (storage.getItem(storageKey) !== normalized) {
    throw new Error("rebalance session storage did not retain the pending key");
  }
  return normalized;
}

/** Clear only the intent whose successful response was observed. */
export function clearLeadRebalanceBatchKey(storage, actorId, completedKey) {
  if (!storage || typeof storage.getItem !== "function" || typeof storage.removeItem !== "function") {
    throw new Error("rebalance session storage is unavailable");
  }
  const storageKey = leadRebalancePendingBatchStorageKey(actorId);
  const stored = storage.getItem(storageKey);
  if (typeof stored !== "string" || stored.toLowerCase() !== String(completedKey).toLowerCase()) {
    return false;
  }
  storage.removeItem(storageKey);
  return storage.getItem(storageKey) === null;
}
