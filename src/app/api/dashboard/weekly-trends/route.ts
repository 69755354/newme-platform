// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

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

    // ─── Compute past 12 ISO weeks ───
    const weeks: { year: number; week: number; start: string; end: string }[] = [];
    const now = new Date();

    // Get current ISO week start (Monday)
    const dayOfWeek = now.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const currentMonday = new Date(now);
    currentMonday.setDate(now.getDate() + mondayOffset);
    currentMonday.setHours(0, 0, 0, 0);

    for (let i = 11; i >= 0; i--) {
      const start = new Date(currentMonday);
      start.setDate(currentMonday.getDate() - i * 7);
      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      end.setHours(23, 59, 59, 999);

      // ISO week number
      const temp = new Date(start);
      const dayNum = (temp.getDay() + 6) % 7;
      temp.setDate(temp.getDate() - dayNum + 3);
      const firstThursday = temp.getTime();
      const yearStart = new Date(temp.getFullYear(), 0, 1).getTime();
      const weekNum =
        1 + Math.round(
          (firstThursday - yearStart) / 86_400_000 / 7
        );

      weeks.push({
        year: start.getFullYear(),
        week: weekNum,
        start: start.toISOString(),
        end: end.toISOString(),
      });
    }

    // ─── Fetch leads in the 12-week range ───
    const rangeStart = weeks[0].start;
    const rangeEnd = weeks[weeks.length - 1].end;

    let leadsQuery = supabase
      .from("leads")
      .select("id, created_at, stage, quotation_value, assigned_to, final_status")
      .eq("archived", false)
      .gte("created_at", rangeStart)
      .lte("created_at", rangeEnd);

    if (!isManagement) {
      leadsQuery = leadsQuery.eq("assigned_to", userId);
    }

    const { data: leads, error: leadsErr } = await leadsQuery;
    if (leadsErr) throw leadsErr;

    // ─── Fetch contracts (for signed amount) ───
    let contractsQuery = supabase
      .from("contracts")
      .select("id, contract_amount, created_at, status, sales_id")
      .gte("created_at", rangeStart)
      .lte("created_at", rangeEnd);

    if (!isManagement) {
      contractsQuery = contractsQuery.eq("sales_id", userId);
    }

    const { data: contracts, error: contractsErr } = await contractsQuery;
    if (contractsErr) throw contractsErr;

    // ─── Fetch payments (for collected amount) ───
    let paymentsQuery = supabase
      .from("payments")
      .select("id, amount, confirmed, payment_date, contract_id")
      .gte("payment_date", rangeStart)
      .lte("payment_date", rangeEnd)
      .eq("confirmed", true);

    let payments: any[] = [];

    if (!isManagement) {
      // Get user's contract IDs first
      const { data: userContracts } = await supabase
        .from("contracts")
        .select("id")
        .eq("sales_id", userId);

      const userContractIds = (userContracts || []).map((c: any) => c.id);
      if (userContractIds.length > 0) {
        paymentsQuery = paymentsQuery.in("contract_id", userContractIds);
        const { data: p, error: paymentsErr } = await paymentsQuery;
        if (paymentsErr) throw paymentsErr;
        payments = p || [];
      }
      // else: no contracts → payments stays empty, skip query
    } else {
      const { data: p, error: paymentsErr } = await paymentsQuery;
      if (paymentsErr) throw paymentsErr;
      payments = p || [];
    }

    // ─── Build weekly data ───
    const weeklyData = weeks.map((week) => {
      // New leads in this week
      const newLeads = (leads || []).filter((l) => {
        const created = new Date(l.created_at);
        return created >= new Date(week.start) && created <= new Date(week.end);
      });

      // Won leads in this week (using leads table)
      const wonLeads = newLeads.filter((l) => l.final_status === "won");

      // Signed amount from contracts created this week
      const weekContracts = (contracts || []).filter((c) => {
        const created = new Date(c.created_at);
        return (
          created >= new Date(week.start) &&
          created <= new Date(week.end) &&
          c.status !== "terminated"
        );
      });

      const signedAmount = weekContracts.reduce(
        (sum, c) => sum + (parseFloat(c.contract_amount as any) || 0),
        0
      );

      // Collection amount from payments confirmed this week
      const weekPayments = (payments || []).filter((p) => {
        const paid = new Date(p.payment_date);
        return paid >= new Date(week.start) && paid <= new Date(week.end);
      });

      const collectedAmount = weekPayments.reduce(
        (sum, p) => sum + (parseFloat(p.amount as any) || 0),
        0
      );

      const newCount = newLeads.length;
      const wonCount = wonLeads.length;
      const conversionRate =
        newCount > 0 ? Math.round((wonCount / newCount) * 10000) / 100 : 0;

      return {
        year: week.year,
        week: week.week,
        start_date: week.start.split("T")[0],
        end_date: week.end.split("T")[0],
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

    return NextResponse.json({
      weeks: weeklyData,
      wow_comparison: wowComparison,
    });
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
