// RBAC: organization-scoped authenticated contract workflows
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import {
  OrganizationAuthorizationError,
  resolveOrganizationAuthorization,
} from "@/lib/organization-authorization";
import { RequestAuthError } from "@/lib/request-auth-context";
import { logger, genReqId } from "@/lib/logger";
import type { Database, Json } from "@/types/database";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Internal server error";
}

function isJson(value: unknown): value is Json {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return typeof value !== "number" || Number.isFinite(value);
  }
  if (Array.isArray(value)) return value.every(isJson);
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every(isJson);
}

function contractRpcFailure(message: string): { status: number; code: string } {
  if (message.includes("capability_required") || message.includes("ownership_required")) {
    return { status: 403, code: "contract_workflow_forbidden" };
  }
  if (message.includes("not_found")) return { status: 404, code: "contract_resource_not_found" };
  if (message.includes("already_exists") || message.includes("idempotency")
    || message.includes("in_progress") || message.includes("duplicate")
    || message.includes("sequence_exhausted")) return { status: 409, code: "contract_workflow_conflict" };
  if (message.includes("invalid_") || message.includes("request_id_required")
    || message.includes("installments_total_mismatch")) {
    return { status: 400, code: "invalid_contract_workflow" };
  }
  return { status: 503, code: "contract_workflow_unavailable" };
}

function idempotencyKey(request: Request): string | null {
  const value = request.headers.get("idempotency-key");
  return value && /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(value) ? value : null;
}

function contractWorkflowResult(value: unknown): value is {
  contract_id: string;
  contract_no: string;
} {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && "contract_id" in value && typeof value.contract_id === "string"
    && "contract_no" in value && typeof value.contract_no === "string";
}

/** Create contract, installments, approval, and activity in one transaction. */
export async function POST(request: NextRequest) {
  const request_id = genReqId();
  try {
    const access = await resolveOrganizationAuthorization(
      request,
      "contracts.create",
      "write",
    );
    const workflowKey = idempotencyKey(request);
    if (!workflowKey) {
      return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
    }
    const untrustedBody: unknown = await request.json().catch(() => null);
    if (!isJson(untrustedBody) || untrustedBody === null || Array.isArray(untrustedBody)
      || typeof untrustedBody !== "object") {
      return NextResponse.json({ error: "invalid_contract_payload" }, { status: 400 });
    }
    const { data, error } = await access.context.supabase.rpc(
      "v4_create_contract_for_organization",
      {
        p_organization_id: access.organizationId,
        p_payload: untrustedBody,
        p_request_id: workflowKey,
      },
    );
    if (error) {
      logger.error(
        { err: error, request_id, operation: "contract_create", user_id: access.context.user.id },
        "[API Contracts] atomic RPC failed",
      );
      const failure = contractRpcFailure(error.message);
      return NextResponse.json({ error: failure.code }, { status: failure.status });
    }
    if (!contractWorkflowResult(data)) {
      return NextResponse.json({ error: "invalid_contract_workflow_result" }, { status: 502 });
    }
    revalidatePath("/contracts");
    revalidatePath("/leads");
    return NextResponse.json({ id: data.contract_id, contract_no: data.contract_no });
  } catch (err: unknown) {
    if (err instanceof OrganizationAuthorizationError || err instanceof RequestAuthError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    logger.error({ err, request_id, operation: "contract_create" }, "[API Contracts] POST Error");
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/** List contracts within the selected organization and membership role. */
export async function GET(request: NextRequest) {
  const request_id = genReqId();
  try {
    const access = await resolveOrganizationAuthorization(request, "contracts.read", "read");
    const { supabase, user } = access.context;
    const { searchParams } = new URL(request.url);
    const leadId = searchParams.get("lead_id");
    let query = supabase.from("contracts").select(
      "*, installment_plans!installment_plans_contract_id_fkey(*)",
    ).eq("organization_id", access.organizationId)
      .order("created_at", { ascending: false });
    if (leadId) query = query.eq("lead_id", leadId);
    const canReadAll = access.roleKeys.some((roleKey) => [
      "org_owner", "org_admin", "operations", "finance",
    ].includes(roleKey));
    if (!canReadAll) query = query.eq("sales_id", user.id);
    const { data, error } = await query;
    if (error) return NextResponse.json({ error: "Failed to fetch contracts" }, { status: 500 });
    return NextResponse.json({ data });
  } catch (err: unknown) {
    if (err instanceof OrganizationAuthorizationError || err instanceof RequestAuthError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    logger.error({ err, request_id, operation: "contract_list" }, "[API Contracts] GET Error");
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/** Update the bounded mutable contract fields for an owned organization row. */
export async function PUT(request: NextRequest) {
  const request_id = genReqId();
  try {
    const access = await resolveOrganizationAuthorization(request, "contracts.update", "write");
    const { supabase, user } = access.context;
    const body = await request.json();
    const { id, first_payment_status, first_payment_due_date } = body;
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    const { data: contract } = await supabase.from("contracts").select("sales_id")
      .eq("id", id).eq("organization_id", access.organizationId).maybeSingle();
    if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });
    if (!access.capabilities.includes("contracts.write_any") && contract.sales_id !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const updates: Database["public"]["Tables"]["contracts"]["Update"] = {};
    if (first_payment_status !== undefined) {
      if (!["unpaid", "partial", "paid"].includes(first_payment_status)) {
        return NextResponse.json({ error: "Invalid first_payment_status" }, { status: 400 });
      }
      updates.first_payment_status = first_payment_status;
    }
    if (first_payment_due_date !== undefined) updates.first_payment_due_date = first_payment_due_date;
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }
    updates.updated_at = new Date().toISOString();
    const { error } = await supabase.from("contracts").update(updates)
      .eq("id", id).eq("organization_id", access.organizationId);
    if (error) return NextResponse.json({ error: "Failed to update contract" }, { status: 500 });
    revalidatePath("/contracts");
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    if (err instanceof OrganizationAuthorizationError || err instanceof RequestAuthError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    const message = process.env.NODE_ENV === "production" ? "Internal server error" : errorMessage(err);
    logger.error({ err, request_id, operation: "contract_update" }, "[API Contracts] PUT Error");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
