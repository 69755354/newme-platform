import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createServerSupabase } from "@/lib/supabase-server";

/**
 * PATCH /api/quotations/[id]/status
 * 转换报价状态，打通变现链路死结：draft→sent→accepted→rejected。
 * convert 转合同要求 accepted，此前全代码库无 accepted 入口导致 0 合同 0 回款。
 *
 * Input:  { status: "sent" | "accepted" | "rejected", note?: string }
 * Output: { success, quotation_id, status }
 *
 * 合法状态机：
 *   draft  → sent | rejected
 *   sent   → accepted | rejected
 *   accepted → rejected (撤回接受)
 *   contract_created / rejected → 终态，不可再变
 */
const ALLOWED = new Set(["draft", "sent", "accepted", "rejected", "contract_created"]);
const TRANSITIONS: Record<string, Set<string>> = {
  draft: new Set(["sent", "rejected"]),
  sent: new Set(["accepted", "rejected"]),
  accepted: new Set(["rejected"]),
  contract_created: new Set(), // 终态
  rejected: new Set(), // 终态
};

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: quotationId } = await params;
    const supabase = await createServerSupabase();
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const { status: newStatus, note } = body as { status?: string; note?: string };

    if (!newStatus || !ALLOWED.has(newStatus)) {
      return NextResponse.json(
        { error: `Invalid status. Allowed: ${[...ALLOWED].join(", ")}` },
        { status: 400 }
      );
    }

    // Fetch quotation
    const { data: quote, error: quoteErr } = await supabaseAdmin
      .from("quotations")
      .select("id, status, created_by, lead_id, quote_no, total_amount, currency")
      .eq("id", quotationId)
      .single();

    if (quoteErr || !quote) {
      return NextResponse.json({ error: "Quotation not found" }, { status: 404 });
    }

    // 状态机校验
    const allowedNext = TRANSITIONS[quote.status];
    if (!allowedNext || !allowedNext.has(newStatus)) {
      return NextResponse.json(
        {
          error: `Illegal transition: ${quote.status} → ${newStatus}`,
          current_status: quote.status,
          allowed: [...(allowedNext ?? [])],
        },
        { status: 400 }
      );
    }

    // 权限：admin/boss/operator 可改所有；sales 只能改自己创建的
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    const isAdmin =
      profile?.role && ["admin", "boss", "operator"].includes(profile.role);
    if (!isAdmin && quote.created_by !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // 更新报价状态
    const { error: updErr } = await supabaseAdmin
      .from("quotations")
      .update({
        status: newStatus,
        updated_at: new Date().toISOString(),
      })
      .eq("id", quotationId);
    if (updErr) {
      console.error("[Quotation Status] Update failed:", updErr);
      return NextResponse.json({ error: "Failed to update status" }, { status: 500 });
    }

    // 写活动日志
    const labelMap: Record<string, string> = {
      sent: "已发送给客户",
      accepted: "客户已接受报价 ✓",
      rejected: "客户拒绝报价 ✗",
    };
    await supabaseAdmin.from("activities").insert({
      lead_id: quote.lead_id,
      type: "note",
      content: `报价 #${quote.quote_no} 状态变更：${labelMap[newStatus] || newStatus}${note ? ` — ${note}` : ""}`,
      ai_generated: false,
      user_id: user.id,
    });

    // accepted 时回写 quotation_value（防止老报价漏回写）+ 推进 lead stage
    if (newStatus === "accepted" && quote.lead_id) {
      await supabaseAdmin
        .from("leads")
        .update({
          quotation_value: quote.total_amount,
          stage: "negotiation",
          updated_at: new Date().toISOString(),
        })
        .eq("id", quote.lead_id);
    }

    revalidatePath("/quotes");
    revalidatePath(`/quotes/${quotationId}`);
    revalidatePath("/leads");

    return NextResponse.json({
      success: true,
      quotation_id: quotationId,
      status: newStatus,
    });
  } catch (err: unknown) {
    const message =
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : (err as Error).message;
    console.error("[Quotation Status] Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
