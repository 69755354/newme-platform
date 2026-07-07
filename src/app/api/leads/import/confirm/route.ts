import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createServerSupabase } from "@/models/supabase-server";

// ─── POST /api/leads/import/confirm ───
export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabase();
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    if (!profile || !["admin", "boss"].includes(profile.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // ─── Server-side re-validation helpers ───
    function mapSource(raw: string): string {
      const s = raw.toLowerCase().trim();
      if (s === "instgram") return "instagram";
      if (s === "instagram") return "instagram";
      if (!s) return "unknown_import";
      return "other";
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

    const body = await request.json();
    const allRows: any[] = body.rows || [];

    if (!Array.isArray(allRows) || allRows.length === 0) {
      return NextResponse.json({ error: "No rows provided" }, { status: 400 });
    }

    const importBatchId = crypto.randomUUID();
    const now = new Date().toISOString();

    // ─── Build lead insert rows with server-side re-validation ───
    // Duplicate client-side mapSource/mapQuality/mapStatus from preview
    // so source/quality/lead_status are ALWAYS normalized server-side,
    // even if the client sends un-normalized or malicious values.
    const leadsToInsert = allRows.map((row) => {
      const rawImportData = row.raw_import_data || {};
      const rawStatus = rawImportData.raw_status || row.lead_status;
      const statusResult = mapStatus(String(rawStatus ?? ""));
      const qualityResult = mapQuality(String(row.quality ?? ""));
      const sourceResult = mapSource(row.source || "");

      // Log any normalization warnings server-side
      if (qualityResult.warning) {
        console.warn(`[Import Confirm] Row ${row.row_number}: ${qualityResult.warning}`);
      }
      if (statusResult.warning) {
        console.warn(`[Import Confirm] Row ${row.row_number}: ${statusResult.warning}`);
      }

      return {
        row_number: row.row_number,
        customer_name: row.customer_name || `Row ${row.row_number}`,
        phone: row.phone || null,
        source: sourceResult,
        quality: qualityResult.quality,
        lead_status: statusResult.status,
        stage: "new", // always "new" on import — never trust client-supplied stage
        emirate: row.emirate || null,
        property_type: row.property_type || null,
        country: row.country || null,
        first_contact_date: row.first_contact_date || null,
        quotation_value: row.quotation_value || null,
        raw_import_data: row.raw_import_data ? JSON.stringify(row.raw_import_data) : null,
        import_batch_id: importBatchId,
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

    for (let i = 0; i < leadsToInsert.length; i += BATCH_SIZE) {
      const batch = leadsToInsert.slice(i, i + BATCH_SIZE);
      // Strip row_number from each element before insert (column doesn't exist in leads table)
      const cleanBatch = batch.map(({ row_number, ...rest }) => rest);
      const { data, error: insertErr } = await adminClient
        .from("leads")
        .insert(cleanBatch)
        .select("id");

      if (insertErr) {
        // Row-by-row fallback — strip row_number per element
        for (let j = 0; j < batch.length; j++) {
          const { row_number, ...cleanRow } = batch[j];
          const { data: single, error: singleErr } = await adminClient
            .from("leads")
            .insert(cleanRow)
            .select("id")
            .single();
          if (singleErr) {
            errors.push({
              row: batch[j].row_number,
              error: singleErr.message,
            });
          } else {
            imported++;
            rowNumToLeadId.set(batch[j].row_number, single.id);
          }
        }
      } else {
        imported += data.length;
        for (let dIdx = 0; dIdx < data.length; dIdx++) {
          rowNumToLeadId.set(batch[dIdx].row_number, data[dIdx].id);
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
      failed: errors.length,
      imported_ids: Array.from(rowNumToLeadId.values()),
      errors,
      notes_created: notesCreated,
    });
  } catch (err: any) {
    console.error("[Import Confirm] Error:", err);
    return NextResponse.json(
      { error: err.message || "Import failed" },
      { status: 500 }
    );
  }
}
