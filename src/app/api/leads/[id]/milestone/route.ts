// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { canCompleteMilestone } from "@/lib/milestones";
import {
  applyRequestAuthCookies,
  getRequestAuthContext,
  RequestAuthError,
  requestAuthErrorResponse,
  type RequestAuthContext,
} from "@/lib/request-auth-context";
import { isAssessedQuality, isCompleteContact } from "@/lib/first-contact-gate.mjs";

type AdminSupabaseClient = SupabaseClient<Database>;

function createResponder(authContext: RequestAuthContext) {
  return (body: Record<string, unknown>, init?: ResponseInit) =>
    applyRequestAuthCookies(authContext, NextResponse.json(body, init));
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  let authContext: RequestAuthContext;
  try {
    authContext = await getRequestAuthContext(req);
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error);
    throw error;
  }
  const { supabase } = authContext;
  const respond = createResponder(authContext);

  const leadId = (await context.params).id;
  const body = await req.json();
  const { milestoneKey, notes } = body as { milestoneKey: string; notes?: string };
  const normalizedNotes = String(notes ?? "").trim();

  if (!milestoneKey) {
    return respond({ error: "缺少 milestoneKey" }, { status: 400 });
  }

  // 3. 校验 lead 存在
  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("id, current_milestone, final_status, assigned_to, quality")
    .eq("id", leadId)
    .single();

  if (leadError || !lead) {
    return respond({ error: "线索不存在" }, { status: 404 });
  }

  // 3.1 所有权校验：非管理员/主管仅能推进自己负责的线索 (rule_idor)
  if (!["admin", "boss", "operator"].includes(authContext.role) && lead.assigned_to !== authContext.user.id) {
    return respond({ error: "无权操作此线索" }, { status: 403 });
  }

  // 4. rule_007: won/lost lead 禁止完成任何里程碑
  if (lead.final_status === "won" || lead.final_status === "lost") {
    return respond(
      { error: "已成交/失败的线索不能继续推进里程碑" },
      { status: 400 }
    );
  }

  if (milestoneKey === "first_contact") {
    const { data: contacts, error: contactsError } = await supabase
      .from("follow_up_logs")
      .select("contact_time, contact_result")
      .eq("lead_id", leadId);

    if (contactsError) {
      return respond(
        { error: "查询联系记录失败", detail: contactsError.message },
        { status: 500 }
      );
    }

    const hasCompleteContact = (contacts ?? []).some(isCompleteContact);
    if (!hasCompleteContact || !isAssessedQuality(lead.quality)) {
      return respond(
        { error: "请先添加1条完整联系记录并评估线索质量" },
        { status: 400 }
      );
    }
  }

  // 5. 查询已有的 milestones
  const { data: existingMilestones, error: milestonesError } = await supabase
    .from("lead_milestones")
    .select("*")
    .eq("lead_id", leadId)
    .order("completed_at", { ascending: true });

  if (milestonesError) {
    return respond(
      { error: "查询里程碑失败", detail: milestonesError.message },
      { status: 500 }
    );
  }

  if (!normalizedNotes) {
    return respond(
      { error: "Milestone note is required" },
      { status: 400 },
    );
  }

  const existingMilestone = (existingMilestones ?? []).find(
    (milestone) => milestone.milestone_key === milestoneKey,
  );
  if (existingMilestone?.completed_at) {
    // Old trigger-created first_contact rows have no operator note. Turn that
    // fact row into the required explicit confirmation instead of treating it
    // as a completed manual milestone.
    if (milestoneKey === "first_contact" && !String(existingMilestone.notes ?? "").trim()) {
      const typedSupabaseAdmin = supabaseAdmin as AdminSupabaseClient;
      const { data: confirmed, error: confirmError } = await typedSupabaseAdmin
        .from("lead_milestones")
        .update({
          notes: normalizedNotes,
          completed_by: authContext.user.id,
          completed_at: new Date().toISOString(),
        })
        .eq("id", existingMilestone.id)
        .select()
        .single();
      if (confirmError || !confirmed) {
        return respond(
          { error: confirmError?.message ?? "Failed to confirm First Contact" },
          { status: 500 },
        );
      }
      return respond({ success: true, milestone: confirmed, manualConfirmation: true });
    }
    return respond({ success: true, milestone: existingMilestone, duplicate: true });
  }

  // 6. rule_006: only completed milestones participate in sequence checks.
  const completedKeys = (existingMilestones ?? [])
    .filter((milestone) => milestone.completed_at)
    .map((milestone) => milestone.milestone_key);
  const check = canCompleteMilestone(completedKeys, milestoneKey);

  if (!check.allowed) {
    return respond(
      {
        error: check.reason ?? "里程碑顺序不合法 (rule_006)",
        current: lead.current_milestone,
        attempted: milestoneKey,
      },
      { status: 400 }
    );
  }

  if (existingMilestone && !existingMilestone.completed_at) {
    const { data: recompleted, error: recompleteError } = await supabase.rpc(
      "recomplete_lead_milestone",
      {
        p_lead_id: leadId,
        p_milestone_key: milestoneKey,
        p_notes: normalizedNotes,
      },
    );

    if (recompleteError) {
      const message = recompleteError.message || "Failed to complete reopened milestone";
      const status = message.includes("Forbidden") ? 403
        : message.includes("not found") ? 404
        : 400;
      return respond({ error: message }, { status });
    }

    return respond({
      success: true,
      result: recompleted,
      recompleted: true,
    });
  }

  // 7. 插入里程碑（leads.current_milestone 由 trigger trg_check_milestone_order 自动维护）
  const { data: inserted, error: insertError } = await supabase
    .from("lead_milestones")
    .insert({
      lead_id: leadId,
      milestone_key: milestoneKey,
      completed_by: authContext.user.id,
      notes: normalizedNotes,
    })
    .select()
    .single();

  if (insertError?.code === "23505") {
    const { data: racedMilestone } = await supabase
      .from("lead_milestones")
      .select("*")
      .eq("lead_id", leadId)
      .eq("milestone_key", milestoneKey)
      .single();
    if (racedMilestone) {
      return respond({ success: true, milestone: racedMilestone, duplicate: true });
    }
  }
  if (insertError) {
    return respond(
      { error: "写入里程碑失败", detail: insertError.message },
      { status: 500 }
    );
  }

  // Terminal outcomes are authoritative in final_status. Keep the legacy
  // stage column in sync only for compatibility with older consumers.
  if (milestoneKey === "won" || milestoneKey === "lost") {
    const { error: statusError } = await supabase
      .from("leads")
      .update({ final_status: milestoneKey, stage: milestoneKey })
      .eq("id", leadId);

    if (statusError) {
      return respond(
        { error: "同步线索最终状态失败", detail: statusError.message },
        { status: 500 }
      );
    }
  }

  return respond({ success: true, milestone: inserted });
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  let authContext: RequestAuthContext;
  try {
    authContext = await getRequestAuthContext(req);
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error);
    throw error;
  }
  const { supabase } = authContext;
  const respond = createResponder(authContext);

  const leadId = (await context.params).id;
  const body = await req.json().catch(() => ({}));
  const milestoneKey = String(body?.milestoneKey ?? "").trim();
  const reason = String(body?.reason ?? "").trim();

  if (!milestoneKey) {
    return respond({ error: "缺少 milestoneKey" }, { status: 400 });
  }
  if (!reason) {
    return respond({ error: "Reopen reason is required" }, { status: 400 });
  }
  if (reason.length > 1000) {
    return respond(
      { error: "Reopen reason must be 1000 characters or fewer" },
      { status: 400 },
    );
  }

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("id, assigned_to")
    .eq("id", leadId)
    .single();

  if (leadError || !lead) {
    return respond({ error: "线索不存在" }, { status: 404 });
  }
  if (!["admin", "boss", "operator"].includes(authContext.role) && lead.assigned_to !== authContext.user.id) {
    return respond({ error: "无权操作此线索" }, { status: 403 });
  }

  const { data, error } = await supabase.rpc("reopen_lead_milestone", {
    p_lead_id: leadId,
    p_milestone_key: milestoneKey,
    p_reason: reason,
  });

  if (error) {
    const message = error.message || "Failed to reopen milestone";
    const status = message.includes("Forbidden") ? 403
      : message.includes("not found") ? 404
      : 400;
    return respond({ error: message }, { status });
  }

  return respond({ success: true, result: data });
}
