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

    // rule_102: use auth.getUser() via SSR client, NOT service_role
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll(cookiesToSet) {
            try {
              cookiesToSet.forEach(({ name, value, options }) =>
                cookieStore.set(name, value, options)
              );
            } catch {
              // read-only in some contexts
            }
          },
        },
      }
    );

    // 1. Auth + role check
    const profile = await getAuthProfile();
    if (!profile) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: leadId } = await params;

    // Parse + validate body
    const body = await req.json();
    const {
      summary,
      contactType,
      nextAction,
      noAnswer,
      contactTime,
    } = body as {
      summary: string;
      contactType?: string;
      nextAction?: string;
      noAnswer?: boolean;
      contactTime?: string;
    };

    if (!summary || typeof summary !== 'string' || !summary.trim()) {
      return NextResponse.json({ error: 'summary is required' }, { status: 400 });
    }
    const parsedContactTime = contactTime ? new Date(contactTime) : null;
    if (!parsedContactTime || Number.isNaN(parsedContactTime.getTime())) {
      return NextResponse.json({ error: 'contactTime is required (ISO string)' }, { status: 400 });
    }

    // Verify lead exists + ownership
    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('id, assigned_to')
      .eq('id', leadId)
      .single();

    if (leadError || !lead) {
      return NextResponse.json({ error: 'Lead not found' }, { status: 404 });
    }

    // Non-admin/boss may only write follow-ups to leads they own (rule_idor)
    if (!isAdminOrBoss(profile) && lead.assigned_to !== profile.userId) {
      return NextResponse.json(
        { error: 'Forbidden: lead not assigned to you' },
        { status: 403 }
      );
    }

    // 2. INSERT follow_up_logs
    // rule_001: only INSERT — never expose UPDATE/DELETE
    const insertPayload = {
      lead_id: leadId,
      user_id: profile.userId,
      contact_type: contactType?.trim() || null,
      contact_time: parsedContactTime.toISOString(),
      summary: summary.trim(),
      result: noAnswer ? 'no_answer' : 'contacted',
      no_answer: Boolean(noAnswer),
      next_action: nextAction?.trim() || null,
    };

    const { data: followUp, error: insertError } = await supabase
      .from('follow_up_logs')
      .insert(insertPayload)
      .select('*')
      .single();

    if (insertError) {
      console.error('[follow-up] insert error:', insertError);
      return NextResponse.json(
        { error: 'Failed to record follow-up', detail: insertError.message },
        { status: 500 }
      );
    }

    // 3. If nextAction present → trg_auto_create_task auto-creates tasks
    // rule_002: trigger sets due_at = now() + 24h (handled in DB)
    const taskCreated = Boolean(nextAction && nextAction.trim().length > 0);

    // 4. Response
    return NextResponse.json({
      success: true,
      followUp,
      taskCreated,
    });
  } catch (err) {
    console.error('[follow-up] unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}