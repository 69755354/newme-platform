// RBAC: user (authenticated)
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase-server';
import { logger, genReqId } from '@/lib/logger';
import { getAuthProfile, isAdminOrBoss } from '@/lib/lead-auth';
import { isCompleteContact } from '@/modules/leads/first-contact-gate.mjs';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const request_id = genReqId();
  const { id: leadId } = await params;
  try {
    const cookieHeader = req.headers.get("cookie") ?? "";
    const bearerToken = req.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const supabase = await createServerSupabase(bearerToken, cookieHeader);
    const profile = await getAuthProfile(bearerToken, cookieHeader);
    if (!profile) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const rawQuality = (body?.quality ?? '').toString().toLowerCase().trim();
    const ALLOWED = ['poor', 'normal', 'good'] as const;
    if (!ALLOWED.includes(rawQuality as typeof ALLOWED[number])) {
      return NextResponse.json(
        { error: 'quality must be one of: poor, normal, good' },
        { status: 400 }
      );
    }
    const quality = rawQuality as typeof ALLOWED[number];
    const poor_reason_raw = (body?.poor_reason ?? '').toString().trim();
    if (quality === 'poor' && poor_reason_raw.length < 3) {
      return NextResponse.json(
        { error: 'poor_reason is required when quality is poor (min 3 chars)' },
        { status: 400 }
      );
    }
    const poor_reason = quality === 'poor' ? poor_reason_raw : null;

    // Lead ownership check
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

    // Quality may be assessed after the first complete contact, never before.
    const { data: contacts, error: contactError } = await supabase
      .from('follow_up_logs')
      .select('contact_time, contact_result')
      .eq('lead_id', leadId);

    if (contactError) {
      return NextResponse.json(
        { error: 'Unable to verify contact records' },
        { status: 500 }
      );
    }
    if (!(contacts ?? []).some(isCompleteContact)) {
      return NextResponse.json(
        { error: 'At least one complete contact record is required before setting Lead Quality' },
        { status: 409 }
      );
    }

    // UPDATE leads.quality
    const { data: updated, error: updateError } = await supabase
      .from('leads')
      .update({ quality, poor_reason, updated_at: new Date().toISOString() })
      .eq('id', leadId)
      .select('id, quality, poor_reason, updated_at')
      .single();
    if (updateError || !updated) {
      return NextResponse.json(
        { error: 'Failed to update quality', detail: updateError?.message },
        { status: 500 }
      );
    }

    // INSERT business_events (best-effort, do not fail request)
    let eventLogged = false;
    let eventError: string | null = null;
    try {
      const { error: eventErr } = await supabase.from('business_events').insert({
        lead_id: leadId,
        user_id: profile.userId,
        event_type: 'quality_checked',
        event_data: { quality, poor_reason },
        created_at: new Date().toISOString(),
      });
      if (eventErr) {
        eventError = eventErr.message;
        logger.error(
          {
            err: eventErr,
            request_id,
            operation: 'quality_update',
            lead_id: leadId,
          },
          'business_events insert failed (best-effort)',
        );
      } else {
        eventLogged = true;
      }
    } catch (e) {
      eventError = (e as Error).message;
    }

    return NextResponse.json({
      success: true,
      leadId: updated.id,
      quality: updated.quality,
      poor_reason: updated.poor_reason,
      updatedAt: updated.updated_at,
      eventLogged,
      ...(eventError && process.env.NODE_ENV !== 'production' ? { eventError } : {}),
    });
  } catch (e) {
    logger.error(
      {
        err: e,
        request_id,
        operation: 'quality_update',
        lead_id: leadId,
      },
      'quality route error',
    );
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
