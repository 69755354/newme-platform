import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createServerSupabase } from "@/lib/supabase-server";

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

    // Build lead insert rows
    const leadsToInsert = allRows.map((row) => ({
      customer_name: row.customer_name || `Row ${row.row_number}`,
      phone: row.phone || null,
      source: row.source || "unknown_import",
      quality: row.quality || "pending",
      lead_status: row.lead_status || "pending",
      stage: row.stage || "new",
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
    }));

    // Batch insert
    const BATCH_SIZE = 50;
    let imported = 0;
    const importedIds: string[] = [];
    const errors: { row: number; error: string }[] = [];

    for (let i = 0; i < leadsToInsert.length; i += BATCH_SIZE) {
      const batch = leadsToInsert.slice(i, i + BATCH_SIZE);
      const { data, error: insertErr } = await adminClient
        .from("leads")
        .insert(batch)
        .select("id");

      if (insertErr) {
        // Row-by-row fallback
        for (let j = 0; j < batch.length; j++) {
          const { data: single, error: singleErr } = await adminClient
            .from("leads")
            .insert(batch[j])
            .select("id")
            .single();
          if (singleErr) {
            errors.push({
              row: i + j + 1,
              error: singleErr.message,
            });
          } else {
            imported++;
            importedIds.push(single.id);
          }
        }
      } else {
        imported += data.length;
        for (const d of data) importedIds.push(d.id);
      }
    }

    // Insert follow_up_logs for notes
    let notesCreated = 0;
    const notesToInsert: any[] = [];
    for (let i = 0; i < allRows.length; i++) {
      const row = allRows[i];
      const notes = row.notes?.trim();
      if (notes && i < importedIds.length) {
        notesToInsert.push({
          lead_id: importedIds[i],
          contact_type: "note",
          summary: notes,
          user_id: user.id,
          no_answer: false,
          created_at: now,
        });
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
      imported_ids: importedIds,
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
