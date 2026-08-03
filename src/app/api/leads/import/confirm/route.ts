// RBAC: organization capability leads.import
import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  LeadOrganizationAccessError,
  resolveLeadOrganizationAccess,
} from "@/lib/lead-organization-access";
import { RequestAuthError } from "@/lib/request-auth-context";
import {
  readXlsxImportJson,
  validateXlsxImportLimits,
} from "@/lib/xlsx-import-limits.mjs";
import { validateXlsxImportRows } from "@/lib/xlsx-import-rows.mjs";
import type { Json } from "@/types/database";

type ImportRow = Record<string, unknown>;

function toJson(value: unknown): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(toJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, toJson(item)]),
    );
  }
  return null;
}

function importFingerprint(row: ImportRow): string {
  return createHash("sha256").update(JSON.stringify({
    row_number: row.row_number ?? null,
    customer_name: row.customer_name ?? null,
    phone: row.phone ?? null,
    first_contact_date: row.first_contact_date ?? null,
    raw_import_data: row.raw_import_data ?? null,
  })).digest("hex");
}

function mapSource(value: unknown): string {
  const source = String(value ?? "").toLowerCase().trim();
  if (["instagram", "instgram", "ins", "meta_ads", "meta ads", "meta"].includes(source)) return "ins";
  if (["facebook", "fb"].includes(source)) return "fb";
  if (["show room", "show_room", "showroom"].includes(source)) return "show_room";
  if (["whatsapp", "website", "offline", "referral", "other", "unknown"].includes(source)) return source;
  return "unknown";
}

function mapQuality(value: unknown): string {
  const quality = String(value ?? "").trim();
  if (!quality) return "pending";
  const numberValue = Number.parseFloat(quality);
  if (Number.isNaN(numberValue)) return "pending";
  if (numberValue >= 0 && numberValue <= 0.2) return "poor";
  if (numberValue >= 0.4 && numberValue <= 0.6) return "normal";
  if (numberValue >= 0.7 && numberValue <= 0.9) return "good";
  return "pending";
}

function mapStatus(value: unknown): string {
  const status = String(value ?? "").toLowerCase().trim();
  if (!status) return "pending";
  if (status.includes("poor")) return "poor";
  if (status.includes("good")) return "good";
  if (status.includes("fake")) return "fake";
  if (status.includes("reject")) return "rejected";
  if (status.includes("discuss")) return "discussion";
  if (status.includes("design")) return "design";
  if (status.includes("wait")) return "waiting";
  if (status.includes("aprov")) return "approval";
  return "pending";
}

function rpcErrorStatus(message: string): number {
  if (message.includes("capability_required") || message.includes("active_profile_required")) return 403;
  if (message.includes("organization_is_not_writable")) return 409;
  if (message.includes("invalid_") || message.includes("required")) return 400;
  return 503;
}

export async function POST(request: NextRequest) {
  try {
    const access = await resolveLeadOrganizationAccess(
      request,
      "lead:write",
      "lead_import",
      null,
    );
    let body: unknown;
    try {
      body = await readXlsxImportJson(request);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Invalid import request" },
        { status: error instanceof RangeError ? 413 : 400 },
      );
    }
    const rows = body && typeof body === "object" && !Array.isArray(body)
      ? (body as { rows?: unknown }).rows
      : undefined;
    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json({ error: "No rows provided" }, { status: 400 });
    }
    try {
      validateXlsxImportRows(rows);
      validateXlsxImportLimits({ rowCount: rows.length });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Import limit exceeded" },
        { status: 413 },
      );
    }

    const normalizedRows = (rows as ImportRow[]).map((row) => {
      const raw = row.raw_import_data && typeof row.raw_import_data === "object"
        ? row.raw_import_data as Record<string, unknown>
        : {};
      const firstContactDate = typeof row.first_contact_date === "string"
        && /^\d{4}-\d{2}-\d{2}$/.test(row.first_contact_date)
        ? `${row.first_contact_date}T00:00:00Z`
        : new Date().toISOString();
      return {
        customer_name: typeof row.customer_name === "string" && row.customer_name.trim()
          ? row.customer_name.trim()
          : `Row ${String(row.row_number ?? "unknown")}`,
        phone: typeof row.phone === "string" ? row.phone : null,
        source: mapSource(raw.raw_source ?? row.source),
        quality: mapQuality(raw.raw_quality ?? row.quality),
        lead_status: mapStatus(raw.raw_status ?? row.lead_status),
        emirate: typeof row.emirate === "string" ? row.emirate : null,
        property_type: typeof row.property_type === "string" ? row.property_type : null,
        quotation_value: typeof row.quotation_value === "number" ? row.quotation_value : null,
        raw_import_data: toJson(raw),
        notes: typeof row.notes === "string" ? row.notes : null,
        created_at: firstContactDate,
        import_fingerprint: importFingerprint(row),
      };
    });
    const batchId = crypto.randomUUID();
    const { data, error } = await access.client.rpc(
      "v4_import_leads_for_organization",
      {
        p_organization_id: access.organizationId,
        p_rows: normalizedRows,
        p_import_batch_id: batchId,
        p_request_id: access.context.requestId,
      },
    );
    if (error || !data || typeof data !== "object") {
      const message = error?.message ?? "lead_import_unavailable";
      return NextResponse.json(
        { error: message.includes("capability_required")
          ? "lead_import_capability_required"
          : "lead_import_unavailable" },
        { status: rpcErrorStatus(message) },
      );
    }
    return NextResponse.json(data);
  } catch (error) {
    if (error instanceof LeadOrganizationAccessError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    if (error instanceof RequestAuthError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: "lead_import_unavailable" }, { status: 503 });
  }
}
