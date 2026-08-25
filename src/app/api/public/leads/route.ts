// RBAC: public, origin-restricted website intake; persistence uses service_role server-side only.
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { clientIdentifier, consumeRateLimit } from "@/lib/rate-limit";
import { logger, genReqId } from "@/lib/logger";
import {
  isAllowedPublicLeadOrigin,
  parseWebsiteLead,
  publicLeadCorsHeaders,
} from "@/lib/public-lead";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createFollowUpTask } from "@/lib/tasks";
import { sendMetaCapiLead } from "@/lib/meta-capi";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

const MAX_BODY_BYTES = 16 * 1024;

function response(origin: string | null, body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, {
    status,
    headers: publicLeadCorsHeaders(origin),
  });
}

async function verifyTurnstile(token: string | null, remoteIp: string): Promise<boolean> {
  const secret = process.env.WEBSITE_LEAD_TURNSTILE_SECRET;
  if (!secret) return true;
  if (!token) return false;
  const form = new URLSearchParams({ secret, response: token });
  if (remoteIp !== "unknown") form.set("remoteip", remoteIp);
  try {
    const result = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      cache: "no-store",
      signal: AbortSignal.timeout(4_000),
    });
    if (!result.ok) return false;
    const payload = await result.json() as { success?: unknown; hostname?: unknown };
    return payload.success === true
      && (payload.hostname === "newme.ae" || payload.hostname === "www.newme.ae");
  } catch {
    return false;
  }
}

export function OPTIONS(request: Request) {
  const origin = request.headers.get("origin");
  if (!isAllowedPublicLeadOrigin(origin)) return response(origin, { error: "invalid_origin" }, 403);
  return new Response(null, { status: 204, headers: publicLeadCorsHeaders(origin) });
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const requestId = genReqId();
  if (!isAllowedPublicLeadOrigin(origin)) return response(origin, { error: "invalid_origin" }, 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return response(origin, { error: "json_required" }, 415);
  }
  const statedLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(statedLength) && statedLength > MAX_BODY_BYTES) {
    return response(origin, { error: "body_too_large" }, 413);
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return response(origin, { error: "invalid_body" }, 400);
  }
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return response(origin, { error: "body_too_large" }, 413);
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return response(origin, { error: "invalid_json" }, 400);
  }
  const parsed = parseWebsiteLead(json);
  if (!parsed.ok) return response(origin, { error: parsed.code }, 400);
  if (parsed.value.honeypot) return response(origin, { ok: true }, 202);

  const ip = clientIdentifier(request);
  const ipLimit = consumeRateLimit(ip, {
    namespace: "website-lead-ip",
    limit: 5,
    windowMs: 60 * 60 * 1_000,
  });
  const contactKey = createHash("sha256")
    .update(parsed.value.phone || parsed.value.email || "missing")
    .digest("hex");
  const contactLimit = consumeRateLimit(contactKey, {
    namespace: "website-lead-contact",
    limit: 3,
    windowMs: 24 * 60 * 60 * 1_000,
  });
  if (!ipLimit.allowed || !contactLimit.allowed) {
    const retryAfter = Math.max(ipLimit.retryAfterSeconds, contactLimit.retryAfterSeconds);
    const limited = response(origin, { error: "rate_limited" }, 429);
    limited.headers.set("Retry-After", String(retryAfter));
    return limited;
  }

  if (!await verifyTurnstile(parsed.value.turnstileToken, ip)) {
    return response(origin, { error: "verification_failed" }, 403);
  }

  const followupDate = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  const { data, error } = await supabaseAdmin
    .from("leads")
    .insert({
      source: "website",
      customer_name: parsed.value.customerName,
      phone: parsed.value.phone,
      email: parsed.value.email,
      location: parsed.value.location,
      property_type: parsed.value.propertyType,
      service_needs: parsed.value.serviceNeeds,
      notes: parsed.value.notes,
      source_channel: parsed.value.attribution.utmMedium || "website",
      source_platform: parsed.value.attribution.utmSource || "website",
      landing_page: parsed.value.attribution.landingPage,
      referrer: parsed.value.attribution.referrer,
      fbclid: parsed.value.attribution.fbclid,
      meta_click_id: parsed.value.attribution.fbc,
      utm_source: parsed.value.attribution.utmSource,
      utm_medium: parsed.value.attribution.utmMedium,
      utm_campaign: parsed.value.attribution.utmCampaign,
      utm_content: parsed.value.attribution.utmContent,
      utm_term: parsed.value.attribution.utmTerm,
      campaign_id: parsed.value.attribution.campaignId,
      campaign_name: parsed.value.attribution.campaignName,
      adset_id: parsed.value.attribution.adsetId,
      adset_name: parsed.value.attribution.adsetName,
      ad_id: parsed.value.attribution.adId,
      ad_name: parsed.value.attribution.adName,
      meta_ad_id: parsed.value.attribution.adId,
      meta_campaign: parsed.value.attribution.campaignName,
      first_touch_at: new Date().toISOString(),
      raw_import_data: {
        intake: "newme.ae",
        event_id: parsed.value.attribution.eventId,
        fbp: parsed.value.attribution.fbp,
      },
      quality: "pending",
      stage: "new",
      assigned_to: null,
      next_action: "call",
      next_followup_date: followupDate,
    })
    .select("id")
    .single();

  if (error || !data?.id) {
    logger.error({
      route: "/api/public/leads",
      operation: "insert_website_lead",
      request_id: requestId,
      code: error?.code || "missing_inserted_id",
    }, "website_lead_insert_failed");
    return response(origin, { error: "temporarily_unavailable" }, 503);
  }

  const { error: taskError } = await createFollowUpTask(supabaseAdmin, {
    leadId: data.id,
    dueAt: followupDate,
    title: "Follow up website lead",
    assigneeId: null,
    source: "follow_up",
  });
  if (taskError) {
    logger.warn({
      route: "/api/public/leads",
      operation: "create_website_followup",
      request_id: requestId,
      lead_id: data.id,
      code: taskError.code,
    }, "website_lead_followup_failed");
  }

  try {
    await sendMetaCapiLead({
      leadId: data.id,
      input: parsed.value,
      clientIp: ip,
      clientUserAgent: request.headers.get("user-agent"),
    });
  } catch (capiError) {
    logger.warn({
      route: "/api/public/leads",
      operation: "send_meta_capi_lead",
      request_id: requestId,
      lead_id: data.id,
      error: capiError instanceof Error ? capiError.message : "unknown_error",
    }, "website_lead_capi_failed");
  }

  logger.info({
    route: "/api/public/leads",
    operation: "insert_website_lead",
    request_id: requestId,
    lead_id: data.id,
  }, "website_lead_created");
  return response(origin, { ok: true }, 201);
}
