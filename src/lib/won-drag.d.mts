type FetchImpl = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
type StageDragResult =
  | { ok: true; lead: { stage?: string | null; final_status?: string | null } | null }
  | { ok: false; needsAmount: boolean; error: string; error_zh: string; reasons?: string[]; reasons_zh?: string[] };

export const DRAG_CLOSE_STAGES: readonly ["won", "lost"];
export function leadHasWonAmount(lead: object | null | undefined): boolean;
export function submitWonFromDrag(
  fetchImpl: FetchImpl,
  leadId: string,
  input: { note: string; amount?: string; idempotencyKey: string },
): Promise<StageDragResult>;
export function submitStageFromDrag(
  fetchImpl: FetchImpl,
  leadId: string,
  input: { stage: "won" | "lost"; note: string; amount?: string; idempotencyKey: string },
): Promise<StageDragResult>;
