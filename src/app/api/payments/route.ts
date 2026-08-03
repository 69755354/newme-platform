// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import {
  OrganizationAuthorizationError,
  resolveOrganizationAuthorization,
} from "@/lib/organization-authorization";
import { RequestAuthError } from "@/lib/request-auth-context";
import { logger, genReqId } from "@/lib/logger";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Internal server error";
}

/**
 * POST /api/payments
 * Records a new payment against a contract.
 */
export async function POST(request: NextRequest) {
  const request_id = genReqId();
  try {
    const access = await resolveOrganizationAuthorization(
      request,
      "payments.create",
      "write",
    );
    const { supabase, user } = access.context;

    const body = await request.json();
    const { contract_id, amount, payment_date, payment_method, reference_no, notes } = body;

    if (!contract_id) {
      return NextResponse.json({ error: "contract_id is required" }, { status: 400 });
    }
    if (!amount || typeof amount !== "number" || amount <= 0) {
      return NextResponse.json({ error: "Valid amount is required" }, { status: 400 });
    }
    if (!payment_date) {
      return NextResponse.json({ error: "payment_date is required" }, { status: 400 });
    }
    if (!payment_method) {
      return NextResponse.json({ error: "payment_method is required" }, { status: 400 });
    }

    // Verify the contract exists
    const { data: contract, error: contractErr } = await supabase
      .from("contracts")
      .select("id, sales_id, organization_id")
      .eq("id", contract_id)
      .eq("organization_id", access.organizationId)
      .single();

    if (contractErr || !contract) {
      return NextResponse.json({ error: "Contract not found" }, { status: 404 });
    }

    const isPrivileged = access.capabilities.includes("contracts.write_any")
      || access.capabilities.includes("payments.confirm");

    // Sales can only record payments against their own contracts
    if (!isPrivileged && contract.sales_id !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { data: payment, error: insertErr } = await supabase
      .from("payments")
      .insert({
        organization_id: access.organizationId,
        contract_id,
        created_by: user.id,
        amount,
        payment_date,
        payment_method,
        reference_no: reference_no || null,
        confirmed: false,
        notes: notes || null,
      })
      .select("id, amount")
      .single();

    if (insertErr) {
      logger.error(
        {
          err: insertErr,
          request_id,
          operation: "payment_create",
          user_id: user.id,
          contract_id,
        },
        "[API Payments] Insert failed",
      );
      return NextResponse.json({ error: "Failed to record payment" }, { status: 500 });
    }

    return NextResponse.json({ id: payment.id, amount: payment.amount }, { status: 201 });
  } catch (err: unknown) {
    if (err instanceof OrganizationAuthorizationError || err instanceof RequestAuthError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    const message = process.env.NODE_ENV === "production"
      ? "Internal server error"
      : errorMessage(err);
    logger.error(
      {
        err,
        request_id,
        operation: "payment_create",
      },
      "[API Payments] POST Error",
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * GET /api/payments
 * Lists payments with optional filters.
 * Query params: contract_id, confirmed
 */
export async function GET(request: NextRequest) {
  const request_id = genReqId();
  try {
    const access = await resolveOrganizationAuthorization(
      request,
      "payments.read",
      "read",
    );
    const { supabase, user } = access.context;

    const { searchParams } = new URL(request.url);
    const contractId = searchParams.get("contract_id");
    const confirmed = searchParams.get("confirmed");

    let query = supabase
      .from("payments")
      .select("*")
      .eq("organization_id", access.organizationId)
      .order("created_at", { ascending: false });

    if (contractId) {
      query = query.eq("contract_id", contractId);
    }
    if (confirmed !== null && confirmed !== undefined) {
      query = query.eq("confirmed", confirmed === "true");
    }

    // Sales can only see payments for their own contracts
    const canReadAll = access.roleKeys.some((roleKey) => [
      "org_owner", "org_admin", "operations", "finance",
    ].includes(roleKey));
    if (!canReadAll) {
      // Get contract IDs owned by this sales user
      const { data: ownContracts, error: contractsErr } = await supabase
        .from("contracts")
        .select("id")
        .eq("organization_id", access.organizationId)
        .eq("sales_id", user.id);

      if (contractsErr) {
        logger.error(
          {
            err: contractsErr,
            request_id,
            operation: "payment_list",
            user_id: user.id,
          },
          "[API Payments] Failed to fetch sales contracts",
        );
        return NextResponse.json({ error: "Failed to fetch payments" }, { status: 500 });
      }

      const ownContractIds = (ownContracts || []).map((c: { id: string }) => c.id);

      if (ownContractIds.length === 0) {
        return NextResponse.json({ data: [] });
      }

      query = query.in("contract_id", ownContractIds);
    }

    const { data, error } = await query;

    if (error) {
      logger.error(
        {
          err: error,
          request_id,
          operation: "payment_list",
          user_id: user.id,
        },
        "[API Payments] Fetch failed",
      );
      return NextResponse.json({ error: "Failed to fetch payments" }, { status: 500 });
    }

    return NextResponse.json({ data });
  } catch (err: unknown) {
    if (err instanceof OrganizationAuthorizationError || err instanceof RequestAuthError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    const message = process.env.NODE_ENV === "production"
      ? "Internal server error"
      : errorMessage(err);
    logger.error(
      {
        err,
        request_id,
        operation: "payment_list",
      },
      "[API Payments] GET Error",
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
