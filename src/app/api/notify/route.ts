// RBAC: authenticated organization creators only.
import { NextRequest, NextResponse } from "next/server";
import {
  OrganizationAuthorizationError,
  resolveOrganizationAuthorization,
} from "@/lib/organization-authorization";
import { RequestAuthError } from "@/lib/request-auth-context";
import { createIntegrationLogSinks } from "@/lib/integration-execution.mjs";
import { genReqId, logger } from "@/lib/logger";
import {
  createNotificationsBulk,
  getAdminUserIds,
  VALID_NOTIFICATION_TYPES,
} from "@/lib/notifications";
import type { NotificationType } from "@/lib/notifications";

type BrowserEvent = "lead_created" | "quote_created";

const BROWSER_EVENT_CAPABILITY: Record<BrowserEvent, string> = {
  lead_created: "leads.write",
  quote_created: "organization.data.create",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function requiredId(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

/**
 * Temporary browser bridge for the two creation flows that still write via
 * RLS. All other notification types are system-only. Recipient, text, type,
 * organization, and the immutable replay key come from the canonical row.
 */
export async function POST(request: NextRequest) {
  const requestId = genReqId();
  try {
    let untrustedBody: unknown;
    try {
      untrustedBody = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }
    if (!isObject(untrustedBody) || typeof untrustedBody.type !== "string") {
      return NextResponse.json({ error: "invalid_notification_event" }, { status: 400 });
    }
    const requestedType = untrustedBody.type as NotificationType;
    if (!(requestedType in BROWSER_EVENT_CAPABILITY)) {
      const knownType = VALID_NOTIFICATION_TYPES.includes(requestedType);
      return NextResponse.json(
        { error: knownType ? "system_notification_event_forbidden" : "invalid_notification_event" },
        { status: knownType ? 403 : 400 },
      );
    }

    const type = requestedType as BrowserEvent;
    const access = await resolveOrganizationAuthorization(
      request,
      BROWSER_EVENT_CAPABILITY[type],
      "write",
    );
    const { supabase, user, profile } = access.context;
    const organizationId = access.organizationId;
    const adminIds = await getAdminUserIds(organizationId);

    if (type === "lead_created") {
      const leadId = requiredId(untrustedBody, "lead_id");
      if (!leadId) return NextResponse.json({ error: "lead_id_required" }, { status: 400 });
      const { data: lead, error } = await supabase
        .from("leads")
        .select("id, organization_id, customer_name, assigned_to, created_by")
        .eq("id", leadId)
        .eq("organization_id", organizationId)
        .maybeSingle();
      if (error) throw error;
      if (!lead) return NextResponse.json({ error: "lead_not_found" }, { status: 404 });
      if (lead.created_by !== user.id) {
        return NextResponse.json({ error: "notification_creator_required" }, { status: 403 });
      }
      const recipients = [...new Set([...adminIds, lead.assigned_to]
        .filter((id): id is string => Boolean(id && id !== user.id)))];
      await createNotificationsBulk(organizationId, recipients.map((userId) => ({
        userId,
        type,
        title: `New lead: ${lead.customer_name || "Lead"}`,
        body: `${profile.full_name || "A team member"} created this lead.`,
        relatedId: lead.id,
        relatedType: "lead",
        eventKey: `lead:${lead.id}:created`,
      })));
    } else {
      const quoteId = requiredId(untrustedBody, "quote_id");
      if (!quoteId) return NextResponse.json({ error: "quote_id_required" }, { status: 400 });
      const { data: quotation, error } = await supabase
        .from("quotations")
        .select("id, organization_id, quote_no, created_by")
        .eq("id", quoteId)
        .eq("organization_id", organizationId)
        .maybeSingle();
      if (error) throw error;
      if (!quotation) return NextResponse.json({ error: "quotation_not_found" }, { status: 404 });
      if (quotation.created_by !== user.id) {
        return NextResponse.json({ error: "notification_creator_required" }, { status: 403 });
      }
      await createNotificationsBulk(organizationId, adminIds
        .filter((id) => id !== user.id)
        .map((userId) => ({
          userId,
          type,
          title: `New quote: ${quotation.quote_no}`,
          body: `${profile.full_name || "A team member"} created this quotation.`,
          relatedId: quotation.id,
          relatedType: "quotation",
          eventKey: `quotation:${quotation.id}:created`,
        })));
    }

    const sinks = createIntegrationLogSinks({ logger, requestId, route: "/api/notify" });
    await sinks.audit({
      integration: "in_app_notification",
      operation: `creator_notification:${type}`,
      outcome: "success",
      attempts: 1,
      reason: null,
    });
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    if (error instanceof OrganizationAuthorizationError || error instanceof RequestAuthError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    logger.error({ err: error, request_id: requestId }, "[API Notify] failed");
    return NextResponse.json({ error: "notification_dispatch_failed" }, { status: 500 });
  }
}
