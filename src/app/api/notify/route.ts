// RBAC: authenticated actor; event authorization and recipients are derived from persisted facts.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  applyRequestAuthCookies,
  getRequestAuthContext,
  RequestAuthError,
  requestAuthErrorResponse,
} from "@/lib/request-auth-context";
import {
  deriveNotificationDispatch,
  NotificationDispatchError,
  type NotificationEventInput,
} from "@/lib/notification-events";
import { createNotificationsBulk, VALID_NOTIFICATION_TYPES } from "@/lib/notifications";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type { Database } from "@/types/database";

const MAX_REQUEST_BYTES = 4_096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonError(error: NotificationDispatchError) {
  return NextResponse.json({ error: error.code }, { status: error.status });
}

/**
 * Accept only an event type and the identifiers needed to look up that event.
 * Presentation and recipients are derived from persisted business facts.
 */
export async function POST(request: NextRequest) {
  try {
    const context = await getRequestAuthContext(request);
    const respond = (body: Record<string, unknown>, init?: ResponseInit) =>
      applyRequestAuthCookies(context, NextResponse.json(body, init));

    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      return respond({ error: "notification_request_too_large" }, { status: 413 });
    }

    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES) {
      return respond({ error: "notification_request_too_large" }, { status: 413 });
    }
    let body: unknown = null;
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = null;
    }
    if (!isRecord(body) || typeof body.type !== "string") {
      return respond({ error: "invalid_notification_request" }, { status: 400 });
    }
    // Lead assignment is already persisted by the canonical reassignment RPC in
    // the same transaction as the ownership change. It has no client dispatch
    // caller or independent occurrence key, so exposing it here would let an
    // operator replay somebody else's current assignment as notification spam.
    if (body.type === "lead_assigned" || !VALID_NOTIFICATION_TYPES.includes(body.type as never)) {
      return respond({ error: "invalid_notification_type" }, { status: 400 });
    }

    const drafts = await deriveNotificationDispatch({
      db: supabaseAdmin as SupabaseClient<Database>,
      actor: {
        id: context.user.id,
        role: context.role,
        fullName: context.profile.full_name || context.profile.email || "User",
      },
      input: body as NotificationEventInput,
    });
    const result = await createNotificationsBulk(drafts);
    return respond({ success: true, created: result.created, skipped: result.skipped });
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error);
    if (error instanceof NotificationDispatchError) return jsonError(error);
    console.error("notification_dispatch_failed", error instanceof Error ? error.message : "unknown_error");
    return NextResponse.json({ error: "notification_dispatch_failed" }, { status: 503 });
  }
}
