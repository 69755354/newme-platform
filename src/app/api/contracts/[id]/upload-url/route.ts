// RBAC: organization capability storage.files.write
import { NextRequest, NextResponse } from "next/server";
import {
  OrganizationAuthorizationError,
  resolveOrganizationAuthorization,
} from "@/lib/organization-authorization";
import { RequestAuthError } from "@/lib/request-auth-context";
import { logger } from "@/lib/logger";
import { runCosPresign } from "@/lib/cos-presign";

type RegisteredFile = {
  id: string;
  key: string;
  status: string;
  content_type: string;
  expected_size_bytes: number;
  expected_content_md5: string;
  upload_url_expires_at: string;
};

function registeredFile(value: unknown): value is RegisteredFile {
  return value !== null && typeof value === "object"
    && "id" in value && typeof value.id === "string"
    && "key" in value && typeof value.key === "string"
    && "status" in value && typeof value.status === "string"
    && "content_type" in value && typeof value.content_type === "string"
    && "expected_size_bytes" in value
    && typeof value.expected_size_bytes === "number"
    && "expected_content_md5" in value
    && typeof value.expected_content_md5 === "string"
    && "upload_url_expires_at" in value
    && typeof value.upload_url_expires_at === "string";
}

function signedUpload(value: unknown): value is {
  url: string;
  headers: Record<string, string>;
} {
  return value !== null && typeof value === "object"
    && "url" in value && typeof value.url === "string"
    && "headers" in value && value.headers !== null
    && typeof value.headers === "object" && !Array.isArray(value.headers);
}

async function compensateRegistration(
  access: Awaited<ReturnType<typeof resolveOrganizationAuthorization>>,
  fileId: string,
  reason: string,
) {
  const { error } = await access.context.supabase.rpc(
    "v4_cancel_tenant_file_upload",
    {
      p_organization_id: access.organizationId,
      p_file_id: fileId,
      p_reason: reason,
      p_request_id: `${access.context.requestId}:cancel`,
    },
  );
  if (error) throw new Error("storage_registration_compensation_failed");
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
    const filename = typeof body?.filename === "string" ? body.filename.trim() : "";
    const version = body?.version === "sealed" ? "sealed" : "draft";
    const contentType = typeof body?.content_type === "string" ? body.content_type.trim() : "";
    const size = typeof body?.size === "number" && Number.isSafeInteger(body.size)
      ? body.size
      : -1;
    const contentMd5 = typeof body?.content_md5 === "string"
      ? body.content_md5.trim()
      : "";
    const idempotencyKey = typeof body?.idempotency_key === "string"
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(body.idempotency_key)
      ? body.idempotency_key
      : "";
    if (!filename || contentType.length < 3 || contentType.length > 160
      || size < 0 || size > 1_073_741_824
      || !/^[A-Za-z0-9+/]{22}==$/.test(contentMd5) || !idempotencyKey) {
      return NextResponse.json({ error: "invalid_upload_metadata" }, { status: 400 });
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
    if (version === "sealed" && !canSeal) {
      return NextResponse.json({ error: "sealed_contract_admin_required" }, { status: 403 });
    }
    if (!canWriteAny && (version !== "draft" || !isOwningSales)) {
      return NextResponse.json(
        { error: "sales_contract_file_ownership_required" },
        { status: 403 },
      );
    }
    const { data: registration, error: registrationError } = await access.context.supabase.rpc(
      "v4_register_tenant_file",
      {
        p_organization_id: access.organizationId,
        p_record_type: "contract",
        p_record_id: contractId,
        p_filename: filename,
        p_version: version,
        p_content_type: contentType,
        p_expected_size_bytes: size,
        p_expected_content_md5: contentMd5,
        p_request_id: idempotencyKey,
      },
    );
    if (registrationError || !registeredFile(registration)) {
      return NextResponse.json({ error: "storage_registration_failed" }, { status: 503 });
    }
    if (registration.status !== "pending") {
      return NextResponse.json({ error: "storage_registration_not_pending" }, { status: 409 });
    }
    const remainingSeconds = Math.floor(
      (new Date(registration.upload_url_expires_at).getTime() - Date.now()) / 1000,
    );
    if (!Number.isSafeInteger(remainingSeconds) || remainingSeconds < 60) {
      return NextResponse.json(
        { error: "upload_url_expiring_new_idempotency_key_required" },
        { status: 409 },
      );
    }
    let signed: unknown;
    try {
      signed = await runCosPresign([
        "--put",
        registration.key,
        String(Math.min(900, remainingSeconds)),
        registration.content_type,
        registration.expected_content_md5,
        String(registration.expected_size_bytes),
      ]);
    } catch {
      await compensateRegistration(access, registration.id, "cos_presign_execution_failed");
      return NextResponse.json({ error: "storage_presign_failed" }, { status: 503 });
    }
    let signedHeaderList = "";
    if (signedUpload(signed)) {
      try {
        signedHeaderList = new URL(signed.url).searchParams.get("q-header-list") ?? "";
      } catch {
        signedHeaderList = "";
      }
    }
    if (!signedUpload(signed)
      || signed.headers["Content-Length"] !== String(registration.expected_size_bytes)
      || signed.headers["Content-MD5"] !== registration.expected_content_md5
      || signed.headers["Content-Type"] !== registration.content_type
      || signed.headers["x-cos-meta-md5"] !== registration.expected_content_md5
      || signedHeaderList
        !== "content-length;content-md5;content-type;host;x-cos-meta-md5") {
      await compensateRegistration(access, registration.id, "cos_presign_contract_mismatch");
      return NextResponse.json({ error: "storage_presign_failed" }, { status: 503 });
    }
    return NextResponse.json({
      file_id: registration.id,
      url: signed.url,
      key: registration.key,
      headers: signed.headers,
      expires_in: Math.min(900, remainingSeconds),
    });
  } catch (error) {
    if (error instanceof OrganizationAuthorizationError || error instanceof RequestAuthError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    logger.error({ err: error, contract_id: contractId }, "contract upload URL failed");
    return NextResponse.json({ error: "storage_upload_unavailable" }, { status: 503 });
  }
}

export async function DELETE(
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
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "client_cancelled_upload";
    if (!body || !fileId || reason.length < 8 || reason.length > 500) {
      return NextResponse.json({ error: "invalid_storage_cancellation" }, { status: 400 });
    }
    const { data: file, error: lookupError } = await access.context.supabase
      .from("tenant_file_objects")
      .select("id")
      .eq("id", fileId)
      .eq("organization_id", access.organizationId)
      .eq("record_type", "contract")
      .eq("record_id", contractId)
      .maybeSingle();
    if (lookupError) {
      return NextResponse.json({ error: "storage_lookup_failed" }, { status: 503 });
    }
    if (!file) {
      return NextResponse.json({ error: "storage_object_not_found" }, { status: 404 });
    }
    const { data, error } = await access.context.supabase.rpc(
      "v4_cancel_tenant_file_upload",
      {
        p_organization_id: access.organizationId,
        p_file_id: fileId,
        p_reason: reason,
        p_request_id: access.context.requestId,
      },
    );
    if (error) {
      return NextResponse.json({ error: "storage_cancellation_failed" }, { status: 409 });
    }
    return NextResponse.json({ data });
  } catch (error) {
    if (error instanceof OrganizationAuthorizationError || error instanceof RequestAuthError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    logger.error({ err: error, contract_id: contractId }, "contract upload cancellation failed");
    return NextResponse.json({ error: "storage_cancellation_unavailable" }, { status: 503 });
  }
}
