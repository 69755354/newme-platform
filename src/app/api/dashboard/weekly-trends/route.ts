// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { fetchAllRows } from "@/lib/fetch-all-rows.mjs";
import { inBounds, inWeek, recentDubaiWeeks } from "@/lib/dubai-time.mjs";
import { isWonLead, wonLeadValue } from "@/lib/lead-metrics.mjs";
import { createServerSupabase } from "@/lib/supabase-server";
import { applyPrivateNoStore } from "@/lib/request-auth-context";

// R5: the collection curve below is derived from payments, so this read is
// force-dynamic and private/no-store like every other money-derived read.
export const dynamic = "force-dynamic";

function finiteAmount(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * GET /api/dashboard/weekly-trends
 *
 * Returns past 12 weeks of lead/signed/conversion/collection data.
 * CEO/Admin: all data.
 * Sales: filtered by assigned_to = current user.
 */
export async function GET(request: NextRequest) {
  try {
    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader);
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    const role = profile?.role || "sales";
    const isManagement = ["boss", "admin", "operator"].includes(role);
    const userId = user.id;

    // ─── Compute past 12 weeks (Dubai Monday-Sunday weeks, ISO week numbers) ───
    const weeks = recentDubaiWeeks(12);

    // ─── Fetch leads in the 12-week range ───
    const rangeStart = weeks[0].start.toISOString();
    const rangeEnd = weeks[weeks.length - 1].end.toISOString();
    const rangeStartDate = weeks[0].startKey;
    const rangeEndDate = weeks[weeks.length - 1].endKey;

    const leadsResult = await fetchAllRows((from, to, withCount) => {
      let q = supabase
        .from("leads")
        .select("id, created_at, stage, quotation_value, assigned_to, final_status", withCount ? { count: "exact" } : undefined)
        .eq("archived", false)
        .gte("created_at", rangeStart)
        .lt("created_at", rangeEnd);
      if (!isManagement) q = q.eq("assigned_to", userId);
      return q.order("id", { ascending: true }).range(from, to);
    });
    if (leadsResult.error) throw leadsResult.error;
    const leads = leadsResult.data as any[];

    // ─── Fetch leads won in the range (for signed amount) ───
    // Signed in a week = won in that Dubai week (won_at), the one shared won amount.
    const wonResult = await fetchAllRows((from, to, withCount) => {
      let q = supabase
        .from("leads")
        .select("id, final_status, stage, archived, quotation_value, won_at", withCount ? { count: "exact" } : undefined)
        .eq("archived", false)
        .eq("final_status", "won")
        .gte("won_at", rangeStart)
        .lt("won_at", rangeEnd);
      if (!isManagement) q = q.eq("assigned_to", userId);
      return q.order("id", { ascending: true }).range(from, to);
    });
    if (wonResult.error) throw wonResult.error;
    const wonInRange = wonResult.data as any[];

    // ─── Fetch payments (for collected amount) ───
    //
    // R5: `confirmed = true` alone was a second, looser definition of cash. Every
    // derived total in the database counts `confirmed = true and voided_at is null`
    // (src/lib/payment-state.mjs names that predicate for JavaScript), so a voided
    // payment whose `confirmed` flag was set by a direct compat-mode write counted
    // as collected here and not in kpi_targets.actual_amount — two collection
    // curves for one month. The set is selected in SQL, so the predicate belongs in
    // SQL too; nothing below re-derives it from the row.
    // payment_date is a DATE: compared with Dubai calendar dates. A sales caller's
    // payments are scoped by joining to the contract, not by a list of ids.
    const paymentsResult = await fetchAllRows((from, to, withCount) => {
      let q = supabase
        .from("payments")
        .select(
          isManagement ? "id, amount, payment_date, contract_id" : "id, amount, payment_date, contract_id, contracts!inner(sales_id)",
          withCount ? { count: "exact" } : undefined,
        )
        .gte("payment_date", rangeStartDate)
        .lte("payment_date", rangeEndDate)
        .eq("confirmed", true)
        .is("voided_at", null);
      if (!isManagement) q = q.eq("contracts.sales_id", userId);
      return q.order("id", { ascending: true }).range(from, to);
    });
    if (paymentsResult.error) throw paymentsResult.error;
    const payments = paymentsResult.data as any[];

    // ─── Build weekly data ───
    const weeklyData = weeks.map((week) => {
      // New leads in this week
      const newLeads = (leads || []).filter((lead) => inBounds(lead.created_at, week));

      // Won leads in this week (using leads table)
      const wonLeads = newLeads.filter((l) => isWonLead(l));

      // Signed amount: leads won this week (won_at), shared won amount.
      const signedAmount = wonInRange.reduce(
        (sum, lead) => (inBounds(lead.won_at, week) ? sum + wonLeadValue(lead) : sum),
        0,
      );

      // Collection amount from payments confirmed this week
      const weekPayments = (payments || []).filter((payment) =>
        inWeek(payment.payment_date, week)
      );

      const collectedAmount = weekPayments.reduce((sum, payment) => {
        const amount = finiteAmount(payment.amount);
        return amount === null ? sum : sum + amount;
      }, 0);

      const newCount = newLeads.length;
      const wonCount = wonLeads.length;
      const conversionRate =
        newCount > 0 ? Math.round((wonCount / newCount) * 10000) / 100 : 0;

      return {
        year: week.year,
        week: week.week,
        start_date: week.startKey,
        end_date: week.endKey,
        new_leads: newCount,
        signed_amount: Math.round(signedAmount * 100) / 100,
        conversion_rate: conversionRate,
        collected_amount: Math.round(collectedAmount * 100) / 100,
      };
    });

    // ─── WoW Comparison (current week vs previous week) ───
    const currentWeek = weeklyData[weeklyData.length - 1];
    const prevWeek = weeklyData[weeklyData.length - 2];

    const calcWow = (
      current: number,
      previous: number
    ): { change_pct: number | null; direction: "up" | "down" | "flat" } => {
      if (previous === 0) {
        return current > 0
          ? { change_pct: 100, direction: "up" }
          : { change_pct: 0, direction: "flat" };
      }
      const pct = Math.round(((current - previous) / previous) * 10000) / 100;
      return {
        change_pct: Math.abs(pct),
        direction: pct > 0 ? "up" : pct < 0 ? "down" : "flat",
      };
    };

    const wowComparison = {
      new_leads: calcWow(currentWeek.new_leads, prevWeek.new_leads),
      signed_amount: calcWow(
        currentWeek.signed_amount,
        prevWeek.signed_amount
      ),
      conversion_rate: calcWow(
        currentWeek.conversion_rate,
        prevWeek.conversion_rate
      ),
      collected_amount: calcWow(
        currentWeek.collected_amount,
        prevWeek.collected_amount
      ),
    };

    return applyPrivateNoStore(
      NextResponse.json({
        weeks: weeklyData,
        wow_comparison: wowComparison,
      }),
    );
  } catch (err: any) {
    console.error("[Weekly Trends] Error:", err);
    const message =
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : err.message;
    return NextResponse.json(
      { error: message || "Failed to fetch weekly trends" },
      { status: 500 }
    );
  }
}
