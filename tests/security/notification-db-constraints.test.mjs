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

test("every related_type literal written by notification producers is allowed by the database", () => {
  const files = [
    "src/lib/notification-events.ts",
    "src/app/api/users/route.ts",
    "src/app/api/contracts/[id]/remind-payment/route.ts",
    "src/app/api/contracts/[id]/revoke/route.ts",
    "src/app/api/leads/route.ts",
    "src/app/api/cron/daily-digest/route.ts",
  ];
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), "utf8");
    for (const m of src.matchAll(/relatedType:\s*"([a-z_]+)"/g)) {
      assert.ok(RELATED_TYPES.has(m[1]), `${f}: related_type "${m[1]}" not allowed`);
    }
  }
});

// Known gap, needs a migration (reported, not written here): the application emits
// contract_created (src/app/api/contracts/route.ts) but notifications_type_check does not list it.
test("contract_created is accepted by notifications_type_check", { todo: "needs a migration adding contract_created to notifications_type_check; see S12 report" }, () => {
  assert.ok(TYPES.has("contract_created"));
});
