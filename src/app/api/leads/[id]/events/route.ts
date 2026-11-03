// RBAC: user (authenticated)
import { NextRequest, NextResponse } from 'next/server';
import {
  applyRequestAuthCookies,
  getRequestAuthContext,
  RequestAuthError,
  requestAuthErrorResponse,
  type RequestAuthContext,
} from '@/lib/request-auth-context';

/**
 * POST /api/leads/[id]/events
 *
 * P3-11 (task_P3_complete_cleanup) — centralise every business_events insert
 * behind a server-side route. Previously the client hook
 * useLeadDetailMutations called supabase.from('business_events').insert(...)
 * directly, which leaked canonical column ownership to the browser AND could
 * bypass RLS / CHECK constraints under schema drift. Mirrors the pattern
 * already established by /api/leads/[id]/quality.
 *
 * Body: { eventType: string, description: string, eventData?: Record<string, any> }
 * Auth: getRequestAuthContext + ownership (same as /quality).
 *
 * S3 #2: this route used to build its own Supabase client with the default
 * cookie names. The app's session cookies use custom names
 * (src/lib/supabase-cookie-names.ts), so that client was anonymous, RLS hid
 * every lead, and every call answered 404 "Lead not found" right after the
 * real save had succeeded. It now uses the shared request auth context.
 * Insert columns (canonical, mirror online DDL after migration
 *   20260706000003_quality_checked_event_check.sql): lead_id, user_id,
 *   event_type, event_data (JSONB), description, created_at.
 *   No actor_id — business_events uses user_id; actor_id is the audit_logs
 *   column (see proxy.ts + admin/impersonate annotation).
 *
 * The 20 allowed event_type values mirror the chk_event_type CHECK constraint
 * after migration 20260706000005_add_leads_archived.sql. A 400 is
 * returned for any other value so the client never silently writes a row that
 * the DB will reject.
 */
const ALLOWED_EVENT_TYPES = [
  'stage_change',
  'lead_stale_detected',
  'owner_change',
  'transfer',
  'quotation_sent',
  'quotation_accepted',
  'quotation_rejected',
  'won',
  'lost',
  'contract_activated',
  'contract_completed',
  'payment_recorded',
  'quality_checked',
  'project_info_updated',
  'note_added',
  'probability_changed',
  'status_changed',
  'lost_reason_set',
  'followup_scheduled',
  'leads_archived',
] as const;
type AllowedEventType = typeof ALLOWED_EVENT_TYPES[number];

function isAllowedEventType(v: string): v is AllowedEventType {
  return (ALLOWED_EVENT_TYPES as readonly string[]).includes(v);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let context: RequestAuthContext;
  try {
    context = await getRequestAuthContext(req);
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error);
    throw error;
  }
  const { supabase } = context;
  const respond = (body: Record<string, unknown>, init?: ResponseInit) =>
    applyRequestAuthCookies(context, NextResponse.json(body, init));
  try {
    const { id: leadId } = await params;
    const body = await req.json().catch(() => ({}));
    const rawType = (body?.eventType ?? '').toString().trim();
    const description = (body?.description ?? '').toString();
    const eventDataRaw = body?.eventData;
    // eventData must be a plain object (or absent) — never an array / primitive,
    // otherwise the JSONB column round-trips junk.
    const event_data =
      eventDataRaw && typeof eventDataRaw === 'object' && !Array.isArray(eventDataRaw)
        ? (eventDataRaw as Record<string, any>)
        : {};

    if (!rawType) {
      return respond(
        { error: 'eventType is required' },
        { status: 400 }
      );
    }
    if (!isAllowedEventType(rawType)) {
      return respond(
        {
          error: `eventType must be one of: ${ALLOWED_EVENT_TYPES.join(', ')}`,
        },
        { status: 400 }
      );
    }
    const eventType: AllowedEventType = rawType;
    if (description.length > 2000) {
      return respond({ error: 'description must be 2000 characters or fewer' }, { status: 400 });
    }
    if (!description.trim()) {
      return respond(
        { error: 'description is required' },
        { status: 400 }
      );
    }

    // Lead ownership check (mirror /quality): admin/boss/operator → all leads,
    // sales → only assigned_to === profile.userId.
    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('id, assigned_to')
      .eq('id', leadId)
      .single();
    if (leadError || !lead) {
      return respond({ error: 'Lead not found' }, { status: 404 });
    }
    if (!['admin', 'boss', 'operator'].includes(context.role) && lead.assigned_to !== context.user.id) {
      return respond(
        { error: 'Forbidden: lead not assigned to you' },
        { status: 403 }
      );
    }

    // INSERT business_events (canonical columns only).
    const { data: inserted, error: insertError } = await supabase
      .from('business_events')
      .insert({
        lead_id: leadId,
        user_id: context.user.id,
        event_type: eventType,
        event_data,
        description,
        created_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (insertError || !inserted) {
      return respond(
        {
          error: 'Failed to write business_events row',
          detail: insertError?.message,
        },
        { status: 500 }
      );
    }

    return respond({ success: true, eventId: inserted.id });
  } catch (e) {
    console.error('events route error:', e);
    return respond(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
