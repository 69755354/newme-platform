import { NextRequest, NextResponse } from "next/server";
import {
  applyRequestAuthCookies,
  getRequestAuthContext,
  RequestAuthError,
} from "@/lib/request-auth-context";
import type { Json } from "@/types/database";

type JsonObject = Record<string, unknown>;

const EXIT_ERRORS = new Map<string, number>([
  ["platform_staff_required", 403],
  ["platform_action_request_permission_required", 403],
  ["platform_approval_request_id_required", 400],
  ["noncanonical_platform_approval_payload", 400],
  ["platform_approval_target_mismatch", 409],
  ["platform_approval_idempotency_payload_mismatch", 409],
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
    const idempotencyKey = text(body, "idempotency_key");
    if (!organizationId || !idempotencyKey || "approver_user_id" in body) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }

    let actionKey: string;
    let payload: Json;
    if (action === "prepare") {
      const reason = text(body, "reason");
      if (!reason) {
        return NextResponse.json({ error: "invalid_request" }, { status: 400 });
      }
      actionKey = "organization.exit.prepare";
      payload = {
        organization_id: organizationId,
        idempotency_key: idempotencyKey,
        reason,
      };
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
      actionKey = "organization.exit.complete";
      payload = {
        organization_id: organizationId,
        idempotency_key: idempotencyKey,
        expected_export_sha256: exportSha256.toLowerCase(),
        backup_evidence_ref: backupEvidenceRef,
        customer_confirmation_ref: customerConfirmationRef,
        retention_basis: retentionBasis,
      };
    } else {
      return NextResponse.json({ error: "invalid_action" }, { status: 400 });
    }

    const { data, error } = await context.supabase.rpc(
      "v4_request_platform_action_approval",
      {
        p_action_key: actionKey,
        p_target_key: organizationId,
        p_payload: payload,
        p_request_id: `exit:${action}:${idempotencyKey}`,
      },
    );
    if (error || data === null || typeof data !== "object") {
      const mapped = exitError(error);
      return NextResponse.json({ error: mapped.code }, { status: mapped.status });
    }
    return applyRequestAuthCookies(
      context,
      NextResponse.json(data, {
        status: 202,
        headers: { "Cache-Control": "no-store" },
      }),
    );
  } catch (error) {
    const mapped = exitError(error);
    return NextResponse.json({ error: mapped.code }, { status: mapped.status });
  }
}
