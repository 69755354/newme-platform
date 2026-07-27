import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import {
  MAX_XLSX_FILE_BYTES,
  MAX_XLSX_ROWS,
  validateXlsxImportLimits,
} from "../../src/lib/xlsx-import-limits.mjs";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");
const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
const SHEETJS_CDN = "https://cdn.sheetjs.com/xlsx-0.20.2/xlsx-0.20.2.tgz";

test("production xlsx dependency is pinned to the patched official release", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  const packageLock = JSON.parse(await read("package-lock.json"));
  const pnpmLock = await read("pnpm-lock.yaml");
  const lockedXlsx = packageLock.packages["node_modules/xlsx"];

  assert.equal(packageJson.dependencies.xlsx, SHEETJS_CDN);
  assert.equal(lockedXlsx.version, "0.20.2");
  assert.equal(lockedXlsx.resolved, SHEETJS_CDN);
  assert.equal(
    pnpmLock.includes(`xlsx@${SHEETJS_CDN}`),
    true,
    "pnpm lock must resolve the same official tarball",
  );
  assert.equal(pnpmLock.includes("xlsx@0.18.5"), false);
});

test("normal workbook import preserves lead fields and values", () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Client Name", "Phone", "Quotation Value", "Notes"],
    ["Acme LLC", "+971 50 123 4567", "AED 12,500", "Call tomorrow"],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, "Leads");

  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const parsed = XLSX.read(bytes, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json(parsed.Sheets[parsed.SheetNames[0]], { defval: "" });

  assert.deepEqual(rows, [{
    "Client Name": "Acme LLC",
    Phone: "+971 50 123 4567",
    "Quotation Value": "AED 12,500",
    Notes: "Call tomorrow",
  }]);
});

test("malformed and prototype-like workbook input stays inside the parser boundary", () => {
  assert.throws(() => XLSX.read(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]), { type: "array" }));

  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["__proto__", "constructor", "Client Name"],
    ["polluted", "evil", "Acme LLC"],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, "Leads");
  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const parsed = XLSX.read(bytes, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json(parsed.Sheets[parsed.SheetNames[0]], { defval: "" });

  assert.equal(({}).polluted, undefined);
  assert.equal(rows[0]["Client Name"], "Acme LLC");
});

test("xlsx bytes are parsed only in the guarded client import entrypoint", async () => {
  const dialog = await read("src/components/leads/ExcelImportDialog.tsx");
  const preview = await read("src/app/api/leads/import/preview/route.ts");
  const confirm = await read("src/app/api/leads/import/confirm/route.ts");

  assert.ok(dialog.includes('await import("xlsx")'));
  assert.ok(dialog.includes('if (!lower.endsWith(".xlsx") && !lower.endsWith(".xls"))'));
  assert.match(
    dialog,
    /try \{\s*const XLSX = await import\("xlsx"\);[\s\S]*catch \(e: any\) \{\s*setError\(e\?\.message \|\| t\("leads\.importError"\)\);/,
    "parser failures must stay in the controlled UI error path",
  );
  assert.equal(preview.includes('from "xlsx"'), false);
  assert.equal(confirm.includes('from "xlsx"'), false);
  assert.ok(preview.includes('["admin", "boss"].includes(profile.role)'));
  assert.ok(confirm.includes('["admin", "boss"].includes(profile.role)'));
});


test("xlsx resource limits reject oversized files and row sets", () => {
  assert.doesNotThrow(() => validateXlsxImportLimits({
    fileBytes: MAX_XLSX_FILE_BYTES,
    rowCount: MAX_XLSX_ROWS,
  }));
  assert.throws(
    () => validateXlsxImportLimits({ fileBytes: MAX_XLSX_FILE_BYTES + 1 }),
    /file is too large/i,
  );
  assert.throws(
    () => validateXlsxImportLimits({ rowCount: MAX_XLSX_ROWS + 1 }),
    /too many rows/i,
  );
});

test("client and server enforce the shared xlsx limits before work is accepted", async () => {
  const dialog = await read("src/components/leads/ExcelImportDialog.tsx");
  const preview = await read("src/app/api/leads/import/preview/route.ts");
  const confirm = await read("src/app/api/leads/import/confirm/route.ts");

  assert.ok(dialog.indexOf("validateXlsxImportLimits({ fileBytes: file.size })") < dialog.indexOf("file.arrayBuffer()"));
  assert.match(dialog, /validateXlsxImportLimits\(\{ rowCount: rows\.length \}\)/);
  assert.match(preview, /validateXlsxImportLimits\(\{ rowCount: rawRows\.length \}\)/);
  assert.match(confirm, /validateXlsxImportLimits\(\{ rowCount: rows\.length \}\)/);
});
