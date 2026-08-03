// RBAC: organization capability storage.files.write
import { NextRequest, NextResponse } from "next/server";
import {
  OrganizationAuthorizationError,
  resolveOrganizationAuthorization,
} from "@/lib/organization-authorization";
import { RequestAuthError } from "@/lib/request-auth-context";
import { runCosPresign } from "@/lib/cos-presign";
import { supabaseAdmin } from "@/lib/supabase-admin";

type ConfirmedFile = { id: string; key: string; status: string };

function confirmedFile(value: unknown): value is ConfirmedFile {
  return value !== null && typeof value === "object"
    && "id" in value && typeof value.id === "string"
    && "key" in value && typeof value.key === "string"
    && "status" in value && value.status === "available";
}

type VerifiedObject = {
  key: string;
  size: number;
  content_type: string;
  content_md5: string;
  etag: string;
  checksum_crc64ecma: string | null;
};

function verifiedObject(value: unknown): value is VerifiedObject {
  return value !== null && typeof value === "object"
    && "key" in value && typeof value.key === "string"
    && "size" in value && typeof value.size === "number"
    && "content_type" in value && typeof value.content_type === "string"
    && "content_md5" in value && typeof value.content_md5 === "string"
    && "etag" in value && typeof value.etag === "string"
    && "checksum_crc64ecma" in value
    && (value.checksum_crc64ecma === null
      || typeof value.checksum_crc64ecma === "string");
}

async function compensateFailedConfirmation(
  access: Awaited<ReturnType<typeof resolveOrganizationAuthorization>>,
  fileId: string,
  reason: string,
) {
  const { error } = await access.context.supabase.rpc("v4_cancel_tenant_file_upload", {
    p_organization_id: access.organizationId,
    p_file_id: fileId,
    p_reason: reason,
    p_request_id: `${access.context.requestId}:cancel`,
  });
  if (error) throw new Error("storage_confirmation_compensation_failed");
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: contractId } = await params;
  try {
    const access = await resolveOrganizationAuthorization(
      request,
      "storage.files.write",
      "write",
    );
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const fileId = typeof body?.file_id === "string" ? body.file_id : "";
    if (!body || Object.keys(body).length !== 1 || !fileId) {
      return NextResponse.json({ error: "invalid_storage_confirmation" }, { status: 400 });
    }
    const { data: fileObject, error: fileError } = await access.context.supabase
      .from("tenant_file_objects")
      .select("id, object_key, version, status, content_type, expected_size_bytes, expected_content_md5")
      .eq("id", fileId)
      .eq("organization_id", access.organizationId)
      .eq("record_type", "contract")
      .eq("record_id", contractId)
      .maybeSingle();
    if (fileError) {
      return NextResponse.json({ error: "storage_lookup_failed" }, { status: 503 });
    }
    if (!fileObject || fileObject.status !== "pending") {
      return NextResponse.json({ error: "storage_object_not_found" }, { status: 404 });
    }
    const { data: contract, error: contractError } = await access.context.supabase
      .from("contracts")
      .select("id, sales_id")
      .eq("id", contractId)
      .eq("organization_id", access.organizationId)
      .maybeSingle();
    if (contractError) {
      return NextResponse.json({ error: "contract_lookup_failed" }, { status: 503 });
    }
    if (!contract) {
      return NextResponse.json({ error: "contract_not_found" }, { status: 404 });
    }
    const canWriteAny = access.capabilities.includes("storage.files.write_any");
    const canSeal = access.capabilities.includes("storage.files.seal");
    const isOwningSales = access.roleKeys.includes("sales_agent")
      && contract.sales_id === access.context.user.id;
    if (fileObject.version === "sealed" && !canSeal) {
      return NextResponse.json({ error: "sealed_contract_admin_required" }, { status: 403 });
    }
    if (!canWriteAny && (fileObject.version !== "draft" || !isOwningSales)) {
      return NextResponse.json(
        { error: "sales_contract_file_ownership_required" },
        { status: 403 },
      );
    }
    let verification: unknown;
    try {
      verification = await runCosPresign([
        "--head",
        fileObject.object_key,
        String(fileObject.expected_size_bytes),
        fileObject.content_type,
        fileObject.expected_content_md5,
      ]);
    } catch {
      await compensateFailedConfirmation(
        access,
        fileId,
        "cos_head_object_verification_failed",
      );
      return NextResponse.json(
        { error: "storage_object_verification_failed" },
        { status: 409 },
      );
    }
    if (!verifiedObject(verification)
      || verification.key !== fileObject.object_key
      || verification.size !== fileObject.expected_size_bytes
      || verification.content_type !== fileObject.content_type
      || verification.content_md5 !== fileObject.expected_content_md5) {
      await compensateFailedConfirmation(
        access,
        fileId,
        "cos_head_object_contract_mismatch",
      );
      return NextResponse.json(
        { error: "storage_object_verification_failed" },
        { status: 409 },
      );
    }
    const { data, error } = await supabaseAdmin.rpc(
      "v4_finalize_tenant_file",
      {
        p_organization_id: access.organizationId,
        p_file_id: fileId,
        p_verified_size_bytes: verification.size,
        p_verified_content_type: verification.content_type,
        p_verified_content_md5: verification.content_md5,
        p_provider_etag: verification.etag,
        p_provider_checksum_crc64ecma: verification.checksum_crc64ecma,
        p_actor_user_id: access.context.user.id,
        p_request_id: access.context.requestId,
      },
    );
    if (error || !confirmedFile(data)) {
      return NextResponse.json({ error: "storage_confirmation_failed" }, { status: 503 });
    }
    return NextResponse.json({ success: true, file_id: data.id, key: data.key });
  } catch (error) {
    if (error instanceof OrganizationAuthorizationError || error instanceof RequestAuthError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: "storage_confirmation_unavailable" }, { status: 503 });
  }
}
