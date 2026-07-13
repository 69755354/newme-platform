// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
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
    .select("milestone_key, completed_at")
    .eq("lead_id", leadId)
    .order("completed_at", { ascending: true });

  if (milestonesError) {
    return NextResponse.json(
      { error: "查询里程碑失败", detail: milestonesError.message },
      { status: 500 }
    );
  }

  // 6. rule_006: 顺序校验（不能跳级、不能往回）
  const completedKeys = (existingMilestones ?? []).map((m) => m.milestone_key);
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

  // 7. 插入里程碑（leads.current_milestone 由 trigger trg_check_milestone_order 自动维护）
  const { data: inserted, error: insertError } = await supabase
    .from("lead_milestones")
    .insert({
      lead_id: leadId,
      milestone_key: milestoneKey,
      completed_by: profile.userId,
      notes: notes ?? null,
    })
    .select()
    .single();

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
