export declare const LEAD_REBALANCE_PENDING_BATCH_KEY: string;
export declare function leadRebalancePendingBatchStorageKey(actorId: string): string;

export declare function acquireLeadRebalanceBatchKey(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  actorId: string,
  createKey: () => string,
): string;

export declare function clearLeadRebalanceBatchKey(
  storage: Pick<Storage, "getItem" | "removeItem">,
  actorId: string,
  completedKey: string,
): boolean;
