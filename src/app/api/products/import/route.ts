import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// ─── CSV parser ───
function parseCSV(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return { headers: [], rows: [] };

  const headers = parseCSVLine(lines[0]).map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length === 0 || (values.length === 1 && values[0] === "")) continue; // skip empty
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j]?.trim() ?? "";
    }
    rows.push(row);
  }

  return { headers, rows };
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        result.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

// ─── Column mapping ───
const COLUMN_ALIASES: Record<string, string> = {
  name: "name",
  product_name: "name",
  product: "name",
  category: "category",
  sku: "sku",
  code: "sku",
  product_code: "sku",
  unit_price: "unit_price",
  price: "unit_price",
  cost: "unit_price",
  rate: "unit_price",
  description: "description",
  desc: "description",
  unit: "unit",
  uom: "unit",
  unit_of_measure: "unit",
};

function normalizeRow(raw: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const mapped = COLUMN_ALIASES[key] || key;
    if (mapped) normalized[mapped] = value;
  }
  return normalized;
}

// ─── Row validation ───
interface ValidationError {
  row: number;
  data: Record<string, string>;
  reason: string;
}

function validateRow(row: Record<string, string>, rowNum: number): ValidationError | null {
  const name = row.name?.trim();
  if (!name) {
    return { row: rowNum, data: row, reason: `Row ${rowNum}: "name" is required` };
  }

  const unitPriceStr = row.unit_price?.trim();
  if (unitPriceStr !== undefined && unitPriceStr !== "") {
    const price = parseFloat(unitPriceStr);
    if (isNaN(price) || price < 0) {
      return {
        row: rowNum,
        data: row,
        reason: `Row ${rowNum}: "unit_price" must be a valid positive number, got "${unitPriceStr}"`,
      };
    }
  }

  const category = row.category?.trim();
  const validCategories = [
    "knx", "hvac", "audio", "network", "security",
    "intercom", "cable", "service", "lighting",
  ];
  if (category && !validCategories.includes(category.toLowerCase())) {
    return {
      row: rowNum,
      data: row,
      reason: `Row ${rowNum}: invalid category "${category}". Must be one of: ${validCategories.join(", ")}`,
    };
  }

  return null;
}

function buildProductRow(row: Record<string, string>) {
  const unitPriceStr = row.unit_price?.trim();
  const unitPrice = unitPriceStr ? parseFloat(unitPriceStr) : null;

  return {
    name: row.name?.trim() || null,
    category: row.category?.trim() || null,
    sku: row.sku?.trim() || null,
    unit_price: unitPrice,
    description: row.description?.trim() || null,
    unit: row.unit?.trim() || null,
  };
}

// ─── Route handler ───
export async function POST(request: NextRequest) {
  try {
    // Use service role for bulk insert (bypasses RLS)
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const adminClient = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Verify auth — read user from cookie
    const cookieHeader = request.headers.get("cookie") || "";
    const cookieMatch = cookieHeader.match(
      /sb-vfopmpxlhwzpxqegayew-auth-token(?:\.\d+)?=([^;]+)/
    );
    if (!cookieMatch) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let session: any = null;
    try { session = JSON.parse(cookieMatch[1]); } catch {}
    if (!session) {
      try { session = JSON.parse(atob(cookieMatch[1])); } catch {}
    }
    if (!session) {
      try { session = JSON.parse(decodeURIComponent(cookieMatch[1])); } catch {}
    }

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check role — only boss/admin can import
    const { data: profile } = await adminClient
      .from("profiles")
      .select("role")
      .eq("id", session.user.id)
      .single();

    if (!profile || !["boss", "admin"].includes(profile.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Parse the uploaded file
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const text = await file.text();
    const { rows: rawRows } = parseCSV(text);

    if (rawRows.length === 0) {
      return NextResponse.json({ error: "CSV file is empty or invalid" }, { status: 400 });
    }

    // Normalize and validate
    const validated: { row: Record<string, string>; product: ReturnType<typeof buildProductRow> }[] = [];
    const failed: { row: number; data: Record<string, string>; reason: string }[] = [];

    for (let i = 0; i < rawRows.length; i++) {
      const normalized = normalizeRow(rawRows[i]);
      const error = validateRow(normalized, i + 2); // +2 because row 1 is header
      if (error) {
        failed.push(error);
      } else {
        validated.push({ row: normalized, product: buildProductRow(normalized) });
      }
    }

    // Batch insert valid rows
    const batchSize = 100;
    let created = 0;

    for (let i = 0; i < validated.length; i += batchSize) {
      const batch = validated.slice(i, i + batchSize).map((v) => v.product);

      const { error: insertErr } = await adminClient
        .from("products")
        .insert(batch);

      if (insertErr) {
        // Try inserting one by one for this batch to isolate failures
        for (let j = 0; j < batch.length; j++) {
          const { error: singleErr } = await adminClient
            .from("products")
            .insert(batch[j]);
          if (singleErr) {
            failed.push({
              row: i + j + 2,
              data: validated[i + j].row,
              reason: `Row ${i + j + 2}: ${singleErr.message}`,
            });
          } else {
            created++;
          }
        }
      } else {
        created += batch.length;
      }
    }

    return NextResponse.json({
      created,
      total: rawRows.length,
      failed: failed.length > 0 ? failed : undefined,
    });
  } catch (err: any) {
    console.error("[Products Import] Error:", err);
    return NextResponse.json(
      { error: err.message || "Failed to import products" },
      { status: 500 },
    );
  }
}
