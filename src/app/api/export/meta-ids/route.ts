// RBAC: admin, boss, operator (login) OR the read-only META_IDS_EXPORT_TOKEN (?token= or Bearer); service-role reads after auth
// GET /api/export/meta-ids[?format=csv|json][&since=ISO-8601]
// Meta ID registry: every lead with a Meta leadgen id (forms) or ctwa_clid (click-to-WhatsApp), archived ones
// included, with the ad it came from and the state of the feedback sent back to Meta. No name, phone or email.
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { logger } from "@/lib/logger";
import { clientIdentifier, consumeRateLimit } from "@/lib/rate-limit";
import {
  applyRequestAuthCookies, getRequestAuthContext, RequestAuthError, requestAuthErrorResponse,
} from "@/lib/request-auth-context";
import {
  buildMetaIdRows, buildMetaIdsCsv, canExportMetaIds, extractExportToken, tokenMatches,
} from "@/lib/meta-ids-export.mjs";

export const dynamic = "force-dynamic";
const PAGE = 1000;
const MAX_ROWS = 20_000;
const TOKEN_LIMIT_PER_MINUTE = 20;
const LEAD_COLUMNS = "id, meta_leadgen_id, ctwa_clid, campaign_id, campaign_name, adset_id, ad_id, ad_name, created_at, stage, final_status, archived";

function noStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function GET(request: NextRequest) {
  try {
    const params = new URL(request.url).searchParams;
    const supplied = extractExportToken(request.headers, params);
    const expected = process.env.META_IDS_EXPORT_TOKEN;
    const tokenEnabled = typeof expected === "string" && expected.length > 0;
    let viaToken = false;
    let context: Awaited<ReturnType<typeof getRequestAuthContext>> | null = null;

    if (tokenEnabled && (supplied.query || supplied.bearer)) {
      // Every token attempt, right or wrong, spends the per-source budget.
      const limit = consumeRateLimit(clientIdentifier(request), { limit: TOKEN_LIMIT_PER_MINUTE, windowMs: 60_000, namespace: "meta-ids-export" });
      if (!limit.allowed) {
        return noStore(NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }));
      }
      viaToken = tokenMatches(supplied.query, expected) || tokenMatches(supplied.bearer, expected);
      // A wrong ?token= is a failed token attempt. A wrong Bearer may be a normal login session: fall through.
      if (!viaToken && supplied.query) return noStore(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
    }
    if (!viaToken) {
      context = await getRequestAuthContext(request);
      if (!canExportMetaIds(context.role)) return noStore(NextResponse.json({ error: "Forbidden" }, { status: 403 }));
    }
    const respond = (body: BodyInit | Record<string, unknown>, init: ResponseInit & { csv?: boolean } = {}) => {
      const { csv, ...rest } = init;
      const response = noStore(csv ? new NextResponse(body as BodyInit, rest) : NextResponse.json(body as Record<string, unknown>, rest));
      return context ? applyRequestAuthCookies(context, response) : response;
    };

    const format = params.get("format") ?? "csv";
    if (format !== "csv" && format !== "json") return respond({ error: "format must be csv or json" }, { status: 400 });
    const since = params.get("since");
    if (since && !Number.isFinite(Date.parse(since))) return respond({ error: "since must be an ISO-8601 date or time" }, { status: 400 });

    type Row = Record<string, string | boolean | null>;
    const leads: Row[] = [];
    let overflow = false;
    // Fetch one row beyond MAX_ROWS so an oversized export is detected, never silently cut.
    for (let offset = 0; offset <= MAX_ROWS; offset += PAGE) {
      let query = supabaseAdmin.from("leads").select(LEAD_COLUMNS)
        .or("meta_leadgen_id.not.is.null,ctwa_clid.not.is.null");
      if (since) query = query.gte("created_at", new Date(Date.parse(since)).toISOString());
      const { data, error } = await query.order("created_at", { ascending: false }).order("id", { ascending: true }).range(offset, offset + PAGE - 1);
      if (error) throw new Error("lead_query_failed");
      leads.push(...((data ?? []) as Row[]));
      if (leads.length > MAX_ROWS) { overflow = true; break; }
      if ((data ?? []).length < PAGE) break;
    }
    if (overflow) return respond({
      error: `Too many leads for one export (more than ${MAX_ROWS}). Narrow the range with since=. 导出行数超过 ${MAX_ROWS} 条，请用 since 参数缩小时间范围后重试。`,
      max_rows: MAX_ROWS,
    }, { status: 413 });

    const formEvents: Row[] = [];
    const whatsappEvents: Row[] = [];
    for (let i = 0; i < leads.length; i += 200) {
      const slice = leads.slice(i, i + 200);
      const formIds = slice.filter((l) => l.meta_leadgen_id).map((l) => l.id);
      const waIds = slice.filter((l) => l.ctwa_clid).map((l) => l.id);
      if (formIds.length) {
        const { data, error } = await supabaseAdmin.from("meta_crm_stage_events").select("lead_id, event_name, status, created_at, delivered_at").in("lead_id", formIds);
        if (error) throw new Error("form_event_query_failed");
        formEvents.push(...((data ?? []) as Row[]));
      }
      if (waIds.length) {
        const { data, error } = await supabaseAdmin.from("whatsapp_capi_events").select("lead_id, event_name, status, created_at, delivered_at").in("lead_id", waIds);
        if (error) throw new Error("whatsapp_event_query_failed");
        whatsappEvents.push(...((data ?? []) as Row[]));
      }
    }

    const rows = buildMetaIdRows(leads as never, formEvents as never, whatsappEvents as never);
    if (format === "json") return respond({ count: rows.length, rows });
    return respond(buildMetaIdsCsv(rows), {
      csv: true, status: 200,
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'inline; filename="meta-ids.csv"' },
    });
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error);
    logger.error({ operation: "meta_ids_export", code: error instanceof Error ? error.message : "unknown" }, "meta ids export failed");
    return NextResponse.json({ error: "Export failed" }, { status: 500 });
  }
}
