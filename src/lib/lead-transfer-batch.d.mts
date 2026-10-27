export declare const LEAD_TRANSFER_BATCH_KEY_PATTERN: RegExp;

export declare function readLeadTransferBatchKey(input: {
  body?: unknown;
  headerValue?: string | null;
}): string | null;

export declare function deriveLeadTransferKey(batchKey: string, leadId: string): string;

export declare function isLeadUpdatedAtToken(value: unknown): value is string;

export declare function isLeadTransferConflict(
  error: { message?: string | null; details?: string | null; hint?: string | null } | null | undefined,
): boolean;

export declare function classifyLeadReassignResult(
  result: unknown,
): "transferred" | "replayed" | "unchanged";
