// POST /api/leads/import/confirm — Confirm import, write leads + follow_up_logs with batch trace
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

// DB CHECK constraint: project_type IN ('villa','apartment','developer').
// Defensive allowlist — only persist legal values, coerce anything else to null.
const ALLOWED_PROJECT_TYPES = ["villa", "apartment", "developer"];

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: any;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { rows } = body;
  if (!rows || !Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: "rows array required" }, { status: 400 });
  }

  const batchId = crypto.randomUUID();
  const now = new Date().toISOString();
  const imported: any[] = [];
  const errors: any[] = [];

  for (const row of rows) {
    try {
      const leadPayload: Record<string, any> = {
        customer_name: row.customer_name || null,
        phone: row.phone || null,
        source: row.source || "unknown_import",
        current_milestone: row.current_milestone || "new",
        quality: row.quality || "pending",
        location: row.location || null,
        project_type: ALLOWED_PROJECT_TYPES.includes(row.project_type) ? row.project_type : null,
        quotation_value: row.quotation_value || null,
        assigned_to: user.id,
        import_batch_id: batchId,
        imported_by: user.id,
        imported_at: now,
        raw_import_data: {
          row_number: row.row_number,
          raw_status: row.raw_status || null,
          raw_source: row.raw_source || null,
          raw_note: row.notes || null,
          raw_quality: row.raw_quality || null,
          source_file: "Book2.xlsx",
        },
      };

      const { data: lead, error: leadErr } = await supabase
        .from("leads")
        .insert(leadPayload)
        .select("id")
        .single();

      if (leadErr) { errors.push({ row: row.row_number, error: leadErr.message }); continue; }

      // Notes → follow_up_logs
      if (row.notes && row.notes.trim()) {
        const { error: noteErr } = await supabase.from("follow_up_logs").insert({
          lead_id: lead.id,
          contact_type: "import_note",
          summary: row.notes.trim(),
          user_id: user.id,
          created_at: now,
        });
        // Lead was inserted, but the note failed (RLS/constraint) → partial.
        // Don't swallow it; surface as a per-row error with row_number and cause.
        if (noteErr) {
          errors.push({
            row: row.row_number,
            error: `lead ${lead.id} imported but note failed: ${noteErr.message}`,
          });
        }
      }

      imported.push({ id: lead.id, row_number: row.row_number });
    } catch (e: any) {
      errors.push({ row: row.row_number, error: e.message || "Unknown error" });
    }
  }

  return NextResponse.json({
    batch_id: batchId,
    imported: imported.length,
    failed: errors.length,
    errors: errors.slice(0, 50),
    imported_ids: imported.map((i) => i.id),
  });
}
