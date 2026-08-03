// RBAC: organization capability storage.files.read
import { NextRequest, NextResponse } from "next/server";
import {
  OrganizationAuthorizationError,
  resolveOrganizationAuthorization,
} from "@/lib/organization-authorization";
import { RequestAuthError } from "@/lib/request-auth-context";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { runCosPresign } from "@/lib/cos-presign";

export async function POST(request: NextRequest) {
  try {
    const access = await resolveOrganizationAuthorization(
      request,
      "storage.files.read",
      "read",
    );
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const key = typeof body?.key === "string" ? body.key : "";
    const expires = typeof body?.expires === "number" && Number.isSafeInteger(body.expires)
      ? Math.min(Math.max(body.expires, 60), 3600)
      : 900;
    if (!/^organizations\/[0-9a-f-]{36}\/[A-Za-z0-9_./ -]+$/.test(key)
      || key.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
      return NextResponse.json({ error: "invalid_storage_key" }, { status: 400 });
    }
    if (!key.startsWith(`organizations/${access.organizationId}/`)) {
      return NextResponse.json({ error: "storage_object_not_found" }, { status: 404 });
    }
    const { data: fileObject, error: fileError } = await supabaseAdmin
      .from("tenant_file_objects")
      .select("id")
      .eq("organization_id", access.organizationId)
      .eq("object_key", key)
      .eq("status", "available")
      .maybeSingle();
    if (fileError) {
      return NextResponse.json({ error: "storage_lookup_failed" }, { status: 503 });
    }
    if (!fileObject) {
      return NextResponse.json({ error: "storage_object_not_found" }, { status: 404 });
    }
    const signed = await runCosPresign([key, String(expires)]);
    if (signed === null || typeof signed !== "object"
      || !("url" in signed) || typeof signed.url !== "string") {
      return NextResponse.json({ error: "storage_presign_failed" }, { status: 503 });
    }
    return NextResponse.json({ ...signed, key, expires_in: expires });
  } catch (error) {
    if (error instanceof OrganizationAuthorizationError || error instanceof RequestAuthError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: "storage_download_unavailable" }, { status: 503 });
  }
}
