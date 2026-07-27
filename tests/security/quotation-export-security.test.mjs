import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildCsv,
  csvEscape,
  sanitizeDownloadFilenamePart,
} from "../../src/lib/csv-export.mjs";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("quotation export links use the API query contract", async () => {
  const calculator = await read("src/app/(dashboard)/quotes/quote-calculator.tsx");
  const wizard = await read("src/app/(dashboard)/quotes/quote-wizard.tsx");
  const route = await read("src/app/api/quotations/export/route.ts");

  assert.match(calculator, /\/api\/quotations\/export\?id=\$\{savedQuoteId\}/);
  assert.match(wizard, /\/api\/quotations\/export\?id=\$\{s\.savedQuoteId\}/);
  assert.match(route, /searchParams\.get\("id"\)/);
  assert.match(route, /searchParams\.get\("quote_id"\)/);
});

test("CSV export neutralizes spreadsheet formulas and preserves values", () => {
  for (const payload of ["=HYPERLINK(\"https://evil.example\")", "+cmd", "-1+2", "@SUM(A1:A2)", "\t=1+1"]) {
    const escaped = csvEscape(payload);
    assert.equal(escaped.replace(/^\"|\"$/g, "").startsWith("'"), true, payload);
  }

  assert.equal(csvEscape("Acme LLC"), "Acme LLC");
  assert.equal(csvEscape("Acme, LLC"), '"Acme, LLC"');
  assert.equal(buildCsv([["Name", "Value"], ["Acme, LLC", "=1+1"]]), "\uFEFFName,Value\n\"Acme, LLC\",'=1+1");
});

test("download filename parts cannot inject response headers or paths", () => {
  assert.equal(sanitizeDownloadFilenamePart("Q-2026/07\r\nX-Test: yes"), "Q-2026_07__X-Test__yes");
  assert.equal(sanitizeDownloadFilenamePart("   "), "download");
  assert.equal(sanitizeDownloadFilenamePart("a".repeat(200)).length, 80);
});
