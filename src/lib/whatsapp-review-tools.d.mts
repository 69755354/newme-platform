export const REVIEW_SANDBOX: Readonly<{ appId: string; wabaId: string; phoneId: string; sender: string; recipient: string }>;
export const REVIEW_TEMPLATE_BODY: string;
export const REVIEW_ACTIONS: readonly string[];
export type ReviewAction = "check_connection" | "send_hello_world" | "create_template";
export type ReviewResult = { ok: true; action: ReviewAction; environment?: string; message_id?: string; delivery?: string; template_id?: string; template_name?: string; template_status?: string };
export function reviewToolsConfig(env?: NodeJS.ProcessEnv, now?: number): { enabled: boolean; until: string | null; environment: string; recipient_suffix: string };
export class ReviewToolsError extends Error {
  code: string; status: number; metaCode?: number; uncertain: boolean;
  constructor(code: string, options?: { status?: number; metaCode?: number; uncertain?: boolean });
}
export function performReviewAction(action: ReviewAction, requestId: string, options?: { env?: NodeJS.ProcessEnv; now?: number; fetchImpl?: typeof fetch }): Promise<ReviewResult>;
export function runReviewAttempt(actor: string, action: ReviewAction, requestId: string, work: () => Promise<ReviewResult>, now?: number): Promise<ReviewResult>;
