export declare function ensurePendingApproval(
  admin: { from(table: string): unknown },
  input: { contractId: string; step: "admin_review" | "ceo_review"; source: string },
): Promise<{ created: boolean; error?: { message?: string } }>;
