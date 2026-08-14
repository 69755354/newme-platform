// RBAC: user (admin, boss)
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  applyRequestAuthCookies,
  getRequestAuthContext,
  RequestAuthError,
  requestAuthErrorResponse,
} from "@/lib/request-auth-context";

// POST /api/admin/impersonate
// Admin generates a magic link to sign in as another user
export async function POST(request: NextRequest) {
  try {
    const context = await getRequestAuthContext(request);
    const respond = (body: Record<string, unknown>, init?: ResponseInit) =>
      applyRequestAuthCookies(context, NextResponse.json(body, init));

    if (!["admin", "boss"].includes(context.role)) {
      return respond({ error: "Forbidden: admin/boss only" }, { status: 403 });
    }

    const { targetUserId } = await request.json();
    if (!targetUserId) {
      return respond({ error: "targetUserId required" }, { status: 400 });
    }

  // Verify target user exists
    const { data: targetProfile } = await supabaseAdmin
      .from("profiles")
      .select("id, email, full_name, role")
      .eq("id", targetUserId)
      .single();

    if (!targetProfile) {
      return respond({ error: "Target user not found" }, { status: 404 });
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
      return respond({ error: "Could not generate impersonation link" }, { status: 500 });
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
    }).then(({ error }) => {
      if (error) console.warn("[audit] Failed to log impersonation:", error.message);
    });

    return respond({
      url: data.properties?.action_link,
      targetUser: {
        id: targetProfile.id,
        email: targetProfile.email,
        full_name: targetProfile.full_name,
        role: targetProfile.role,
      },
    });
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
