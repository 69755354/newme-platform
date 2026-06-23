import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

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

    // 1. Auth check
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 1. Role check
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const allowedRoles = ['admin', 'sales', 'manager'];
    if (!allowedRoles.includes(profile.role)) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }

    const { id: leadId } = await params;

    // Parse + validate body
    const body = await req.json();
    const {
      summary,
      contactType,
      nextAction,
      noAnswer,
    } = body as {
      summary: string;
      contactType?: string;
      nextAction?: string;
      noAnswer?: boolean;
    };

    if (!summary || typeof summary !== 'string' || !summary.trim()) {
      return NextResponse.json({ error: 'summary is required' }, { status: 400 });
    }

    // Verify lead exists
    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('id')
      .eq('id', leadId)
      .single();

    if (leadError || !lead) {
      return NextResponse.json({ error: 'Lead not found' }, { status: 404 });
    }

    // 2. INSERT follow_up_logs
    // rule_001: only INSERT — never expose UPDATE/DELETE
    const insertPayload = {
      lead_id: leadId,
      user_id: user.id,
      contact_type: contactType?.trim() || null,
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