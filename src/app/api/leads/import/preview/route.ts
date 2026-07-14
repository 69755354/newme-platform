// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

// ─── Column mapping ───
// Excel header text → snake_case field name
const COLUMN_MAP: Record<string, string> = {
  "id": "row_id",
  "company name": "company_name",
  "client name": "customer_name",
  "customer name": "customer_name",
  "contact number": "phone",
  "phone": "phone",
  "phone number": "phone",
  "mobile": "phone",
  "ledes from": "source",
  "leads from": "source",
  "lead source": "source",
  "source": "source",
  "emirate / location": "location",
  "emirate/location": "location",
  "emirate": "location",
  "location": "location",
  "client quality": "quality",
  "country/region": "country",
  "date of first contact": "first_contact",
  "project type": "project_type",
  "system": "system",
  "quotation value": "quotation_value",
  "opportunity level": "opportunity",
  "status": "raw_status",
  "notes": "notes",
};

// ─── Value mapping ───
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

function parseQuotation(raw: string): number | null {
  if (!raw) return null;
  const clean = raw.replace(/[^0-9.,]/g, "").replace(/,/g, "");
  const num = parseFloat(clean);
  return isNaN(num) || num <= 0 ? null : num;
}

interface PreviewRow {
  row_number: number;
  customer_name: string | null;
  phone: string | null;
  source: string | null;
  quality: string | null;
  location: string | null;
  project_type: string | null;
  quotation_value: number | null;
  notes: string | null;
}

interface NormalizedRow {
  row_number: number;
  customer_name: string;
  phone: string | null;
  source: string;
  quality: string;
  lead_status: string;
  stage: string;
  emirate: string | null;
  property_type: string | null;
  country: string | null;
  first_contact_date: string | null;
  quotation_value: number | null;
  notes: string | null;
  raw_import_data: {
    row_number: number;
    raw_source: string;
    raw_country: string;
    raw_quality: string;
    raw_note: string;
    raw_status: string;
    raw_system: string;
    raw_quotation: string;
    raw_opportunity: string;
  };
  // Internal markers
  _warnings: string[];
}

// ─── POST /api/leads/import/preview ───
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

    const body = await request.json();
    const rawRows: Record<string, any>[] = body.rows || [];

    if (!Array.isArray(rawRows) || rawRows.length === 0) {
      return NextResponse.json({ error: "No rows provided" }, { status: 400 });
    }

    const previews: PreviewRow[] = [];
    const warnings: string[] = [];
    const allRows: NormalizedRow[] = [];

    for (let i = 0; i < rawRows.length; i++) {
      const raw = rawRows[i];
      const rowNum = i + 1;

      // Normalize keys to lowercase
      const norm: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) {
        const key = k.trim();
        const mapped = COLUMN_MAP[key.toLowerCase()] || key.toLowerCase().replace(/\s+/g, "_");
        norm[mapped] = v == null ? "" : String(v).trim();
      }

      const rowWarnings: string[] = [];

      // Skip fully empty rows
      const nonEmpty = Object.values(norm).filter((v) => v !== "");
      if (nonEmpty.length === 0) continue;

      // Map source
      const source = mapSource(norm.source || "");
      if ((norm.source || "").toLowerCase().trim() === "instgram") {
        rowWarnings.push(`Row ${rowNum}: "instgram" → mapped to "ins"`);
      }

      // Map quality
      const { quality, warning: qWarn } = mapQuality(norm.quality || "");
      if (qWarn) rowWarnings.push(`Row ${rowNum}: ${qWarn}`);

      // Map status
      const { status: leadStatus, warning: sWarn } = mapStatus(norm.raw_status || "");
      if (sWarn) rowWarnings.push(`Row ${rowNum}: ${sWarn}`);

      // Parse quotation
      const quotationValue = parseQuotation(norm.quotation_value || "");

      // Parse date
      let firstContact: string | null = null;
      if (norm.first_contact) {
        const d = new Date(norm.first_contact);
        if (!isNaN(d.getTime())) {
          firstContact = d.toISOString().split("T")[0];
        } else {
          rowWarnings.push(`Row ${rowNum}: Unparseable date "${norm.first_contact}"`);
        }
      }

      const customerName = norm.customer_name || norm.company_name || `Row ${rowNum}`;
      const phone = norm.phone || null;
      const location = norm.location || null;
      const projectType = norm.project_type || null;
      const notes = norm.notes || null;

      previews.push({
        row_number: rowNum,
        customer_name: customerName,
        phone,
        source,
        quality,
        location,
        project_type: projectType,
        quotation_value: quotationValue,
        notes: notes ? notes.substring(0, 200) : null,
      });

      warnings.push(...rowWarnings);

      const normalized: NormalizedRow = {
        row_number: rowNum,
        customer_name: customerName,
        phone,
        source,
        quality,
        lead_status: leadStatus,
        stage: "new",
        emirate: location,
        property_type: projectType,
        country: norm.country || null,
        first_contact_date: firstContact,
        quotation_value: quotationValue,
        notes,
        raw_import_data: {
          row_number: rowNum,
          raw_source: norm.source || "",
          raw_country: norm.country || "",
          raw_quality: norm.quality || "",
          raw_note: notes || "",
          raw_status: norm.raw_status || "",
          raw_system: norm.system || "",
          raw_quotation: norm.quotation_value || "",
          raw_opportunity: norm.opportunity || "",
        },
        _warnings: rowWarnings,
      };
      allRows.push(normalized);
    }

    const skipped = allRows.filter((r) => r._warnings.length > 0).length;
    const importable = allRows.length - skipped;

    return NextResponse.json({
      total_rows: rawRows.length,
      importable,
      skipped,
      warnings,
      preview: previews,
      all_rows: allRows,
    });
  } catch (err: any) {
    console.error("[Import Preview] Error:", err);
    return NextResponse.json(
      { error: err.message || "Preview failed" },
      { status: 500 }
    );
  }
}
