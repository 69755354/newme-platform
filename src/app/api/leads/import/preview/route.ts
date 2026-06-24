// POST /api/leads/import/preview — Parse Excel, return preview rows (no DB write)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

const QUALITY_MAP: Record<string, string> = {
  "0": "poor", "0.1": "poor", "0.2": "poor",
  "0.4": "normal", "0.5": "normal", "0.6": "normal",
  "0.7": "good", "0.8": "good", "0.9": "good",
};

function mapQuality(raw: string | null): { quality: string; warning?: string } {
  if (!raw || raw.trim() === "") return { quality: "pending" };
  const v = raw.trim();
  if (QUALITY_MAP[v]) return { quality: QUALITY_MAP[v] };
  return { quality: "pending", warning: `Unknown quality '${v}' → pending` };
}

function mapSource(raw: string | null): string {
  if (!raw || raw.trim() === "") return "unknown_import";
  const v = raw.trim().toLowerCase();
  if (v === "instgram") return "instagram";
  return v;
}

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: any;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { rows } = body; // rows parsed from Excel (array of arrays or objects)
  if (!rows || !Array.isArray(rows)) return NextResponse.json({ error: "rows array required" }, { status: 400 });

  const warnings: string[] = [];
  const preview: any[] = [];
  let skipped = 0;
  let importable = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r || typeof r !== "object") { skipped++; continue; }

    const clientName = String(r["Client Name"] || r["client_name"] || "").trim();
    const phone = String(r["Contact Number"] || r["contact_number"] || "").trim();
    const statusRaw = String(r["Status"] || r["status"] || "").trim();
    const sourceRaw = String(r["Ledes From"] || r["source"] || "").trim();
    const qualityRaw = String(r["Client Quality"] || r["client_quality"] || "").trim();
    const notesRaw = String(r["Notes"] || r["notes"] || "").trim();
    const idVal = String(r["ID"] || r["id"] || "").trim();

    // Skip id-only rows
    if (idVal && !clientName && !phone && !statusRaw && !sourceRaw && !notesRaw) {
      skipped++;
      continue;
    }

    const { quality, warning: qw } = mapQuality(qualityRaw);
    if (qw) warnings.push(`Row ${i}: ${qw}`);

    const entry = {
      row_number: i,
      raw_id: idVal || null,
      customer_name: clientName || null,
      phone: phone || null,
      source: mapSource(sourceRaw),
      raw_source: sourceRaw || null,
      current_milestone: statusRaw ? "contacted" : "new",
      raw_status: statusRaw || null,
      quality,
      raw_quality: qualityRaw || null,
      location: String(r["Emirate / Location"] || r["emirate"] || "").trim() || null,
      project_type: String(r["Project Type"] || r["project_type"] || "").trim() || null,
      quotation_value: parseFloat(String(r["Quotation Value"] || r["quotation_value"] || "0")) || null,
      notes: notesRaw || null,
      has_notes: !!notesRaw,
    };
    preview.push(entry);
    importable++;
  }

  return NextResponse.json({
    total_rows: rows.length,
    importable,
    skipped,
    warnings,
    preview: preview.slice(0, 20),
    all_rows: preview, // full for confirm step
  });
}
