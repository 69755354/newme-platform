// RBAC: organization-scoped atomic quotation conversion
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import {
  OrganizationAuthorizationError,
  resolveOrganizationAuthorization,
} from "@/lib/organization-authorization";
import { RequestAuthError } from "@/lib/request-auth-context";
import { logger, genReqId } from "@/lib/logger";
import type { Json } from "@/types/database";

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

function conversionFailure(message: string): { status: number; code: string } {
  if (message.includes("capability_required") || message.includes("ownership_required")) {
    return { status: 403, code: "quotation_conversion_forbidden" };
  }
  if (message.includes("not_found")) return { status: 404, code: "quotation_resource_not_found" };
  if (message.includes("already_converted") || message.includes("idempotency")
    || message.includes("in_progress") || message.includes("duplicate")
    || message.includes("sequence_exhausted")) return { status: 409, code: "quotation_conversion_conflict" };
  if (message.includes("not_accepted") || message.includes("invalid_")
    || message.includes("must_be_positive") || message.includes("request_id_required")
    || message.includes("installments_total_mismatch")) {
    return { status: 400, code: "invalid_quotation_conversion" };
  }
  return { status: 503, code: "quotation_conversion_unavailable" };
}

function idempotencyKey(request: Request): string | null {
  const value = request.headers.get("idempotency-key");
  return value && /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(value) ? value : null;
}

function conversionResult(value: unknown): value is {
  contract_id: string;
  contract_no: string;
  quotation_status: string;
} {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && "contract_id" in value && typeof value.contract_id === "string"
    && "contract_no" in value && typeof value.contract_no === "string"
    && "quotation_status" in value && typeof value.quotation_status === "string";
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const request_id = genReqId();
  const { id: quotationId } = await params;
  try {
    const access = await resolveOrganizationAuthorization(
      request,
      "quotations.convert",
      "write",
    );
    const workflowKey = idempotencyKey(request);
    if (!workflowKey) {
      return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
    }
    const untrustedBody: unknown = await request.json().catch(() => null);
    if (!isJson(untrustedBody) || untrustedBody === null || Array.isArray(untrustedBody)
      || typeof untrustedBody !== "object") {
      return NextResponse.json({ error: "invalid_quotation_convert_payload" }, { status: 400 });
    }
    const { data, error } = await access.context.supabase.rpc(
      "v4_convert_quotation_for_organization",
      {
        p_organization_id: access.organizationId,
        p_quotation_id: quotationId,
        p_payload: untrustedBody,
        p_request_id: workflowKey,
      },
    );
    if (error) {
      logger.error(
        { err: error, request_id, operation: "quotation_convert", quotation_id: quotationId },
        "[Quotation Convert] atomic RPC failed",
      );
      const failure = conversionFailure(error.message);
      return NextResponse.json({ error: failure.code }, { status: failure.status });
    }
    if (!conversionResult(data)) {
      return NextResponse.json({ error: "invalid_quotation_conversion_result" }, { status: 502 });
    }
    revalidatePath("/quotes");
    revalidatePath("/contracts");
    revalidatePath("/leads");
    return NextResponse.json({
      success: true,
      contract_id: data.contract_id,
      contract_no: data.contract_no,
      quotation_status: data.quotation_status,
    });
  } catch (err: unknown) {
    if (err instanceof OrganizationAuthorizationError || err instanceof RequestAuthError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    logger.error(
      { err, request_id, operation: "quotation_convert", quotation_id: quotationId },
      "[Quotation Convert] Error",
    );
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
