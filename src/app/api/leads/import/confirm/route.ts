// RBAC: user (authenticated)
import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
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

function importFingerprint(row: Record<string, unknown>): string {
  // Includes the source row number so intentional identical rows in one workbook
  // remain distinct, while uploading the same workbook again is idempotent.
  const stable = JSON.stringify({
    row_number: row.row_number ?? null,
    customer_name: row.customer_name ?? null,
    phone: row.phone ?? null,
    first_contact_date: row.first_contact_date ?? null,
    raw_import_data: row.raw_import_data ?? null,
  });
  return createHash("sha256").update(stable).digest("hex");
}

// ─── POST /api/leads/import/confirm ───
export async function POST(request: NextRequest) {
  try {
    const access = await resolveLeadOrganizationAccess(
      request,
      "lead:write",
      "lead_import",
      null,
    );
    if (!["admin", "boss"].includes(access.context.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const user = access.context.user;

    // ─── Server-side re-validation helpers ───
    function mapSource(raw: string): string {
      const s = raw.toLowerCase().trim();
      if (["instagram", "instgram", "ins", "meta_ads", "meta ads", "meta"].includes(s)) return "ins";
      if (["facebook", "fb"].includes(s)) return "fb";
      if (["show room", "show_room", "showroom"].includes(s)) return "show_room";
      if (["whatsapp", "website", "offline", "referral", "other", "unknown"].includes(s)) return s;
      return "unknown";
    }
    function mapQuality(raw: string): { quality: string; warning?: string } {
      const s = raw.trim();
      if (!s) return { quality: "pending" };
      const num = parseFloat(s);
      if (isNaN(num)) return { quality: "pending", warning: `Unparseable Client Quality: "${s}"` };
      if (num >= 0 && num <= 0.2) return { quality: "poor" };
      if (num >= 0.4 && num <= 0.6) return { quality: "normal" };
      if (num >= 0.7 && num <= 0.9) return { quality: "good" };
      return { quality: "pending", warning: `Client Quality ${num} outside known bands` };
    }
    function mapStatus(raw: string): { status: string; warning?: string } {
      const s = raw.toLowerCase().trim();
      if (!s) return { status: "pending" };
      if (s.includes("poor") || s === "poor leads") return { status: "poor" };
      if (s.includes("good")) return { status: "good" };
      if (s.includes("fake")) return { status: "fake" };
      if (s.includes("reject")) return { status: "rejected" };
      if (s.includes("discuss")) return { status: "discussion" };
      if (s.includes("design")) return { status: "design" };
      if (s.includes("wait")) return { status: "waiting" };
      if (s.includes("aprov")) return { status: "approval" };
      return { status: "pending", warning: `Unknown Status: "${raw}"` };
    }

    /*
     * SERVICE_ROLE KEY USAGE
     * ──────────────────────────────────────────────────────────────────────────
     * We use the Supabase service_role key here because this endpoint needs to:
     *   1. Bypass Row‑Level Security (RLS) to insert leads & follow_up_logs
     *      on behalf of any admin/boss user.
     *   2. Avoid the user‑token expiry window that can occur during batch inserts
     *      of large imports.
     *
     * Defense in depth:
     *   • The endpoint REQUIRES a valid user session (lines 9‑11).
     *   • The endpoint CHECKS that the authenticated user has the admin or boss
     *     role (lines 14‑21) BEFORE the service_role client is ever used.
     *   • service_role calls only happen AFTER both guards pass.
     *
     * Known gap:
     *   • The service_role key grants full database access. If this endpoint
     *     were ever accidentally exposed without the auth/role guards (e.g.
     *     during a refactor), it would be an unrestricted DB gateway.
     *   • Mitigation: always keep the auth+role check as the very first logic
     *     in this handler, and audit it in every code review.
     */

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const adminClient = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    let body: unknown;
    try {
      body = await readXlsxImportJson(request);
    } catch (err: unknown) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Invalid import request" },
        { status: err instanceof RangeError ? 413 : 400 },
      );
    }
    const untrustedRows =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as { rows?: unknown }).rows
        : undefined;

    if (!Array.isArray(untrustedRows) || untrustedRows.length === 0) {
      return NextResponse.json({ error: "No rows provided" }, { status: 400 });
    }
    try {
      validateXlsxImportRows(untrustedRows);
    } catch (err: unknown) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Import limit exceeded" },
        { status: 413 },
      );
    }
    const allRows = untrustedRows as Record<string, any>[];
    try {
      validateXlsxImportLimits({ rowCount: allRows.length });
    } catch (err: unknown) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Import limit exceeded" },
        { status: 413 },
      );
    }

    const importBatchId = crypto.randomUUID();
    const now = new Date().toISOString();

    // ─── Build lead insert rows with server-side re-validation ───
    // Duplicate client-side mapSource/mapQuality/mapStatus from preview
    // so source/quality/lead_status are ALWAYS normalized server-side,
    // even if the client sends un-normalized or malicious values.
    const leadsToInsert = allRows.map((row) => {
      const rawImportData = row.raw_import_data || {};
      const rawStatus = rawImportData.raw_status ?? row.lead_status;
      const rawQuality = rawImportData.raw_quality ?? row.quality;
      const rawSource = rawImportData.raw_source ?? row.source;
      const statusResult = mapStatus(String(rawStatus ?? ""));
      const qualityResult = mapQuality(String(rawQuality ?? ""));
      const sourceResult = mapSource(String(rawSource ?? ""));

      // Log any normalization warnings server-side
      if (qualityResult.warning) {
        console.warn(`[Import Confirm] Row ${row.row_number}: ${qualityResult.warning}`);
      }
      if (statusResult.warning) {
        console.warn(`[Import Confirm] Row ${row.row_number}: ${statusResult.warning}`);
      }

      return {
        row_number: row.row_number,
        organization_id: access.organizationId,
        customer_name: row.customer_name || `Row ${row.row_number}`,
        phone: row.phone || null,
        source: sourceResult,
        quality: qualityResult.quality,
        lead_status: statusResult.status,
        stage: "new", // always "new" on import — never trust client-supplied stage
        emirate: row.emirate || null,
        property_type: row.property_type || null,
        quotation_value: row.quotation_value || null,
        raw_import_data: row.raw_import_data ? JSON.stringify(row.raw_import_data) : null,
        import_batch_id: importBatchId,
        import_fingerprint: importFingerprint(row),
        imported_by: user.id,
        imported_at: now,
        assigned_to: null,
        next_action: "call",
        next_followup_date: new Date(Date.now() + 86400000).toISOString(),
        created_at: row.first_contact_date
          ? `${row.first_contact_date}T00:00:00Z`
          : now,
        updated_at: now,
      };
    });

    // Batch insert — strip row_number before sending to Supabase
    const BATCH_SIZE = 50;
    let imported = 0;
    const errors: { row: number; error: string }[] = [];
    const rowNumToLeadId = new Map<number, string>();
    let skippedDuplicates = 0;

    for (let i = 0; i < leadsToInsert.length; i += BATCH_SIZE) {
      const batch = leadsToInsert.slice(i, i + BATCH_SIZE);
      const cleanBatch = batch.map(({ row_number, ...rest }) => rest);
      const rowByFingerprint = new Map(
        batch.map((row) => [row.import_fingerprint, row.row_number]),
      );
      const { data, error: insertErr } = await adminClient
        .from("leads")
        .upsert(cleanBatch, {
          onConflict: "organization_id,import_fingerprint",
          ignoreDuplicates: true,
        })
        .select("id, import_fingerprint");

      if (insertErr) {
        // Preserve partial-import behavior while applying the same unique-key
        // semantics to every fallback row.
        for (const row of batch) {
          const { row_number, ...cleanRow } = row;
          const { data: single, error: singleErr } = await adminClient
            .from("leads")
            .upsert(cleanRow, {
              onConflict: "organization_id,import_fingerprint",
              ignoreDuplicates: true,
            })
            .select("id, import_fingerprint")
            .maybeSingle();
          if (singleErr) {
            errors.push({ row: row_number, error: singleErr.message });
          } else if (!single) {
            skippedDuplicates++;
          } else {
            imported++;
            rowNumToLeadId.set(row_number, single.id);
          }
        }
      } else {
        imported += data.length;
        skippedDuplicates += batch.length - data.length;
        for (const lead of data) {
          const rowNumber = rowByFingerprint.get(lead.import_fingerprint);
          if (rowNumber != null) rowNumToLeadId.set(rowNumber, lead.id);
        }
      }
    }

    // Insert follow_up_logs for notes — use rowNumToLeadId Map for correct mapping
    let notesCreated = 0;
    const notesToInsert: any[] = [];
    for (const row of allRows) {
      const notes = row.notes?.trim();
      if (notes) {
        const leadId = rowNumToLeadId.get(row.row_number);
        if (leadId) {
          notesToInsert.push({
            lead_id: leadId,
            contact_type: "note",
            summary: notes,
            user_id: user.id,
            no_answer: false,
            created_at: now,
          });
        }
      }
    }

    if (notesToInsert.length > 0) {
      const { error: logErr } = await adminClient
        .from("follow_up_logs")
        .insert(notesToInsert);
      if (!logErr) {
        notesCreated = notesToInsert.length;
      } else {
        console.error("[Import Confirm] follow_up_logs insert failed:", logErr);
      }
    }

    return NextResponse.json({
      batch_id: importBatchId,
      imported,
      skipped_duplicates: skippedDuplicates,
      failed: errors.length,
      imported_ids: Array.from(rowNumToLeadId.values()),
      errors,
      notes_created: notesCreated,
      organization_id: access.organizationId,
    });
  } catch (err: any) {
    if (err instanceof LeadOrganizationAccessError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    if (err instanceof RequestAuthError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    console.error("[Import Confirm] Error:", err);
    return NextResponse.json(
      { error: err.message || "Import failed" },
      { status: 500 }
    );
  }
}
