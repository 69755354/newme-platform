import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { getAuthProfile, isAdminOrBoss } from '@/lib/lead-auth';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return cookieStore.getAll(); },
          setAll(cookiesToSet) {
            try {
              cookiesToSet.forEach(({ name, value, options }) =>
                cookieStore.set(name, value, options)
              );
            } catch {}
          },
        },
      }
    );

    const profile = await getAuthProfile();
    if (!profile) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: leadId } = await params;
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
        console.error('business_events insert failed (best-effort)', eventErr);
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
    console.error('quality route error:', e);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
