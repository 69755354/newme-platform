import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/models/supabase-server";
import { supabaseAdmin } from "@/models/supabase-admin";

// ─── Auth check — only boss/admin ───
async function checkAdminOrBoss(): Promise<NextResponse | null> {
  const supabase = await createServerSupabase();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();

  if (authErr || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: profile, error: profileErr } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profileErr || !profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 403 });
  }

  if (profile.role !== "admin" && profile.role !== "boss") {
    return NextResponse.json(
      { error: "Insufficient permissions. Admin or Boss role required." },
      { status: 403 },
    );
  }

  return null; // allowed
}

// ─── GET /api/activity/daily-report?date=YYYY-MM-DD ───
export async function GET(request: NextRequest) {
  const forbidden = await checkAdminOrBoss();
  if (forbidden) return forbidden;

  const { searchParams } = new URL(request.url);
  const dateParam = searchParams.get("date");

  if (!dateParam || !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return NextResponse.json(
      { error: "Invalid or missing 'date' parameter. Expected format: YYYY-MM-DD" },
      { status: 400 },
    );
  }

  // Build day range in UTC
  const dayStart = `${dateParam}T00:00:00.000Z`;
  const dayEnd = `${dateParam}T23:59:59.999Z`;

  // Query both tables in parallel using service role (bypasses RLS)
  const [activitiesResult, eventsResult] = await Promise.all([
    supabaseAdmin
      .from("activities")
      .select("user_id, type, content, created_at")
      .gte("created_at", dayStart)
      .lte("created_at", dayEnd)
      .order("created_at", { ascending: true }),
    supabaseAdmin
      .from("business_events")
      .select("user_id, event_type, description, created_at")
      .gte("created_at", dayStart)
      .lte("created_at", dayEnd)
      .order("created_at", { ascending: true }),
  ]);

  if (activitiesResult.error) {
    console.error("[daily-report] activities query error:", activitiesResult.error);
    return NextResponse.json(
      { error: "Failed to query activities" },
      { status: 500 },
    );
  }

  if (eventsResult.error) {
    console.error("[daily-report] business_events query error:", eventsResult.error);
    return NextResponse.json(
      { error: "Failed to query business_events" },
      { status: 500 },
    );
  }

  const activities = activitiesResult.data || [];
  const businessEvents = eventsResult.data || [];

  // Collect all unique user_ids
  const userIdSet = new Set<string>();
  for (const a of activities) {
    if (a.user_id) userIdSet.add(a.user_id);
  }
  for (const e of businessEvents) {
    if (e.user_id) userIdSet.add(e.user_id);
  }

  // Fetch user names from profiles
  const userIds = Array.from(userIdSet);
  let userNameMap: Record<string, string> = {};

  if (userIds.length > 0) {
    const { data: profiles, error: profileErr } = await supabaseAdmin
      .from("profiles")
      .select("id, full_name")
      .in("id", userIds);

    if (profileErr) {
      console.error("[daily-report] profiles query error:", profileErr);
    } else if (profiles) {
      for (const p of profiles) {
        userNameMap[p.id] = p.full_name || p.id;
      }
    }
  }

  // Aggregate by user_id
  const userMap = new Map<
    string,
    {
      user_id: string;
      user_name: string;
      events: { type: string; content: string; created_at: string }[];
      timestamps: string[];
    }
  >();

  const addUser = (userId: string) => {
    if (!userId) return;
    if (!userMap.has(userId)) {
      userMap.set(userId, {
        user_id: userId,
        user_name: userNameMap[userId] || userId,
        events: [],
        timestamps: [],
      });
    }
  };

  // Process activities
  for (const a of activities) {
    if (!a.user_id) continue;
    addUser(a.user_id);
    const entry = userMap.get(a.user_id)!;
    entry.events.push({
      type: a.type,
      content: a.content || "",
      created_at: a.created_at,
    });
    entry.timestamps.push(a.created_at);
  }

  // Process business_events
  for (const e of businessEvents) {
    if (!e.user_id) continue;
    addUser(e.user_id);
    const entry = userMap.get(e.user_id)!;
    entry.events.push({
      type: e.event_type,
      content: e.description || "",
      created_at: e.created_at,
    });
    entry.timestamps.push(e.created_at);
  }

  // Build final result — sort events by created_at and compute first/last active
  const report = Array.from(userMap.values()).map((entry) => {
    // Sort all events chronologically
    entry.events.sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    entry.timestamps.sort();

    return {
      user_id: entry.user_id,
      user_name: entry.user_name,
      first_active_at: entry.timestamps[0] || null,
      last_active_at: entry.timestamps[entry.timestamps.length - 1] || null,
      events: entry.events,
    };
  });

  // Sort report by user_name
  report.sort((a, b) => a.user_name.localeCompare(b.user_name));

  return NextResponse.json({ date: dateParam, report });
}
