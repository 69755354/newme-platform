export function reassignFailureKey(status: number, code: unknown): string;
export function reassignNeedsReload(status: number, code: unknown): boolean;
export function applyReassignResult<T extends { updated_at?: string | null }>(
  lead: T,
  input: { assignedTo: string; repName: string; result: unknown },
): T & { assigned_to: string; rep_name: string; updated_at: string | null | undefined };
