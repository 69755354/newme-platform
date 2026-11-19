// Shared server helpers for the opportunity and visit routes (S23). Every route authenticates first, checks
// the role before any service-role query, never caches, and answers database errors with stable codes only.
import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { logger } from "@/lib/logger";
import {
  applyRequestAuthCookies, getRequestAuthContext, RequestAuthError, requestAuthErrorResponse, type RequestAuthContext,
} from "@/lib/request-auth-context";
import { canWorkOnLead, mapDbError, visitReportStatus, type OpportunityStage } from "@/lib/opportunity-visit.mjs";

export type Respond = (body: Record<string, unknown>, init?: ResponseInit) => NextResponse;
export interface ApiCall {
  context: RequestAuthContext;
  respond: Respond;
  /** Reads with the caller's own session, so row-level security applies. */
  db: SupabaseClient;
}
export class ApiFailure extends Error {
  constructor(readonly status: number, readonly code: string, readonly extra: Record<string, unknown> = {}) { super(code); }
}

export const LIMIT_DEFAULT = 50;
export const LIMIT_MAX = 200;

export function pageParams(url: URL) {
  const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get("limit") ?? "", 10) || LIMIT_DEFAULT, 1), LIMIT_MAX);
  const offset = Math.max(Number.parseInt(url.searchParams.get("offset") ?? "", 10) || 0, 0);
  return { limit, offset };
}

export async function handle(
  request: NextRequest,
  operation: string,
  run: (call: ApiCall) => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    const context = await getRequestAuthContext(request);
    const respond: Respond = (body, init) => applyRequestAuthCookies(
      context,
      NextResponse.json(body, { ...init, headers: { "Cache-Control": "private, no-store" } }),
    );
    try {
      return await run({ context, respond, db: context.supabase as unknown as SupabaseClient });
    } catch (error) {
      if (error instanceof ApiFailure) return respond({ error: error.code, ...error.extra }, { status: error.status });
      if (error instanceof RequestAuthError) throw error;
      const mapped = mapDbError(error as { code?: string; message?: string });
      logger.error({ operation, code: String((error as { code?: string })?.code ?? "unknown") }, "opportunity or visit request failed");
      return respond({ error: mapped.code }, { status: mapped.status });
    }
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error);
    logger.error({ operation, code: "unexpected" }, "opportunity or visit request failed");
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch { /* answered below */ }
  throw new ApiFailure(400, "invalid_request");
}

export function invalid(errors: Record<string, string>): never {
  throw new ApiFailure(422, "validation_failed", { fields: errors });
}

export async function loadLead(leadId: string): Promise<{ id: string; assigned_to: string | null; archived: boolean | null }> {
  const { data, error } = await supabaseAdmin.from("leads").select("id, assigned_to, archived").eq("id", leadId).maybeSingle();
  if (error) throw error;
  if (!data) throw new ApiFailure(404, "unknown_lead");
  return data as { id: string; assigned_to: string | null; archived: boolean | null };
}

/** Role check first (cheap, no query), then the lead check. A sales user may only work on an assigned lead. */
export async function requireLeadAccess(context: RequestAuthContext, leadId: string) {
  if (!["admin", "boss", "operator", "sales"].includes(context.role)) throw new ApiFailure(403, "forbidden");
  const lead = await loadLead(leadId);
  if (!canWorkOnLead(context.role, context.user.id, lead)) throw new ApiFailure(403, "forbidden");
  return lead;
}

export async function loadStages(db: SupabaseClient): Promise<(OpportunityStage & { label_en: string; label_zh: string; sort_order: number; is_closed: boolean })[]> {
  const { data, error } = await db.from("opportunity_stages")
    .select("key, label_en, label_zh, sort_order, requires_quote, is_closed, active").order("sort_order");
  if (error) throw error;
  return (data ?? []) as never;
}

export const withStatus = <T extends Record<string, unknown>>(visit: T) => ({
  ...visit,
  status: visitReportStatus(visit as never),
});
