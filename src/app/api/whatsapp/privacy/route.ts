// RBAC: current active boss/admin session. Database independently enforces the same boundary.
import { NextResponse } from "next/server";
import { applyRequestAuthCookies, getRequestAuthContext, RequestAuthError, requestAuthErrorResponse } from "@/lib/request-auth-context";
import { deletionCustomerKey, readDeletionInput } from "@/lib/whatsapp-privacy.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const reply = (body: unknown, status = 200) => NextResponse.json(body, {
  status, headers: { "Cache-Control": "private, no-store", Vary: "Cookie, Authorization" },
});

export async function GET(request: Request) {
  try {
    const context = await getRequestAuthContext(request);
    const respond = (body: unknown, status = 200) => applyRequestAuthCookies(context, reply(body, status));
    if (!["admin", "boss"].includes(context.role)) return respond({ error: "forbidden" }, 403);
    const { data, error } = await context.supabase.rpc("whatsapp_privacy_status");
    if (error || !data) return respond({ error: "privacy_unavailable" }, 503);
    return respond(data);
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error);
    return reply({ error: "privacy_unavailable" }, 503);
  }
}

export async function POST(request: Request) {
  try {
    const context = await getRequestAuthContext(request);
    const respond = (body: unknown, status = 200) => applyRequestAuthCookies(context, reply(body, status));
    if (!["admin", "boss"].includes(context.role)) return respond({ error: "forbidden" }, 403);
    if (request.headers.get("origin") !== "https://app.newme.ae"
      || request.headers.get("sec-fetch-site") === "cross-site") return respond({ error: "invalid_origin" }, 403);
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return respond({ error: "invalid_content_type" }, 415);
    const input = await readDeletionInput(request);
    if (!input) return respond({ error: "invalid_request" }, 400);
    const salt = process.env.WHATSAPP_PILOT_CONTACT_SALT;
    if (!salt) return respond({ error: "privacy_not_configured" }, 503);
    const key = deletionCustomerKey(input.phone, salt);
    if (!key) return respond({ error: "international_phone_required" }, 400);
    // The caller's JWT reaches SQL. Never replace with a service-role client or
    // accept browser-supplied actor IDs, customer hashes or deletion cutoffs.
    const { data, error } = await context.supabase.rpc("request_whatsapp_deletion", {
      p_request_id: input.request_id.toLowerCase(), p_customer_key: key,
    });
    if (error || !data) {
      const code = error?.code;
      return respond({ error: code === "42501" ? "forbidden" : code === "22023" ? "request_conflict" : code === "54000" ? "request_limit" : "deletion_result_unknown",
        result_uncertain: !["42501", "22023", "54000"].includes(code ?? "") }, code === "42501" ? 403 : code === "22023" ? 409 : code === "54000" ? 429 : 503);
    }
    return respond(data);
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error);
    return reply({ error: "deletion_result_unknown", result_uncertain: true }, 503);
  }
}
