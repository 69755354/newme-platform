// RBAC: user (authenticated)
import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { parseCookieHeader } from '@/lib/supabase-server';
import { getAuthProfile, isAdminOrBoss } from '@/lib/lead-auth';

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
 * Auth: getAuthProfile + isAdminOrBoss + ownership (same as /quality)
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
  try {
    const cookieHeader = req.headers.get("cookie") ?? "";
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return parseCookieHeader(cookieHeader); },
          setAll() {},
        },
      }
    );

    const profile = await getAuthProfile();
    if (!profile) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

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
      return NextResponse.json(
        { error: 'eventType is required' },
        { status: 400 }
      );
    }
    if (!isAllowedEventType(rawType)) {
      return NextResponse.json(
        {
          error: `eventType must be one of: ${ALLOWED_EVENT_TYPES.join(', ')}`,
        },
        { status: 400 }
      );
    }
    const eventType: AllowedEventType = rawType;
    if (!description.trim()) {
      return NextResponse.json(
        { error: 'description is required' },
        { status: 400 }
      );
    }

    // Lead ownership check (mirror /quality): admin/boss → all leads,
    // sales → only assigned_to === profile.userId.
    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('id, assigned_to')
      .eq('id', leadId)
      .single();
    if (leadError || !lead) {
      return NextResponse.json({ error: 'Lead not found' }, { status: 404 });
    }
    if (!isAdminOrBoss(profile) && lead.assigned_to !== profile.userId) {
      return NextResponse.json(
        { error: 'Forbidden: lead not assigned to you' },
        { status: 403 }
      );
    }

    // INSERT business_events (canonical columns only).
    const { data: inserted, error: insertError } = await supabase
      .from('business_events')
      .insert({
        lead_id: leadId,
        user_id: profile.userId,
        event_type: eventType,
        event_data,
        description,
        created_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (insertError || !inserted) {
      return NextResponse.json(
        {
          error: 'Failed to write business_events row',
          detail: insertError?.message,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, eventId: inserted.id });
  } catch (e) {
    console.error('events route error:', e);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
