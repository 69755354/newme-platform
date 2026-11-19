// Shared server helpers for the dispatch and duplicate routes (S24). Every route authenticates first, checks the
// role before any service-role query, never caches, and answers database errors with stable codes only.
// Writes never happen here: every change goes through a database routine that checks the actor again.
import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { logger } from "@/lib/logger";
import {
  applyRequestAuthCookies, getRequestAuthContext, RequestAuthError, requestAuthErrorResponse, type RequestAuthContext,
} from "@/lib/request-auth-context";
import { canDecide, mapDbError } from "@/lib/lead-dispatch.mjs";

export type Respond = (body: Record<string, unknown>, init?: ResponseInit) => NextResponse;
export interface ApiCall { context: RequestAuthContext; respond: Respond }
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
  request: NextRequest | Request,
  operation: string,
  run: (call: ApiCall) => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    const context = await getRequestAuthContext(request as NextRequest);
    const respond: Respond = (body, init) => applyRequestAuthCookies(
      context,
      NextResponse.json(body, { ...init, headers: { "Cache-Control": "private, no-store" } }),
    );
    try {
      return await run({ context, respond });
    } catch (error) {
      if (error instanceof ApiFailure) return respond({ error: error.code, ...error.extra }, { status: error.status });
      if (error instanceof RequestAuthError) throw error;
      const mapped = mapDbError(error as { code?: string; message?: string });
      logger.error({ operation, code: String((error as { code?: string })?.code ?? "unknown") }, "dispatch request failed");
      return respond({ error: mapped.code }, { status: mapped.status });
    }
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error);
    logger.error({ operation, code: "unexpected" }, "dispatch request failed");
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

/** The role check comes first and costs no query. */
export function requireStaff(context: RequestAuthContext) {
  if (!canDecide(context.role)) throw new ApiFailure(403, "forbidden");
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

/** Only these lead columns reach the workbench: no free-text notes, no raw import data. */
export const LEAD_COLUMNS = "id, customer_name, phone, email, source, source_channel, assigned_to, created_at, archived";
type LeadRow = { id: string } & Record<string, unknown>;

export async function loadLeads(ids: string[]): Promise<Map<string, LeadRow>> {
  const map = new Map<string, LeadRow>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return map;
  const { data, error } = await supabaseAdmin.from("leads").select(LEAD_COLUMNS).in("id", unique);
  if (error) throw error;
  for (const row of (data ?? []) as LeadRow[]) map.set(row.id, row);
  return map;
}

export { supabaseAdmin };
