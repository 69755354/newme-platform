import { NextRequest, NextResponse } from "next/server";
import {
  applyRequestAuthCookies,
  getRequestAuthContext,
  RequestAuthError,
} from "@/lib/request-auth-context";
import { supabaseAdmin } from "@/lib/supabase-admin";

type JsonObject = Record<string, unknown>;

const EXIT_ERRORS = new Map<string, number>([
  ["platform_staff_required", 403],
  ["independent_exit_approver_required", 403],
  ["exit_idempotency_key_required", 400],
  ["exit_reason_required", 400],
  ["valid_export_sha256_required", 400],
  ["exit_completion_evidence_required", 400],
  ["exit_idempotency_payload_mismatch", 409],
  ["organization_exit_not_preparable", 409],
  ["organization_exit_not_completable", 409],
  ["prepared_exit_request_required", 409],
  ["exit_approval_identity_mismatch", 409],
  ["organization_changed_after_export", 409],
]);

function objectBody(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function text(body: JsonObject, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function exitError(error: unknown): { code: string; status: number } {
  if (error instanceof RequestAuthError) {
    return { code: error.code, status: error.status };
  }
  const message = error !== null
    && typeof error === "object"
    && "message" in error
    && typeof error.message === "string"
    ? error.message
    : "";
  for (const [code, status] of EXIT_ERRORS) {
    if (message.includes(code)) return { code, status };
  }
  return { code: "organization_exit_unavailable", status: 503 };
}

export async function POST(request: NextRequest) {
  try {
    const context = await getRequestAuthContext(request);
    const body = objectBody(await request.json().catch(() => null));
    if (!body) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    const action = text(body, "action");
    const organizationId = text(body, "organization_id");
    const approverUserId = text(body, "approver_user_id");
    const idempotencyKey = text(body, "idempotency_key");
    if (!organizationId || !approverUserId || !idempotencyKey) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }

    let data: unknown;
    let error: unknown;
    if (action === "prepare") {
      const reason = text(body, "reason");
      if (!reason) {
        return NextResponse.json({ error: "invalid_request" }, { status: 400 });
      }
      ({ data, error } = await supabaseAdmin.rpc(
        "prepare_organization_customer_exit",
        {
          p_organization_id: organizationId,
          p_actor_user_id: context.user.id,
          p_approver_user_id: approverUserId,
          p_idempotency_key: idempotencyKey,
          p_reason: reason,
          p_request_id: context.requestId,
        },
      ));
    } else if (action === "complete") {
      const exportSha256 = text(body, "expected_export_sha256");
      const backupEvidenceRef = text(body, "backup_evidence_ref");
      const customerConfirmationRef = text(body, "customer_confirmation_ref");
      const retentionBasis = text(body, "retention_basis");
      if (
        !exportSha256
        || !backupEvidenceRef
        || !customerConfirmationRef
        || !retentionBasis
      ) {
        return NextResponse.json({ error: "invalid_request" }, { status: 400 });
      }
      ({ data, error } = await supabaseAdmin.rpc(
        "complete_organization_customer_exit",
        {
          p_organization_id: organizationId,
          p_actor_user_id: context.user.id,
          p_approver_user_id: approverUserId,
          p_idempotency_key: idempotencyKey,
          p_expected_export_sha256: exportSha256,
          p_backup_evidence_ref: backupEvidenceRef,
          p_customer_confirmation_ref: customerConfirmationRef,
          p_retention_basis: retentionBasis,
          p_request_id: context.requestId,
        },
      ));
    } else {
      return NextResponse.json({ error: "invalid_action" }, { status: 400 });
    }

    if (error || data === null || typeof data !== "object") {
      const mapped = exitError(error);
      return NextResponse.json({ error: mapped.code }, { status: mapped.status });
    }
    return applyRequestAuthCookies(
      context,
      NextResponse.json(data, {
        status: action === "prepare" ? 201 : 200,
        headers: { "Cache-Control": "no-store" },
      }),
    );
  } catch (error) {
    const mapped = exitError(error);
    return NextResponse.json({ error: mapped.code }, { status: mapped.status });
  }
}
