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
// Admin generates a magic link to sign in as another user.
// This legacy internal-admin endpoint is not a platform-support role model.
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

  // Verify caller is admin or boss.
  if (!["admin", "boss"].includes(context.role)) {
    return applyRequestAuthCookies(
      context,
      NextResponse.json({ error: "forbidden" }, { status: 403 }),
    );
  }

  const payload: unknown = await request.json().catch(() => null);
  const input = payload && typeof payload === "object"
    ? payload as { targetUserId?: unknown; reason?: unknown }
    : {};
  const targetUserId = typeof input.targetUserId === "string" ? input.targetUserId.trim() : "";
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";

  if (!targetUserId) {
    return applyRequestAuthCookies(
      context,
      NextResponse.json({ error: "targetUserId required" }, { status: 400 }),
    );
  }

  if (!reason) {
    return applyRequestAuthCookies(
      context,
      NextResponse.json({ error: "reason required" }, { status: 400 }),
    );
  }

  try {
    // Verify target user exists.
    const { data: targetProfile, error: targetProfileError } = await supabaseAdmin
      .from("profiles")
      .select("id, email, full_name, role")
      .eq("id", targetUserId)
      .single();

    if (targetProfileError || !targetProfile) {
      return applyRequestAuthCookies(
        context,
        NextResponse.json({ error: "Target user not found" }, { status: 404 }),
      );
    }

    // Fail closed: a high-risk magic link is not generated unless its requested
    // access and reason have first been durably recorded.
    const { error: auditError } = await supabaseAdmin.from("audit_logs").insert({
      actor_id: context.user.id,
      actor_email: context.user.email,
      action: "impersonate_link_requested",
      target_type: "user",
      target_id: targetUserId,
      details: {
        actor_name: context.profile.full_name,
        actor_role: context.role,
        target_name: targetProfile.full_name,
        target_role: targetProfile.role,
        reason,
      },
    });

    if (auditError) {
      logger.error(
        { request_id: context.requestId, operation: "admin_impersonate_audit", err: auditError },
        "Unable to record impersonation audit event",
      );
      return applyRequestAuthCookies(
        context,
        NextResponse.json(
          { error: "Audit logging unavailable; access denied" },
          { status: 503 },
        ),
      );
    }

    // Generate the magic link only after the audit write succeeds.
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
