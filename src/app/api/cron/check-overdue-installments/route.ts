// RBAC: cron (x-cron-secret)
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

/**
 * GET /api/cron/check-overdue-installments
 * Cron endpoint: scans installment_plans and marks overdue items.
 * Called by external cron (Hermes) — validates via CRON_SECRET.
 */
export async function GET(request: NextRequest) {
  const cronSecret = request.headers.get("x-cron-secret");
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const today = new Date().toISOString().slice(0, 10);

    // Mark pending installments past due_date as overdue
    const { data: overdue, error: updateErr } = await supabaseAdmin
      .from("installment_plans")
      .update({ status: "overdue", updated_at: new Date().toISOString() })
      .in("status", ["pending", "partial"])
      .lt("due_date", today)
      .select("id, contract_id, seq, amount, due_date");

    if (updateErr) {
      console.error("[Cron Overdue] Update failed:", updateErr);
      return NextResponse.json({ error: "Update failed" }, { status: 500 });
    }

    // Notify about newly overdue installments
    const notified: string[] = [];
    if (overdue && overdue.length > 0) {
      for (const plan of overdue) {
        try {
          // Fetch contract info for context
          const { data: contract } = await supabaseAdmin
            .from("contracts")
            .select("contract_no, sales_id, lead_id")
            .eq("id", plan.contract_id)
            .single();

          if (contract) {
            await fetch(
              `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/api/notify`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  type: "payment_overdue",
                  contract_id: plan.contract_id,
                  lead_id: contract.lead_id,
                  installment_seq: plan.seq,
                  amount: plan.amount,
                  due_date: plan.due_date,
                }),
              }
            );
            notified.push(plan.id);
          }
        } catch {
          // non-blocking
        }
      }
    }

    return NextResponse.json({
      overdue_count: overdue?.length ?? 0,
      notified: notified.length,
    });
  } catch (err: unknown) {
    console.error("[Cron Overdue] Error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
