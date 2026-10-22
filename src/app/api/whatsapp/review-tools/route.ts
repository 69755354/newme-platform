// RBAC: active boss/admin, current session. Fixed Meta test WABA only.
import { NextResponse } from "next/server";
import { applyRequestAuthCookies, getRequestAuthContext, RequestAuthError, requestAuthErrorResponse } from "@/lib/request-auth-context";
import { consumeRateLimit } from "@/lib/rate-limit";
import { REVIEW_ACTIONS, REVIEW_TEMPLATE_BODY, reviewToolsConfig, performReviewAction, runReviewAttempt, ReviewToolsError, type ReviewAction } from "@/lib/whatsapp-review-tools.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const reply = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, {
  status, headers: { "Cache-Control": "private, no-store", Vary: "Cookie, Authorization" },
});

export async function GET(request: Request) {
  try {
    const context = await getRequestAuthContext(request);
    if (!["admin", "boss"].includes(context.role)) return applyRequestAuthCookies(context, reply({ error: "forbidden" }, 403));
    return applyRequestAuthCookies(context, reply({ ...reviewToolsConfig(), template_body: REVIEW_TEMPLATE_BODY }));
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error);
    return reply({ error: "review_tools_unavailable" }, 503);
  }
}

export async function POST(request: Request) {
  try {
    const context = await getRequestAuthContext(request);
    const respond = (body: Record<string, unknown>, status = 200) => applyRequestAuthCookies(context, reply(body, status));
    if (!["admin", "boss"].includes(context.role)) return respond({ error: "forbidden" }, 403);
    if (!reviewToolsConfig().enabled) return respond({ error: "review_tools_disabled" }, 503);
    if (request.headers.get("origin") !== "https://app.newme.ae"
      || request.headers.get("sec-fetch-site") === "cross-site") return respond({ error: "invalid_origin" }, 403);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return respond({ error: "invalid_content_type" }, 415);
    if (Number(request.headers.get("content-length")) > 1024) return respond({ error: "body_too_large" }, 413);
    // Bound streamed input too; Content-Length is optional and caller-controlled.
    const reader = request.body?.getReader();
    if (!reader) return respond({ error: "invalid_request" }, 400);
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength;
      if (size > 1024) { await reader.cancel(); return respond({ error: "body_too_large" }, 413); }
      chunks.push(item.value);
    }
    let input: unknown;
    try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { return respond({ error: "invalid_request" }, 400); }
    if (!input || typeof input !== "object" || Array.isArray(input)) return respond({ error: "invalid_request" }, 400);
    const body = input as Record<string, unknown>;
    if (Object.keys(body).sort().join(",") !== "action,request_id"
      || typeof body.action !== "string" || !REVIEW_ACTIONS.includes(body.action)
      || typeof body.request_id !== "string"
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(body.request_id)) return respond({ error: "invalid_request" }, 400);
    const action = body.action as ReviewAction;
    const requestId = body.request_id.toLowerCase();
    try {
      const result = await runReviewAttempt(context.user.id, action, requestId, async () => {
        const userBudget = consumeRateLimit(context.user.id, { namespace: "whatsapp-review-user", limit: 4, windowMs: 3_600_000 });
        const totalBudget = consumeRateLimit("fixed-sandbox", { namespace: "whatsapp-review-total", limit: 8, windowMs: 3_600_000 });
        if (!userBudget.allowed || !totalBudget.allowed) throw new ReviewToolsError("review_rate_limit", { status: 429 });
        return performReviewAction(action, requestId);
      });
      return respond(result);
    } catch (error) {
      if (error instanceof ReviewToolsError) return respond({ error: error.code, result_uncertain: error.uncertain, ...(error.metaCode !== undefined ? { meta_code: error.metaCode } : {}) }, error.status);
      return respond({ error: "review_result_unknown", result_uncertain: true }, 502);
    }
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error);
    return reply({ error: "review_tools_unavailable" }, 503);
  }
}
