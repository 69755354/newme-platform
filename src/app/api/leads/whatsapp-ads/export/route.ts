// RBAC: admin, boss, operator (service-role reads after the role check)
// GET /api/leads/whatsapp-ads/export[?from=YYYY-MM-DD&to=YYYY-MM-DD&format=json]
// Marketing export: every click-to-WhatsApp lead with its Meta click id, ad id, creation time,
// stage and the state of the feedback sent back to Meta. admin and boss are equal.
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { logger } from "@/lib/logger";
import {
  applyRequestAuthCookies, getRequestAuthContext, RequestAuthError, requestAuthErrorResponse,
} from "@/lib/request-auth-context";
import { buildWhatsAppAdExportCsv, canExportWhatsAppAdLeads } from "@/lib/whatsapp-ad-export.mjs";

export const dynamic = "force-dynamic";
const PAGE = 1000;
const MAX_ROWS = 20_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: NextRequest) {
  try {
    const context = await getRequestAuthContext(request);
    const respond = (body: BodyInit | Record<string, unknown>, init: ResponseInit & { csv?: boolean } = {}) => {
      const { csv, ...rest } = init;
      const response = csv ? new NextResponse(body as BodyInit, rest) : NextResponse.json(body as Record<string, unknown>, rest);
      response.headers.set("Cache-Control", "private, no-store");
      return applyRequestAuthCookies(context, response);
    };
    if (!canExportWhatsAppAdLeads(context.role)) return respond({ error: "Forbidden" }, { status: 403 });

    const params = new URL(request.url).searchParams;
    const from = params.get("from");
    const to = params.get("to");
    if ((from && !DAY.test(from)) || (to && !DAY.test(to))) return respond({ error: "from and to must be YYYY-MM-DD" }, { status: 400 });

    type Row = Record<string, string | null>;
    const leads: Row[] = [];
    let overflow = false;
    // Fetch one row beyond MAX_ROWS so an oversized range is detected, never silently cut.
    for (let offset = 0; offset <= MAX_ROWS; offset += PAGE) {
      let query = supabaseAdmin.from("leads")
        .select("id, phone, ctwa_clid, ad_id, created_at, stage, final_status")
        .not("ctwa_clid", "is", null);
      if (from) query = query.gte("created_at", `${from}T00:00:00+04:00`);
      if (to) query = query.lt("created_at", `${new Date(Date.parse(`${to}T00:00:00+04:00`) + 86_400_000).toISOString()}`);
      const { data, error } = await query.order("created_at", { ascending: false }).order("id", { ascending: true }).range(offset, offset + PAGE - 1);
      if (error) throw new Error("lead_query_failed");
      leads.push(...(data ?? []));
      if (leads.length > MAX_ROWS) { overflow = true; break; }
      if ((data ?? []).length < PAGE) break;
    }
    if (overflow) return respond({
      error: `Too many leads for one export (more than ${MAX_ROWS}). Narrow the date range with from and to. 导出行数超过 ${MAX_ROWS} 条，请缩小 from 和 to 日期范围后重试。`,
      max_rows: MAX_ROWS,
    }, { status: 413 });
    const events: Row[] = [];
    for (let i = 0; i < leads.length; i += 200) {
      const ids = leads.slice(i, i + 200).map((lead) => lead.id);
      const { data, error } = await supabaseAdmin.from("whatsapp_capi_events").select("lead_id, event_name, status").in("lead_id", ids);
      if (error) throw new Error("event_query_failed");
      events.push(...(data ?? []));
    }

    if (params.get("format") === "json") {
      return respond({ count: leads.length, leads: leads.map((lead) => ({
        lead_id: lead.id, phone: lead.phone, ctwa_clid: lead.ctwa_clid, ad_id: lead.ad_id, created_at: lead.created_at,
        stage: lead.stage, final_status: lead.final_status,
        meta_feedback: events.filter((e) => e.lead_id === lead.id).map((e) => ({ event: e.event_name, status: e.status })),
      })) });
    }
    return respond(buildWhatsAppAdExportCsv(leads as never, events as never), {
      csv: true, status: 200,
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="whatsapp-ad-leads.csv"' },
    });
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error);
    logger.error({ operation: "whatsapp_ads_export", code: error instanceof Error ? error.message : "unknown" }, "whatsapp ad export failed");
    return NextResponse.json({ error: "Export failed" }, { status: 500 });
  }
}
