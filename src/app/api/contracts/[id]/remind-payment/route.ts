// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { createNotification } from "@/lib/notifications";
import { logger, genReqId } from "@/lib/logger";

/**
 * POST /api/contracts/[id]/remind-payment
 * Creates a notification for the assigned salesperson about overdue first payment.
 * Requires authentication.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const request_id = genReqId();
  const { id } = await params;
  try {    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const supabase = await createServerSupabase(bearerToken, cookieHeader);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Fetch the contract with sales person info
    const { data: contract, error: contractErr } = await supabase
      .from("contracts")
      .select(`
        id,
        organization_id,
        contract_no,
        contract_amount,
        party_a_name,
        first_payment_status,
        first_payment_due_date,
        sales_id,
        profiles!contracts_sales_id_fkey(full_name, email)
      `)
      .eq("id", id)
      .single();

    if (contractErr || !contract) {
      return NextResponse.json({ error: "Contract not found" }, { status: 404 });
    }

    // Verify user has permission (admin, boss, operator, or the sales person themselves)
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    const isAdmin = profile?.role && ["admin", "boss", "operator"].includes(profile.role);

    if (!isAdmin && contract.sales_id !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!contract.sales_id) {
      return NextResponse.json(
        { error: "Contract has no assigned sales person" },
        { status: 400 }
      );
    }

    // Determine urgency based on due date
    let urgencyText = "";
    if (contract.first_payment_due_date) {
      const dueDate = new Date(contract.first_payment_due_date);
      const today = new Date();
      const daysOverdue = Math.floor(
        (today.getTime() - dueDate.getTime()) / 86400000
      );
      if (daysOverdue > 0) {
        urgencyText = ` — ${daysOverdue} day${daysOverdue > 1 ? "s" : ""} overdue`;
      } else if (daysOverdue === 0) {
        urgencyText = " — due today";
      } else {
        urgencyText = ` — due in ${Math.abs(daysOverdue)} day${Math.abs(daysOverdue) > 1 ? "s" : ""}`;
      }
    }

    // Create notification for the sales person
    await createNotification({
      organizationId: contract.organization_id,
      userId: contract.sales_id,
      type: "first_payment_reminder",
      title: `First payment reminder: ${contract.contract_no}${urgencyText}`,
      body: `Contract ${contract.contract_no} (${contract.party_a_name || "Unknown"}) has first payment of AED ${contract.contract_amount?.toLocaleString() || "N/A"} that needs attention. Status: ${contract.first_payment_status || "unpaid"}.`,
      relatedId: contract.id,
      relatedType: "contract",
    });

    return NextResponse.json({
      success: true,
      message: `Reminder sent to sales person for contract ${contract.contract_no}`,
    });
  } catch (err: unknown) {
    const message =
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : err instanceof Error ? err.message : "Internal server error";
    logger.error(
      {
        err,
        request_id,
        operation: "contract_remind_payment",
        contract_id: id,
      },
      "[API Remind-payment] Error",
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
