// RBAC: public
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

/**
 * Meta CAPI (Conversions API) — 接收 Meta 转化的 lead 事件
 * 存入 Supabase leads 表，触发 Hermes 分析
 * 
 * POST /api/leads/meta-capi
 * Body: { event_name, event_time, user_data, custom_data }
 */

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY not configured — set it in production environment variables.",
    );
  }
  return createClient(url, key);
}

export async function POST(request: NextRequest) {
  try {
    // Webhook secret verification
    const webhookSecret = process.env.META_CAPI_WEBHOOK_SECRET;
    if (!webhookSecret) {
      return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
    }
    const authHeader = request.headers.get("authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (token !== webhookSecret) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { event_name, event_time, user_data, custom_data } = body;

    // 只处理 Lead 事件
    if (!event_name || event_name !== "Lead") {
      return NextResponse.json({ status: "skipped", reason: "not lead event" });
    }

    // 从 Meta 数据提取字段
    const customerName = user_data?.fn
      ? `${user_data.fn || ""} ${user_data.ln || ""}`.trim()
      : user_data?.full_name || null;

    const phone = user_data?.phone || user_data?.phone_number || null;
    const email = user_data?.em || user_data?.email || null;
    const location = user_data?.ct || user_data?.city || null;

    // Persist only the canonical CRM source values.
    const platform = (custom_data?.platform || "").toLowerCase();
    const formName = (custom_data?.form_name || "").toLowerCase();
    let source = "unknown";
    if (platform === "instagram" || formName.includes("instagram")) {
      source = "ins";
    } else if (platform === "facebook" || formName.includes("facebook")) {
      source = "fb";
    }

    const now = new Date().toISOString();
    const eventTimestamp = event_time
      ? new Date(event_time * 1000).toISOString()
      : now;

    const leadData = {
      source,
      customer_name: customerName,
      phone,
      email,
      location,
      lead_status: "hot",
      next_action: "call",
      next_followup_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      meta_campaign: custom_data?.campaign_name || null,
      meta_click_id: user_data?.fbc || null,
      meta_ad_id: custom_data?.ad_id || null,
      utm_source: custom_data?.utm_source || null,
      utm_campaign: custom_data?.utm_campaign || null,
      first_touch_at: eventTimestamp,
      created_at: now,
    };

    const supabaseAdmin = getSupabaseAdmin();

    // 处理重复: 根据 email 或 phone 查找已有线索
    let existingLeadId: string | null = null;

    if (email || phone) {
      // Sanitize inputs before interpolation to prevent Supabase filter injection
      const sanitizeEmail = (e: string) => {
        if (e.length < 3 || e.length > 254 || e.trim() !== e) return "";
        const at = e.indexOf("@");
        if (at <= 0 || at !== e.lastIndexOf("@") || at > 64) return "";
        const local = e.slice(0, at);
        const domain = e.slice(at + 1);
        if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return "";
        if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) return "";
        const localAllowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._%+-";
        const domainAllowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-";
        if ([...local].some((character) => !localAllowed.includes(character))) return "";
        if ([...domain].some((character) => !domainAllowed.includes(character))) return "";
        return e;
      };
      const sanitizePhone = (p: string) => p.replace(/[^0-9+\-()]/g, "");
      const sanitizedEmail = email ? sanitizeEmail(email) : "";
      const sanitizedPhone = phone ? sanitizePhone(phone) : "";
      const emailFilter = sanitizedEmail ? `email.eq.${sanitizedEmail}` : "";
      const phoneFilter = sanitizedPhone ? `phone.eq.${sanitizedPhone}` : "";
      const orFilters = [emailFilter, phoneFilter].filter(Boolean).join(",");
      if (!orFilters) {
        return NextResponse.json(
          { status: "error", message: "No valid email or phone provided" },
          { status: 400 },
        );
      }
      const dupQuery = supabaseAdmin
        .from("leads")
        .select("id")
        .or(orFilters)
        .limit(1);

      const { data: existing } = await dupQuery;
      if (existing && existing.length > 0) {
        existingLeadId = existing[0].id;
      }
    }

    let result;

    if (existingLeadId) {
      // 重复线索: 更新 campaign 信息和更新时间
      const { data: updated, error: updateErr } = await supabaseAdmin
        .from("leads")
        .update({
          ...(source !== "unknown" ? { source } : {}),
          meta_campaign: leadData.meta_campaign,
          meta_click_id: leadData.meta_click_id,
          meta_ad_id: leadData.meta_ad_id,
          utm_source: leadData.utm_source,
          utm_campaign: leadData.utm_campaign,
          // 如果之前的 phone/email 为空，补填
          ...(phone && { phone }),
          ...(email && { email }),
          ...(customerName && { customer_name: customerName }),
          ...(location && { location }),
          updated_at: now,
        })
        .eq("id", existingLeadId)
        .select("id")
        .single();

      if (updateErr) {
        console.error("[Meta CAPI] Failed to update lead:", updateErr);
        return NextResponse.json(
          { status: "error", message: "Failed to update lead" },
          { status: 500 },
        );
      }

      result = { id: updated.id, duplicate: true };
    } else {
      // 新线索: 插入
      const { data: inserted, error: insertErr } = await supabaseAdmin
        .from("leads")
        .insert(leadData)
        .select("id")
        .single();

      if (insertErr) {
        console.error("[Meta CAPI] Failed to insert lead:", insertErr);
        return NextResponse.json(
          { status: "error", message: "Failed to insert lead" },
          { status: 500 },
        );
      }

      result = { id: inserted.id, duplicate: false };
    }

    return NextResponse.json({
      status: "received",
      lead_id: result.id,
      duplicate: result.duplicate,
      source,
    });
  } catch (err: any) {
    console.error("[Meta CAPI] Error:", err);
    const message = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    return NextResponse.json(
      { status: "error", message: message || "Internal error" },
      { status: 500 },
    );
  }
}
