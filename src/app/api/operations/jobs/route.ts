import { NextRequest } from "next/server";
import { resolveOrganizationAuthorization } from "@/lib/organization-authorization";
import { boundedLimit, errorResponse, isUuid, jsonResponse, parseObject, text } from "@/lib/shared-operations";
import type { Json } from "@/types/database";

const JOB_CAPABILITIES = {
  work_items_import: "shared.jobs.import",
  organization_export: "shared.jobs.export",
  operations_report: "shared.jobs.report",
} as const;

export async function GET(request: NextRequest) {
  try {
    const access = await resolveOrganizationAuthorization(request, "shared.operations.read");
    const { data, error } = await access.context.supabase.from("shared_jobs").select("*")
      .eq("organization_id", access.organizationId).order("created_at", { ascending: false })
      .limit(boundedLimit(request));
    if (error) throw error;
    return jsonResponse(access, { data: data ?? [] });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest) {
  try {
    const body = parseObject(await request.json().catch(() => null));
    const kind = text(body?.kind, 32) as keyof typeof JOB_CAPABILITIES | null;
    const idempotencyKey = text(body?.idempotency_key, 160);
    if (!body || !kind || !(kind in JOB_CAPABILITIES) || !idempotencyKey) {
      return errorResponse(new Error("shared_job_invalid"));
    }
    const mode = kind === "organization_export" ? "export" : kind === "operations_report" ? "read" : "write";
    const access = await resolveOrganizationAuthorization(request, JOB_CAPABILITIES[kind], mode);
    const inputFileId = body.input_file_id == null ? null : isUuid(body.input_file_id) ? body.input_file_id : undefined;
    if (inputFileId === undefined) return errorResponse(new Error("shared_job_invalid"));
    const { data, error } = await access.context.supabase.rpc("v4_create_shared_job", {
      p_organization_id: access.organizationId, p_kind: kind,
      p_parameters: (parseObject(body.parameters) ?? {}) as Json, p_input_file_id: inputFileId,
      p_idempotency_key: idempotencyKey,
    });
    if (error) throw error;
    return jsonResponse(access, { data }, 202);
  } catch (error) { return errorResponse(error); }
}
