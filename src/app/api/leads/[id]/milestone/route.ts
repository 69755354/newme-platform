// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { canCompleteMilestone } from "@/lib/milestones";
import { getAuthProfile, isAdminOrBoss } from "@/lib/lead-auth";
import { isAssessedQuality, isCompleteContact } from "@/lib/first-contact-gate.mjs";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const supabase = await createServerSupabase();

  // 1. 鉴权 + 角色
  const profile = await getAuthProfile();
  if (!profile) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }

  const leadId = (await context.params).id;
  const body = await req.json();
  const { milestoneKey, notes } = body as { milestoneKey: string; notes?: string };
  const normalizedNotes = String(notes ?? "").trim();

  if (!milestoneKey) {
    return NextResponse.json({ error: "缺少 milestoneKey" }, { status: 400 });
  }

  // 3. 校验 lead 存在
  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("id, current_milestone, final_status, assigned_to, quality")
    .eq("id", leadId)
    .single();

  if (leadError || !lead) {
    return NextResponse.json({ error: "线索不存在" }, { status: 404 });
  }

  // 3.1 所有权校验：非管理员/主管仅能推进自己负责的线索 (rule_idor)
  if (!isAdminOrBoss(profile) && lead.assigned_to !== profile.userId) {
    return NextResponse.json({ error: "无权操作此线索" }, { status: 403 });
  }

  // 4. rule_007: won/lost lead 禁止完成任何里程碑
  if (lead.final_status === "won" || lead.final_status === "lost") {
    return NextResponse.json(
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
      return NextResponse.json(
        { error: "查询联系记录失败", detail: contactsError.message },
        { status: 500 }
      );
    }

    const hasCompleteContact = (contacts ?? []).some(isCompleteContact);
    if (!hasCompleteContact || !isAssessedQuality(lead.quality)) {
      return NextResponse.json(
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
    return NextResponse.json(
      { error: "查询里程碑失败", detail: milestonesError.message },
      { status: 500 }
    );
  }

  if (!normalizedNotes) {
    return NextResponse.json(
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
      const { data: confirmed, error: confirmError } = await supabaseAdmin
        .from("lead_milestones")
        .update({
          notes: normalizedNotes,
          completed_by: profile.userId,
          completed_at: new Date().toISOString(),
        })
        .eq("id", existingMilestone.id)
        .select()
        .single();
      if (confirmError || !confirmed) {
        return NextResponse.json(
          { error: confirmError?.message ?? "Failed to confirm First Contact" },
          { status: 500 },
        );
      }
      return NextResponse.json({ success: true, milestone: confirmed, manualConfirmation: true });
    }
    return NextResponse.json({ success: true, milestone: existingMilestone, duplicate: true });
  }

  // 6. rule_006: only completed milestones participate in sequence checks.
  const completedKeys = (existingMilestones ?? [])
    .filter((milestone) => milestone.completed_at)
    .map((milestone) => milestone.milestone_key);
  const check = canCompleteMilestone(completedKeys, milestoneKey);

  if (!check.allowed) {
    return NextResponse.json(
      {
        error: check.reason ?? "里程碑顺序不合法 (rule_006)",
        current: lead.current_milestone,
        attempted: milestoneKey,
      },
      { status: 400 }
    );
  }

  if (existingMilestone && !existingMilestone.completed_at) {
    const completedAt = new Date().toISOString();
    const { data: recompleted, error: recompleteError } = await supabaseAdmin
      .from("lead_milestones")
      .update({
        notes: normalizedNotes,
        completed_by: profile.userId,
        completed_at: completedAt,
      })
      .eq("id", existingMilestone.id)
      .select()
      .single();

    if (recompleteError || !recompleted) {
      return NextResponse.json(
        { error: recompleteError?.message ?? "Failed to complete reopened milestone" },
        { status: 500 },
      );
    }

    const { error: leadSyncError } = await supabaseAdmin
      .from("leads")
      .update({ current_milestone: milestoneKey, updated_at: completedAt })
      .eq("id", leadId);
    if (leadSyncError) {
      return NextResponse.json(
        { error: "Failed to synchronize current milestone", detail: leadSyncError.message },
        { status: 500 },
      );
    }

    const { error: eventError } = await supabaseAdmin
      .from("business_events")
      .insert({
        lead_id: leadId,
        user_id: profile.userId,
        event_type: "note_added",
        description: `Milestone ${milestoneKey} completed again: ${normalizedNotes}`,
        event_data: {
          action: "milestone_recompleted",
          milestone_key: milestoneKey,
          notes: normalizedNotes,
        },
      });
    if (eventError) {
      return NextResponse.json(
        { error: "Failed to write milestone audit event", detail: eventError.message },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true, milestone: recompleted, recompleted: true });
  }

  // 7. 插入里程碑（leads.current_milestone 由 trigger trg_check_milestone_order 自动维护）
  const { data: inserted, error: insertError } = await supabase
    .from("lead_milestones")
    .insert({
      lead_id: leadId,
      milestone_key: milestoneKey,
      completed_by: profile.userId,
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
      return NextResponse.json({ success: true, milestone: racedMilestone, duplicate: true });
    }
  }
  if (insertError) {
    return NextResponse.json(
      { error: "写入里程碑失败", detail: insertError.message },
      { status: 500 }
    );
  }

  // Terminal outcomes are authoritative in final_status. Keep the legacy
  // stage column in sync only for compatibility with older consumers.
  if (milestoneKey === "won" || milestoneKey === "lost") {
    const { error: statusError } = await supabase
      .from("leads")
      .update({ final_status: milestoneKey, stage: milestoneKey, contact_time: new Date().toISOString() })
      .eq("id", leadId);

    if (statusError) {
      return NextResponse.json(
        { error: "同步线索最终状态失败", detail: statusError.message },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({ success: true, milestone: inserted });
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const profile = await getAuthProfile();
  if (!profile) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }

  const leadId = (await context.params).id;
  const body = await req.json().catch(() => ({}));
  const milestoneKey = String(body?.milestoneKey ?? "").trim();
  const reason = String(body?.reason ?? "").trim();

  if (!milestoneKey) {
    return NextResponse.json({ error: "缺少 milestoneKey" }, { status: 400 });
  }
  if (!reason) {
    return NextResponse.json({ error: "Reopen reason is required" }, { status: 400 });
  }
  if (reason.length > 1000) {
    return NextResponse.json(
      { error: "Reopen reason must be 1000 characters or fewer" },
      { status: 400 },
    );
  }

  const supabase = await createServerSupabase();
  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("id, assigned_to")
    .eq("id", leadId)
    .single();

  if (leadError || !lead) {
    return NextResponse.json({ error: "线索不存在" }, { status: 404 });
  }
  if (!isAdminOrBoss(profile) && lead.assigned_to !== profile.userId) {
    return NextResponse.json({ error: "无权操作此线索" }, { status: 403 });
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
    return NextResponse.json({ error: message }, { status });
  }

  return NextResponse.json({ success: true, result: data });
}
