import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import Module, { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { normalizeLeadgenId } from "../../src/lib/meta-crm-events.ts";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function loadPreview(role = "admin") {
  const filename = path.join(root, "src/app/api/leads/import/preview/route.ts");
  const ts = require("typescript");
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const query = { select() { return query; }, eq() { return query; }, single: async () => ({ data: { role } }) };
  const db = { auth: { getUser: async () => ({ data: { user: { id: "test-operator" } }, error: null }) }, from: () => query };
  const mocks = {
    "next/server": { NextResponse: { json: (body, init = {}) => ({ status: init.status ?? 200, body }) } },
    "@/lib/supabase-server": { createServerSupabase: async () => db },
    "@/lib/meta-crm-events": { normalizeLeadgenId },
  };
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const previous = Module._load;
  Module._load = function (name, parent, main) {
    return Object.hasOwn(mocks, name) ? mocks[name] : previous.call(this, name, parent, main);
  };
  try { loaded._compile(outputText, filename); return loaded.exports; }
  finally { Module._load = previous; }
}
async function preview(value, key = "Meta Lead ID", role = "admin") {
  const row = { "Client Name": "Internal fixture", "Phone": "+971501234567", ...(value === undefined ? {} : { [key]: value }) };
  return loadPreview(role).POST(new Request("http://localhost/api/leads/import/preview", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rows: [row] }),
  }));
}
test("numeric spreadsheet IDs cannot bypass exact-ID validation through String", async () => {
  for (const value of [Number("12345678901234567"), 1234567890123456]) {
    const result = await preview(value);
    assert.equal(result.status, 200);
    assert.equal(result.body.all_rows[0].raw_import_data.raw_leadgen_id, undefined);
    assert.match(result.body.warnings.join(" "), /Meta Lead ID omitted/);
    assert.equal(result.body.importable, 1, "the inquiry remains importable without optional metadata");
    assert.equal(result.body.all_rows[0].customer_name, "Internal fixture");
  }
});
test("text Meta IDs retain every digit across supported column aliases", async () => {
  for (const key of ["Meta Lead ID", "leadgen id", "leadgen_id"]) {
    const result = await preview("12345678901234567", key);
    assert.equal(result.body.all_rows[0].raw_import_data.raw_leadgen_id, "12345678901234567");
    assert.deepEqual(result.body.warnings, []);
  }
  assert.equal((await preview(123456789012345)).body.all_rows[0].raw_import_data.raw_leadgen_id, "123456789012345");
});
test("missing or blank IDs preserve the old import fingerprint shape", async () => {
  for (const value of [undefined, "", null]) {
    const result = await preview(value);
    assert.equal(Object.hasOwn(result.body.all_rows[0].raw_import_data, "raw_leadgen_id"), false);
    assert.deepEqual(result.body.warnings, []);
  }
});
test("malformed optional IDs warn without blocking a valid customer", async () => {
  const result = await preview("not-a-meta-id");
  assert.equal(result.body.importable, 1);
  assert.equal(Object.hasOwn(result.body.all_rows[0].raw_import_data, "raw_leadgen_id"), false);
  assert.equal(result.body.warnings.length, 1);
});
test("preview keeps the existing admin and boss authorization boundary", async () => {
  assert.equal((await preview("12345678901234567", "Meta Lead ID", "sales")).status, 403);
});
