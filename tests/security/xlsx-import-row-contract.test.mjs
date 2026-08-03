import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateXlsxImportRows } from "../../src/lib/xlsx-import-rows.mjs";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("XLSX import accepts a plain JSON row", () => {
  assert.doesNotThrow(() => validateXlsxImportRows([{ customer_name: "Acme" }]));
});

test("XLSX import rejects null rows", () => {
  assert.throws(() => validateXlsxImportRows([null]), /plain object/i);
});

test("XLSX import rejects array rows", () => {
  assert.throws(() => validateXlsxImportRows([[]]), /plain object/i);
});

test("XLSX import rejects primitive rows", () => {
  for (const row of ["row", 1, true]) {
    assert.throws(() => validateXlsxImportRows([row]), /plain object/i);
  }
});

test("XLSX import rejects prototype-pollution keys before either route processes rows", async () => {
  assert.throws(
    () => validateXlsxImportRows([JSON.parse('{"__proto__":"polluted"}')]),
    /unsafe column name/i,
  );

  for (const [path, firstProcessingStep] of [
    ["src/app/api/leads/import/preview/route.ts", "for (let i"],
    ["src/app/api/leads/import/confirm/route.ts", "const normalizedRows"],
  ]) {
    const source = await read(path);
    const validation = source.match(/validateXlsxImportRows\(([A-Za-z_$][\w$]*)\)/);
    assert.ok(validation, `${path} must validate the untrusted row collection`);
    const rowCollection = validation[1];
    assert.match(
      source,
      new RegExp(`!Array\\.isArray\\(${rowCollection}\\)`),
      `${path} must prove the validated value is an array`,
    );
    assert.ok(
      source.indexOf(validation[0]) < source.indexOf(firstProcessingStep),
      `${path} must validate rows before iterating them`,
    );
  }
});
