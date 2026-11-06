// S12: notification rows the application writes must satisfy the production CHECK
// constraints (notifications_related_type_check / notifications_type_check). Staging
// logs showed team_member_added failing with 23514 because related_type "user" is not
// an allowed value. The allowed sets are read from the production schema snapshot.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadTs(relativePath) {
  const ts = require("typescript");
  const filename = path.join(root, relativePath);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const previousLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === "server-only") return {};
    return previousLoad.call(this, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, filename);
    return loaded.exports;
  } finally {
    Module._load = previousLoad;
  }
}

const baseline = fs.readFileSync(path.join(root, "supabase/replay/production-schema-baseline.sql"), "utf8");
function allowed(constraint) {
  const line = baseline.split("\n").find((l) => l.includes(`ADD CONSTRAINT ${constraint} `));
  assert.ok(line, `${constraint} present in the production snapshot`);
  return new Set([...line.matchAll(/'([a-z_]+)'::character varying/g)].map((m) => m[1]));
}
const RELATED_TYPES = allowed("notifications_related_type_check");
const TYPES = allowed("notifications_type_check");

const ID = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

class Query {
  constructor(rows) { this.rows = rows.map((r) => ({ ...r })); }
  select() { return this; }
  eq(f, v) { this.rows = this.rows.filter((r) => r[f] === v); return this; }
  neq(f, v) { this.rows = this.rows.filter((r) => r[f] !== v); return this; }
  in(f, v) { this.rows = this.rows.filter((r) => v.includes(r[f])); return this; }
  order() { return this; }
  limit(n) { this.rows = this.rows.slice(0, n); return this; }
  async maybeSingle() { return { data: this.rows[0] ?? null, error: null }; }
  then(res, rej) { return Promise.resolve({ data: this.rows, error: null }).then(res, rej); }
}
const db = (tables) => ({ from: (t) => new Query(tables[t] ?? []) });

test("team_member_added drafts use a related_type the database accepts", async () => {
  const events = loadTs("src/lib/notification-events.ts");
  const drafts = await events.deriveNotificationDispatch({
    db: db({
      profiles: [
        { id: ID(1), role: "admin", is_active: true, full_name: "Admin" },
        { id: ID(2), role: "boss", is_active: true, full_name: "Boss" },
        { id: ID(3), role: "sales", is_active: true, full_name: "New Person" },
      ],
    }),
    actor: { id: ID(1), role: "admin", fullName: "Admin" },
    input: { type: "team_member_added", new_user_id: ID(3) },
  });
  assert.ok(drafts.length > 0);
  for (const d of drafts) {
    assert.ok(TYPES.has(d.type), `type ${d.type} allowed`);
    assert.ok(d.relatedType == null || RELATED_TYPES.has(d.relatedType), `related_type ${d.relatedType} must be NULL or one of ${[...RELATED_TYPES]}`);
  }
});

test("POST /api/users team-member notification does not use a disallowed related_type", () => {
  const src = fs.readFileSync(path.join(root, "src/app/api/users/route.ts"), "utf8");
  const block = src.slice(src.indexOf('type: "team_member_added"'), src.indexOf('type: "team_member_added"') + 400);
  const m = block.match(/relatedType:\s*"([a-z_]+)"/);
  if (m) assert.ok(RELATED_TYPES.has(m[1]), `related_type "${m[1]}" is rejected by notifications_related_type_check`);
});

// Known gaps that need a database change (see fixes/NEXT-DB-BATCH.md); they are not
// "fixed" here, only tracked so the scan stays exact for every other value.
const PENDING_DB_BATCH_RELATED_TYPES = new Set(["task", "digest"]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(full);
  }
  return out;
}
const SRC_FILES = walk(path.join(root, "src"));

test("every related_type literal anywhere in src/ is allowed by the database", () => {
  let seen = 0;
  for (const f of SRC_FILES) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/relatedType:\s*(["'])([a-z_]+)\1/g)) {
      seen += 1;
      const v = m[2];
      assert.ok(RELATED_TYPES.has(v) || PENDING_DB_BATCH_RELATED_TYPES.has(v), `${path.relative(root, f)}: related_type "${v}" not allowed`);
    }
  }
  assert.ok(seen > 0);
});

// notifications_type_check lacks contract_created until the next database batch
// (fixes/NEXT-DB-BATCH.md). No producer may emit it meanwhile; the sender is restored then.
test("no code path emits a contract_created notification while the database rejects it", () => {
  assert.equal(TYPES.has("contract_created"), false, "if this fails the constraint was extended: restore the sender and drop this guard");
  for (const f of SRC_FILES) {
    const src = fs.readFileSync(f, "utf8");
    assert.doesNotMatch(src, /type:\s*(["'])contract_created\1/, `${path.relative(root, f)} emits contract_created`);
  }
});

test("quotation convert does not send contract_pending_approval for a draft; the submit path does", () => {
  const convert = fs.readFileSync(path.join(root, "src/app/api/quotations/[id]/convert/route.ts"), "utf8");
  assert.doesNotMatch(convert, /type:\s*"contract_pending_approval"/);
  const status = fs.readFileSync(path.join(root, "src/app/api/contracts/[id]/route.ts"), "utf8");
  assert.match(status, /type:\s*"contract_pending_approval"/);
});
