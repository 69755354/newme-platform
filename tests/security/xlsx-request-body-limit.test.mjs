import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MAX_XLSX_REQUEST_BYTES,
  readXlsxImportJson,
  validateXlsxImportLimits,
} from "../../src/lib/xlsx-import-limits.mjs";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("bounded XLSX JSON reader accepts valid requests and row limits", async () => {
  const request = new Request("https://staging.invalid/api/leads/import/preview", {
    method: "POST",
    body: JSON.stringify({ rows: [{ customer_name: "Synthetic" }] }),
  });

  const body = await readXlsxImportJson(request);
  assert.deepEqual(body, { rows: [{ customer_name: "Synthetic" }] });
  assert.doesNotThrow(() => validateXlsxImportLimits({ rowCount: 2_000 }));
  assert.throws(
    () => validateXlsxImportLimits({ rowCount: 2_001 }),
    /too many rows/i,
  );
});

test("declared and streamed request sizes both fail closed", async () => {
  const declared = new Request("https://staging.invalid/api/leads/import/preview", {
    method: "POST",
    headers: { "content-length": String(MAX_XLSX_REQUEST_BYTES + 1) },
    body: "{}",
  });
  await assert.rejects(() => readXlsxImportJson(declared), /request is too large/i);

  const oversizedChunk = new Uint8Array(MAX_XLSX_REQUEST_BYTES + 1);
  const streamed = new Request("https://staging.invalid/api/leads/import/preview", {
    method: "POST",
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(oversizedChunk);
        controller.close();
      },
    }),
    duplex: "half",
  });
  await assert.rejects(() => readXlsxImportJson(streamed), /request is too large/i);
});

test("malformed lengths and JSON are rejected as bad input", async () => {
  const badLength = new Request("https://staging.invalid/api/leads/import/preview", {
    method: "POST",
    headers: { "content-length": "not-a-number" },
    body: "{}",
  });
  await assert.rejects(() => readXlsxImportJson(badLength), /Content-Length/);

  const badJson = new Request("https://staging.invalid/api/leads/import/preview", {
    method: "POST",
    body: "{",
  });
  await assert.rejects(() => readXlsxImportJson(badJson), /valid JSON/);
});

test("preview and confirm bound the body before reading rows", async () => {
  for (const path of [
    "src/app/api/leads/import/preview/route.ts",
    "src/app/api/leads/import/confirm/route.ts",
  ]) {
    const source = await read(path);
    assert.doesNotMatch(source, /request\.json\(\)/);
    assert.match(source, /await readXlsxImportJson\(request\)/);
    assert.match(source, /validateXlsxImportLimits\(\{ rowCount:/);
    assert.ok(
      source.indexOf("await readXlsxImportJson(request)") <
        source.indexOf("validateXlsxImportLimits({ rowCount:"),
    );
  }
});

