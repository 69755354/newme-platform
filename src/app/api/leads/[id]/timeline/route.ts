import { NextRequest, NextResponse } from "next/server";
import {
  LeadOrganizationAccessError,
  resolveLeadOrganizationAccess,
} from "@/lib/lead-organization-access";
import { RequestAuthError } from "@/lib/request-auth-context";

interface TimelineEvent {
  id: string;
  event_type: string;
  description: string | null;
  created_at: string | null;
  metadata: Record<string, unknown>;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const leadId = (await context.params).id;
  let access;
  try {
    access = await resolveLeadOrganizationAccess(
      request,
      "lead:read",
      "lead_timeline",
      leadId,
    );
  } catch (error) {
    if (error instanceof LeadOrganizationAccessError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    if (error instanceof RequestAuthError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return NextResponse.json(
      { error: "lead_organization_access_unavailable" },
      { status: 503 },
    );
  }

  const supabase = access.client;
  let leadQuery = supabase
    .from("leads")
    .select("id")
    .eq("id", leadId)
    .eq("organization_id", access.organizationId);
  if (
    !access.supportSessionId
    && !["admin", "boss", "operator", "manager"].includes(access.context.role)
  ) {
    leadQuery = leadQuery.eq("assigned_to", access.context.user.id);
  }
  const { data: visibleLead, error: leadError } = await leadQuery.maybeSingle();
  if (leadError) {
    return NextResponse.json({ error: "lead_lookup_failed" }, { status: 503 });
  }
  if (!visibleLead) {
    return NextResponse.json({ error: "lead_not_found" }, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, Number.parseInt(searchParams.get("page") ?? "1", 10));
  const limit = Math.min(
    100,
    Math.max(1, Number.parseInt(searchParams.get("limit") ?? "20", 10)),
  );

  const results = await Promise.all([
    supabase.from("lead_milestones").select("*").eq("lead_id", leadId).not("completed_at", "is", null),
    supabase.from("follow_up_logs").select("*").eq("lead_id", leadId),
    supabase.from("tasks").select("*").eq("lead_id", leadId),
    supabase.from("lead_documents").select("*").eq("lead_id", leadId),
    supabase
      .from("chat_messages")
      .select("id, content, direction, created_at")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: true })
      .limit(200),
    supabase.from("activities").select("*").eq("lead_id", leadId),
    supabase.from("business_events").select("*").eq("lead_id", leadId),
  ]);
  const failedResult = results.find((result) => result.error);
  if (failedResult?.error) {
    return NextResponse.json(
      { error: "lead_timeline_fetch_failed" },
      { status: 503 },
    );
  }

  const milestones = results[0].data ?? [];
  const followUps = results[1].data ?? [];
  const tasks = results[2].data ?? [];
  const documents = results[3].data ?? [];
  const chats = results[4].data ?? [];
  const activities = results[5].data ?? [];
  const businessEvents = results[6].data ?? [];
  const events: TimelineEvent[] = [];

  for (const row of milestones) {
    events.push({
      id: `milestone-${row.id}`,
      event_type: "milestone",
      description: row.milestone_key ?? null,
      created_at: row.created_at,
      metadata: row,
    });
  }
  for (const row of followUps) {
    events.push({
      id: `follow_up-${row.id}`,
      event_type: "follow_up",
      description: row.summary ?? null,
      created_at: row.created_at,
      metadata: row,
    });
  }
  for (const row of tasks) {
    events.push({
      id: `task-${row.id}`,
      event_type: "task",
      description: row.title ?? null,
      created_at: row.created_at,
      metadata: row,
    });
  }
  for (const row of documents) {
    events.push({
      id: `document-${row.id}`,
      event_type: "document",
      description: row.file_name ?? null,
      created_at: row.created_at,
      metadata: row,
    });
  }
  for (const row of chats) {
    events.push({
      id: `chat-${row.id}`,
      event_type: "chat",
      description: row.content ?? null,
      created_at: row.created_at,
      metadata: { direction: row.direction ?? "inbound" },
    });
  }
  for (const row of activities) {
    events.push({
      id: `activity-${row.id}`,
      event_type: "activity",
      description: row.content ?? null,
      created_at: row.created_at,
      metadata: row,
    });
  }
  for (const row of businessEvents) {
    events.push({
      id: `business_event-${row.id}`,
      event_type: "business_event",
      description: row.description ?? null,
      created_at: row.created_at,
      metadata: row,
    });
  }

  events.sort(
    (left, right) =>
      new Date(right.created_at ?? 0).getTime()
      - new Date(left.created_at ?? 0).getTime(),
  );
  const offset = (page - 1) * limit;

  return NextResponse.json({
    organizationId: access.organizationId,
    events: events.slice(offset, offset + limit),
    total: events.length,
    page,
    limit,
  });
}
