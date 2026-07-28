// RBAC: user (admin, boss)
import { NextRequest, NextResponse } from "next/server";
import {
  applyRequestAuthCookies,
  getRequestAuthContext,
  RequestAuthError,
} from "@/lib/request-auth-context";
import { logger } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase-admin";

// POST /api/admin/impersonate
// Admin generates a magic link to sign in as another user
export async function POST(request: NextRequest) {
  let context;
  try {
    context = await getRequestAuthContext(request);
  } catch (error) {
    if (error instanceof RequestAuthError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: "auth_unavailable" }, { status: 503 });
  }

  // Verify caller is admin or boss
  if (!["admin", "boss"].includes(context.role)) {
    return applyRequestAuthCookies(
      context,
      NextResponse.json({ error: "forbidden" }, { status: 403 }),
    );
  }

  let targetUserId: unknown;
  try {
    ({ targetUserId } = await request.json());
  } catch {
    return applyRequestAuthCookies(
      context,
      NextResponse.json({ error: "invalid_request" }, { status: 400 }),
    );
  }
  if (typeof targetUserId !== "string" || targetUserId.length === 0) {
    return applyRequestAuthCookies(
      context,
      NextResponse.json({ error: "targetUserId_required" }, { status: 400 }),
    );
  }

  try {
    // Verify target user exists
    const { data: targetProfile, error: targetProfileError } = await supabaseAdmin
      .from("profiles")
      .select("id, email, full_name, role")
      .eq("id", targetUserId)
      .single();

    if (targetProfileError || !targetProfile) {
      return applyRequestAuthCookies(
        context,
        NextResponse.json({ error: "target_not_found" }, { status: 404 }),
      );
    }

    // Generate magic link for target user
    const { data, error } = await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email: targetProfile.email,
      options: {
        redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL || "https://app.newme.ae"}/auth/callback`,
      },
    });

    if (error) {
      logger.error(
        { request_id: context.requestId, operation: "admin_impersonate_generate_link", err: error },
        "Unable to generate impersonation link",
      );
      return applyRequestAuthCookies(
        context,
        NextResponse.json({ error: "internal_error" }, { status: 500 }),
      );
    }

    // Log to audit_logs (graceful degradation if table not yet created)
    // NOTE: audit_logs.actor_id is the genuine column (NOT a business_events alias).
    // Migration 20260613000000_audit_logs.sql:6 declares it. Unlike business_events
    // (where actor_id was the wrong alias), audit_logs always used actor_id. Do NOT rename.
    supabaseAdmin.from("audit_logs").insert({
      actor_id: context.user.id,
      actor_email: context.user.email,
      action: "impersonate",
      target_type: "user",
      target_id: targetUserId,
      details: {
        actor_name: context.profile.full_name,
        actor_role: context.role,
        target_name: targetProfile.full_name,
        target_role: targetProfile.role,
      },
    }).then(({ error: auditError }) => {
      if (auditError) {
        logger.warn(
          { request_id: context.requestId, operation: "admin_impersonate_audit", err: auditError },
          "Failed to record impersonation audit event",
        );
      }
    });

    return applyRequestAuthCookies(context, NextResponse.json({
      url: data.properties?.action_link,
      targetUser: {
        id: targetProfile.id,
        email: targetProfile.email,
        full_name: targetProfile.full_name,
        role: targetProfile.role,
      },
    }));
  } catch (error) {
    logger.error(
      { request_id: context.requestId, operation: "admin_impersonate", err: error },
      "Admin impersonation failed",
    );
    return applyRequestAuthCookies(
      context,
      NextResponse.json({ error: "internal_error" }, { status: 500 }),
    );
  }
}
