// RBAC: admin, boss (the database routine set_leave_cover refuses every other role with 42501)
// POST /api/team/leave-cover { userId, coverUserId, start, end }   set a leave cover; coverUserId null clears it
// GET  /api/team/leave-cover                                       whether cover routing is switched on
// S43 (B13). The write goes through the caller's own identity (auth.uid() inside the routine), never service role.
import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { leaveCoverEnabled } from "@/lib/leave-cover.mjs";
import {
  applyRequestAuthCookies, getRequestAuthContext, RequestAuthError, requestAuthErrorResponse,
} from "@/lib/request-auth-context";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED = new Set(["admin", "boss"]);

export async function GET(request: NextRequest) {
  try {
    const context = await getRequestAuthContext(request);
    const respond = (body: Record<string, unknown>, init?: ResponseInit) =>
      applyRequestAuthCookies(context, NextResponse.json(body, { ...init, headers: { "Cache-Control": "private, no-store" } }));
    if (!ALLOWED.has(context.role)) return respond({ error: "Forbidden" }, { status: 403 });
    return respond({ enabled: leaveCoverEnabled() });
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error);
    return NextResponse.json({ error: "Leave cover read failed" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const context = await getRequestAuthContext(request);
    const respond = (body: Record<string, unknown>, init?: ResponseInit) =>
      applyRequestAuthCookies(context, NextResponse.json(body, { ...init, headers: { "Cache-Control": "private, no-store" } }));
    if (!ALLOWED.has(context.role)) return respond({ error: "Forbidden" }, { status: 403 });

    let body: { userId?: unknown; coverUserId?: unknown; start?: unknown; end?: unknown } = {};
    try { body = await request.json(); } catch { return respond({ error: "invalid_request" }, { status: 400 }); }
    const userId = typeof body.userId === "string" ? body.userId : "";
    const coverUserId = body.coverUserId == null || body.coverUserId === "" ? null : String(body.coverUserId);
    const start = body.start == null || body.start === "" ? null : String(body.start);
    const end = body.end == null || body.end === "" ? null : String(body.end);
    if (!UUID.test(userId)) return respond({ error: "invalid_request" }, { status: 400 });
    if (coverUserId !== null) {
      if (!UUID.test(coverUserId)) return respond({ error: "invalid_request" }, { status: 400 });
      if (coverUserId === userId) return respond({ error: "leave_cover_self" }, { status: 400 });
      if (!start || !end || !DATE.test(start) || !DATE.test(end) || end < start) return respond({ error: "leave_cover_dates" }, { status: 400 });
    }

    const { data, error } = await context.supabase.rpc("set_leave_cover", {
      p_user: userId,
      p_cover: coverUserId,
      p_start: coverUserId ? start : null,
      p_end: coverUserId ? end : null,
    });
    if (error) {
      const code = String(error.message ?? "").replace(/[^a-z_]/g, "") || "leave_cover_failed";
      const status = error.code === "42501" ? 403 : error.code === "22023" ? 400 : 500;
      return respond({ error: code }, { status });
    }
    return respond({ ok: true, cover: data, enabled: leaveCoverEnabled() });
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error);
    logger.error({ operation: "leave_cover_write", code: error instanceof Error ? error.message : "unknown" }, "leave cover write failed");
    return NextResponse.json({ error: "Leave cover write failed" }, { status: 500 });
  }
}
