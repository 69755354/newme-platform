// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/lib/supabase-server";
import { logger, genReqId } from "@/lib/logger";
import { moneyRpcFailure } from "@/lib/money-rpc.mjs";
import type { Database, Json } from "@/types/database";

/**
 * POST /api/contracts
 * Creates a contract with its installment schedule and its first approval row.
 * Requires authentication via session cookie.
 *
 * One call to create_contract(jsonb), which does all three inserts in a single
 * transaction as the definer. What this replaces:
 *
 *   - a duplicate pre-check read through the CALLER's client, so a sales user
 *     could not see a colleague's contract on the same lead and got a 500 from
 *     idx_contracts_one_active_per_lead instead of the intended 409;
 *   - a contract number derived from a caller-visible COUNT, which for the same
 *     reason produced a number that already existed;
 *   - three separate transactions, where a failed installment insert returned
 *     HTTP 200 with `warning` (a signed contract with no payment schedule) and a
 *     failed contract_approvals insert was only logged (a contract that can
 *     never be approved), both reported as success.
 *
 * The direct inserts are also refused now: trg_guard_contracts_write raises
 * 42501 for any INSERT arriving as the `authenticated` role.
 */
export async function POST(request: NextRequest) {
  const request_id = genReqId();
  try {
    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader);
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const {
      lead_id,
      amount,
      currency,
      party_a_name,
      party_a_contact,
      party_b_name,
      installments,
      first_payment_due_date,
    } = body;

    if (!lead_id) {
      return NextResponse.json({ error: "lead_id is required" }, { status: 400 });
    }
    if (!amount || typeof amount !== "number" || amount <= 0) {
      return NextResponse.json({ error: "Valid amount is required" }, { status: 400 });
    }

    // seq defaults to position, not 1: `inst.seq || 1` gave every installment
    // seq 1 when the client omitted it, and installment_plans has a UNIQUE
    // (contract_id, seq).
    //
    // The schedule is validated here as well as in assert_installment_schedule(),
    // and the duplication is deliberate. The database is the authority — it refuses
    // the same cases with 22023 for every caller, not just this route — but what it
    // cannot do is tell the client WHICH field of its payload was wrong before the
    // contract number is drawn. What this replaces is worse than a poor message: a
    // non-array `installments` became `[]` and a non-numeric amount became 0, so a
    // client that sent a malformed schedule got a signed contract with no payment
    // schedule, or one that did not add up, and HTTP 201.
    if (!Array.isArray(installments) || installments.length === 0) {
      return NextResponse.json(
        { error: "A contract needs an installment schedule: installments must be a non-empty array", code: "INVALID_SCHEDULE" },
        { status: 400 },
      );
    }

    const schedule = installments.map((inst: any, index: number) => ({
      seq: Number.isFinite(inst?.seq) ? Number(inst.seq) : index + 1,
      amount: Number.isFinite(inst?.amount) ? Number(inst.amount) : NaN,
      due_date: inst?.due_date || null,
      description: typeof inst?.description === "string" ? inst.description : "",
    }));

    const seen = new Set<number>();
    for (const [index, inst] of schedule.entries()) {
      const position = index + 1;
      if (!Number.isFinite(inst.amount) || inst.amount <= 0) {
        return NextResponse.json(
          { error: `Installment ${position} needs a positive amount`, code: "INVALID_SCHEDULE" },
          { status: 400 },
        );
      }
      if (!Number.isInteger(inst.seq) || inst.seq <= 0) {
        return NextResponse.json(
          { error: `Installment ${position} has an invalid position`, code: "INVALID_SCHEDULE" },
          { status: 400 },
        );
      }
      if (seen.has(inst.seq)) {
        return NextResponse.json(
          { error: `Installment position ${inst.seq} appears more than once`, code: "INVALID_SCHEDULE" },
          { status: 400 },
        );
      }
      seen.add(inst.seq);
      if (inst.due_date !== null && Number.isNaN(Date.parse(String(inst.due_date)))) {
        return NextResponse.json(
          { error: `Installment ${position} has an invalid due date`, code: "INVALID_SCHEDULE" },
          { status: 400 },
        );
      }
    }

    // Compared in cents. 0.1 + 0.2 !== 0.3 in this language, and a schedule that
    // is off by a rounding error is exactly the case the client is most likely to
    // send, so summing the floats and comparing to `amount` would reject valid
    // schedules and accept invalid ones by turns.
    const scheduledCents = schedule.reduce((sum, inst) => sum + Math.round(inst.amount * 100), 0);
    const contractCents = Math.round(amount * 100);
    if (scheduledCents !== contractCents) {
      return NextResponse.json(
        {
          error: `The installment schedule totals ${(scheduledCents / 100).toFixed(2)} but the contract totals ${(contractCents / 100).toFixed(2)}`,
          code: "INVALID_SCHEDULE",
        },
        { status: 400 },
      );
    }

    const { data: created, error: rpcErr } = await supabase.rpc("create_contract", {
      p_payload: {
        // The claim is checked against the token subject inside money_actor():
        // a mismatching actor_id raises 42501 rather than being trusted.
        actor_id: user.id,
        lead_id,
        amount,
        currency: currency || null,
        party_a_name: party_a_name || null,
        party_a_contact: party_a_contact || null,
        party_b_name: party_b_name || null,
        first_payment_due_date: first_payment_due_date || null,
        installments: schedule,
      } as Json,
    });

    if (rpcErr) {
      const failure = moneyRpcFailure(rpcErr, "Failed to create contract");
      const log = failure.status >= 500 ? logger.error : logger.warn;
      log(
        {
          err: rpcErr,
          request_id,
          operation: "contract_create",
          user_id: user.id,
          lead_id,
          error_code: rpcErr.code,
          http_status: failure.status,
        },
        "[API Contracts] create_contract refused the request",
      );
      return NextResponse.json(failure.body, { status: failure.status });
    }

    const contract = created as {
      id: string;
      contract_no: string;
      status: string;
      installments_count: number;
    };

    // Notify admins that contract is pending approval
    try {
      await fetch(`${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/api/notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "contract_pending_approval",
          contract_id: contract.id,
          contract_no: contract.contract_no,
          lead_id,
          amount,
        }),
      });
    } catch (notifyErr) {
      logger.warn(
        {
          err: notifyErr,
          request_id,
          operation: "contract_create",
          user_id: user.id,
          contract_id: contract.id,
        },
        "[API Contracts] Notification failed",
      );
    }

    revalidatePath("/contracts");
    revalidatePath("/leads");

    return NextResponse.json(
      {
        id: contract.id,
        contract_no: contract.contract_no,
        status: contract.status,
        installments_count: contract.installments_count,
      },
      { status: 201 },
    );
  } catch (err: any) {
    const message = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    logger.error(
      {
        err,
        request_id,
        operation: "contract_create",
      },
      "[API Contracts] POST Error",
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * GET /api/contracts — list contracts with optional filters
 */
export async function GET(request: NextRequest) {
  const request_id = genReqId();
  try {
    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader);
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Fetch user role for access control
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    if (!profile?.role) {
      return NextResponse.json({ error: "Profile not found" }, { status: 403 });
    }

    const userRole = profile.role;

    // Deny access to roles that shouldn't see contracts
    if (!["admin", "boss", "sales", "finance", "operator"].includes(userRole)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const leadId = searchParams.get("lead_id");

    let q = supabase.from("contracts").select("*, installment_plans(*)").order("created_at", { ascending: false });
    if (leadId) q = q.eq("lead_id", leadId);

    // sales role: only see own contracts
    if (userRole === "sales") {
      q = q.eq("sales_id", user.id);
    }
    // admin/boss/finance/operator: see all (no additional filter)

    const { data, error } = await q;
    if (error) {
      return NextResponse.json({ error: "Failed to fetch contracts" }, { status: 500 });
    }
    return NextResponse.json({ data });
  } catch (err: any) {
    logger.error(
      {
        err,
        request_id,
        operation: "contract_list",
      },
      "[API Contracts] GET Error",
    );
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * PUT /api/contracts — update the first payment's DUE DATE.
 * Body: { id: string, first_payment_due_date?: string }
 *
 * first_payment_status is no longer accepted. It is derived from confirmed,
 * unvoided allocations against the first installment by
 * contract_first_payment_status(), and confirm_payment(), allocate_payment() and
 * void_payment() are the only writers; trg_guard_contracts_write raises 42501 for
 * anyone else, so sending it here would produce a 500 rather than an update.
 *
 * It used to be writable by the contract's own salesperson, which is finding B2:
 * "the customer paid the deposit" was a field a salesperson could type rather than
 * a fact derived from the money received, and every report built on it inherited
 * that. The request is refused with 409 rather than ignored, because a client that
 * believes it set the status and is told "success" is the failure mode being fixed.
 */
export async function PUT(request: NextRequest) {
  const request_id = genReqId();
  try {
    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader);
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { id, first_payment_status, first_payment_due_date } = body;

    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    // Verify user owns this contract or is admin
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    const isAdmin = profile?.role && ["admin", "boss", "operator"].includes(profile.role);

    if (!isAdmin) {
      const { data: contract } = await supabase
        .from("contracts")
        .select("sales_id")
        .eq("id", id)
        .single();
      if (!contract || contract.sales_id !== user.id) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    const updates: Database["public"]["Tables"]["contracts"]["Update"] = {};
    if (first_payment_status !== undefined) {
      return NextResponse.json(
        {
          error:
            "first_payment_status is derived from confirmed payments and cannot be set directly; confirm or allocate a payment instead",
          code: "DERIVED_FIELD",
        },
        { status: 409 },
      );
    }
    if (first_payment_due_date !== undefined) {
      updates.first_payment_due_date = first_payment_due_date;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    updates.updated_at = new Date().toISOString();

    const { error } = await supabase
      .from("contracts")
      .update(updates)
      .eq("id", id);

    if (error) {
      logger.error(
        {
          err: error,
          request_id,
          operation: "contract_update",
          user_id: user.id,
          contract_id: id,
        },
        "[API Contracts] Update failed",
      );
      return NextResponse.json({ error: "Failed to update contract" }, { status: 500 });
    }

    revalidatePath("/contracts");

    return NextResponse.json({ success: true });
  } catch (err: any) {
    const message = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    logger.error(
      {
        err,
        request_id,
        operation: "contract_update",
      },
      "[API Contracts] PUT Error",
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
