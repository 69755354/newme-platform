// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import {
  OrganizationAuthorizationError,
  resolveOrganizationAuthorization,
} from "@/lib/organization-authorization";
import {
  applyRequestAuthCookies,
  RequestAuthError,
  type RequestAuthContext,
} from "@/lib/request-auth-context";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_FILE_BYTES + 64 * 1024;
const MAX_IMPORT_ROWS = 2_000;

class ProductImportRequestError extends Error {
  readonly status: 400 | 413 | 415;
  readonly code: string;

  constructor(status: 400 | 413 | 415, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function jsonWithAuthCookies(
  context: RequestAuthContext,
  body: unknown,
  init?: ResponseInit,
) {
  return applyRequestAuthCookies(context, NextResponse.json(body, init));
}

async function readBoundedMultipartForm(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw new ProductImportRequestError(415, "multipart_form_required");
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new ProductImportRequestError(400, "invalid_content_length");
    }
    if (parsedLength > MAX_REQUEST_BYTES) {
      throw new ProductImportRequestError(413, "product_import_request_too_large");
    }
  }

  if (!request.body) {
    throw new ProductImportRequestError(400, "multipart_body_required");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_REQUEST_BYTES) {
      await reader.cancel("product_import_request_too_large");
      throw new ProductImportRequestError(413, "product_import_request_too_large");
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request.url, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  }).formData();
}

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
  const sku = row.sku?.trim();
  if (!sku) {
    return { row: rowNum, data: row, reason: `Row ${rowNum}: "sku" is required` };
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
    name: row.name?.trim() ?? "",
    category: row.category?.trim() || null,
    sku: row.sku?.trim() ?? "",
    unit_price: unitPrice ?? 0,
    description: row.description?.trim() || null,
    unit: row.unit?.trim() || null,
  };
}

// ─── Route handler ───
export async function POST(request: NextRequest) {
  let accessContext: RequestAuthContext | undefined;
  try {
    const access = await resolveOrganizationAuthorization(
      request,
      "catalog.products.import",
      "write",
    );
    accessContext = access.context;

    // Parse the uploaded file
    const formData = await readBoundedMultipartForm(request);
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return jsonWithAuthCookies(
        access.context,
        { error: "No file provided" },
        { status: 400 },
      );
    }
    if (file.size > MAX_FILE_BYTES) {
      return jsonWithAuthCookies(
        access.context,
        { error: "product_import_file_too_large" },
        { status: 413 },
      );
    }

    const text = await file.text();
    const { rows: rawRows } = parseCSV(text);

    if (rawRows.length === 0) {
      return jsonWithAuthCookies(
        access.context,
        { error: "CSV file is empty or invalid" },
        { status: 400 },
      );
    }
    if (rawRows.length > MAX_IMPORT_ROWS) {
      return jsonWithAuthCookies(
        access.context,
        { error: "product_import_row_limit_exceeded" },
        { status: 413 },
      );
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

    const { data: importResult, error: importError } =
      await access.context.supabase.rpc("import_products_for_organization", {
        p_organization_id: access.organizationId,
        p_products: validated.map((entry) => entry.product),
      });

    if (importError || !importResult || typeof importResult !== "object") {
      return jsonWithAuthCookies(
        access.context,
        { error: "product_import_failed" },
        { status: 503 },
      );
    }

    const result = importResult as {
      created?: unknown;
      failed_indexes?: unknown;
    };
    if (
      !Number.isInteger(result.created)
      || !Array.isArray(result.failed_indexes)
      || result.failed_indexes.some(
        (index) => !Number.isInteger(index) || index < 0 || index >= validated.length,
      )
    ) {
      return jsonWithAuthCookies(
        access.context,
        { error: "product_import_failed" },
        { status: 503 },
      );
    }

    for (const index of result.failed_indexes as number[]) {
      const source = validated[index];
      failed.push({
        row: index + 2,
        data: source.row,
        reason: `Row ${index + 2}: product_import_insert_failed`,
      });
    }
    const created = result.created as number;

    return jsonWithAuthCookies(
      access.context,
      {
        organization_id: access.organizationId,
        created,
        total: rawRows.length,
        failed: failed.length > 0 ? failed : undefined,
      },
    );
  } catch (error: unknown) {
    if (error instanceof OrganizationAuthorizationError) {
      return jsonWithAuthCookies(
        error.context,
        { error: error.code },
        { status: error.status },
      );
    }
    if (error instanceof RequestAuthError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    if (error instanceof ProductImportRequestError) {
      const response = NextResponse.json(
        { error: error.code },
        { status: error.status },
      );
      return accessContext
        ? applyRequestAuthCookies(accessContext, response)
        : response;
    }
    console.error("[Products Import] Error:", error);
    const response = NextResponse.json(
      { error: "product_import_failed" },
      { status: 503 },
    );
    return accessContext
      ? applyRequestAuthCookies(accessContext, response)
      : response;
  }
}
