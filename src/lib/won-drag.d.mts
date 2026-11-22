export function leadHasWonAmount(lead: object | null | undefined): boolean;
export function submitWonFromDrag(
  fetchImpl: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; json: () => Promise<any> }>,
  leadId: string,
  input: { note: string; amount?: string; idempotencyKey: string },
): Promise<
  | { ok: true; lead: { stage?: string | null; final_status?: string | null } | null }
  | { ok: false; needsAmount: boolean; error: string; error_zh: string }
>;
