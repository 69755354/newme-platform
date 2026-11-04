// RBAC: cron (x-cron-secret). PREPARED, NOT ENABLED: answers "Disabled" unless
// DAILY_DIGEST_ENABLED=true is set in the runtime environment (S7 item 8).
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createNotificationsBulk } from "@/lib/notifications";
import { logger } from "@/lib/logger";
import { buildDailyDigest, dubaiDate } from "@/lib/daily-digest.mjs";

export const dynamic = "force-dynamic";

const PAGE = 1000;
const MAX_PAGES = 20;

function secretMatches(provided: string | null): boolean {
  const expected = process.env.CRON_SECRET;
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handle(request: Request) {
  if (!secretMatches(request.headers.get("x-cron-secret"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (process.env.DAILY_DIGEST_ENABLED !== "true") {
    return NextResponse.json({ message: "Disabled", reason: "daily digest not enabled" }, { status: 200 });
  }
  try {
    const today = dubaiDate();
    const leads: Array<{ assigned_to: string | null; next_followup_date: string | null; stage: string | null }> = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const { data, error } = await supabaseAdmin
        .from("leads")
        .select("assigned_to,next_followup_date,stage")
        .not("assigned_to", "is", null)
        .lte("next_followup_date", today)
        .order("id")
        .range(page * PAGE, page * PAGE + PAGE - 1);
      if (error) throw new Error("lead_lookup_failed");
      leads.push(...(data ?? []));
      if (!data || data.length < PAGE) break;
      if (page === MAX_PAGES - 1) throw new Error("lead_pagination_limit_reached");
    }
    const { data: managers, error: managerError } = await supabaseAdmin
      .from("profiles").select("id").in("role", ["admin", "boss"]).eq("is_active", true);
    if (managerError) throw new Error("manager_lookup_failed");

    const drafts = buildDailyDigest({ leads, managers: managers ?? [], today });
    const result = await createNotificationsBulk(drafts);
    return NextResponse.json({ date: today, recipients: drafts.length, ...result });
  } catch (error) {
    const code = error instanceof Error && /^[a-z_]{3,48}$/.test(error.message) ? error.message : "digest_failed";
    logger.error({ operation: "daily_digest", code }, `daily digest failed: ${code}`);
    return NextResponse.json({ error: "digest_failed", code }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
