// S12: notification rows the application writes must satisfy the production CHECK
// constraints (notifications_related_type_check / notifications_type_check). Staging
// logs showed team_member_added failing with 23514 because related_type "user" is not
// an allowed value. The allowed sets are read from the production schema snapshot and
// then from the newest migration that redefines the constraint (S16 widened both lists).
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
const migrationsDir = path.join(root, "supabase/migrations");
const migrationFiles = fs.readdirSync(migrationsDir).filter((f) => /^[0-9]{14}_.*\.sql$/.test(f)).sort();
/** The effective allowed values: the newest migration that redefines the constraint, else the snapshot. */
function allowed(constraint) {
  const pattern = new RegExp(`add constraint ${constraint}\\b([^;]*);`, "i");
  for (const file of [...migrationFiles].reverse()) {
    const match = pattern.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
    if (match) return { file, values: new Set([...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])) };
  }
  const line = baseline.split("\n").find((l) => l.includes(`ADD CONSTRAINT ${constraint} `));
  assert.ok(line, `${constraint} present in the production snapshot`);
  return { file: "baseline", values: new Set([...line.matchAll(/'([a-z_]+)'::character varying/g)].map((m) => m[1])) };
}
const RELATED = allowed("notifications_related_type_check");
const TYPE = allowed("notifications_type_check");
const RELATED_TYPES = RELATED.values;
const TYPES = TYPE.values;

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

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(full);
  }
  return out;
}
const SRC_FILES = walk(path.join(root, "src"));

test("the S16 migration widened both constraints and every older value is kept", () => {
  assert.equal(TYPE.file, "20261112100100_notification_warning_type.sql"); // the newest file that redefines the check
  assert.equal(RELATED.file, "20261112100000_notification_constraints_and_lead_owner_contracts.sql");
  for (const value of ["contract_created", "reminder", "warning"]) assert.ok(TYPES.has(value), `type ${value}`);
  for (const value of ["task", "digest"]) assert.ok(RELATED_TYPES.has(value), `related_type ${value}`);
  const snapshot = (name) => {
    const line = baseline.split("\n").find((l) => l.includes(`ADD CONSTRAINT ${name} `));
    return [...line.matchAll(/'([a-z_]+)'::character varying/g)].map((m) => m[1]);
  };
  for (const value of snapshot("notifications_type_check")) assert.ok(TYPES.has(value), `older type ${value} kept`);
  for (const value of snapshot("notifications_related_type_check")) assert.ok(RELATED_TYPES.has(value), `older related_type ${value} kept`);
});

// related_type literals, written either way: relatedType: (drafts) or related_type: (direct inserts).
test("every related_type literal anywhere in src/ is allowed by the database", () => {
  let seen = 0;
  for (const f of SRC_FILES) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/\brelated(?:T|_t)ype:\s*(["'])([a-z_]+)\1/g)) {
      seen += 1;
      assert.ok(RELATED_TYPES.has(m[2]), `${path.relative(root, f)}: related_type "${m[2]}" not allowed`);
    }
  }
  assert.ok(seen > 0);
});

// type: literals are scanned only in the files that write notification rows, registered per file,
// because type: is also used for activities, events and form fields elsewhere. A new producer file
// must be added here; a literal the database does not accept needs
// a per-file, per-value allowance with the reason, so it cannot hide behind a global one.
const NOTIFICATION_PRODUCERS = [
  "src/lib/daily-digest.mjs",
  "src/lib/notification-events.ts",
  "src/app/actions/team.ts",
  "src/app/api/users/route.ts",
  "src/app/api/contracts/route.ts",
  "src/app/api/contracts/[id]/route.ts",
  "src/app/api/contracts/[id]/approve/route.ts",
  "src/app/api/contracts/[id]/revoke/route.ts",
  "src/app/api/contracts/[id]/remind-payment/route.ts",
  "src/app/api/cron/check-no-answer/route.ts",
  "src/app/api/cron/check-overdue-installments/route.ts",
  "src/app/api/cron/daily-reminder/route.ts",
];
test("every notification type literal in the registered producer files is allowed by the database", () => {
  let seen = 0;
  for (const rel of NOTIFICATION_PRODUCERS) {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    for (const m of src.matchAll(/(?<![A-Za-z_])type:\s*(["'])([a-z_]+)\1/g)) {
      seen += 1;
      const v = m[2];
      assert.ok(TYPES.has(v), `${rel}: notification type "${v}" not allowed`);
    }
  }
  assert.ok(seen > 5);
});

// The no-answer cron inserts type "warning" with related_type "lead"; the constraint used to
// refuse it and the cron swallowed the error, so the "3 unanswered calls" alert never arrived.
test("the no-answer alert writes values the database accepts", () => {
  const cron = fs.readFileSync(path.join(root, "src/app/api/cron/check-no-answer/route.ts"), "utf8");
  assert.match(cron, /type:\s*'warning'/);
  assert.match(cron, /related_type:\s*'lead'/);
  assert.ok(TYPES.has("warning") && RELATED_TYPES.has("lead"));
});

test("the daily reminder and the daily digest write values the database accepts", () => {
  const reminder = fs.readFileSync(path.join(root, "src/app/api/cron/daily-reminder/route.ts"), "utf8");
  assert.match(reminder, /type:\s*'reminder'/);
  assert.match(reminder, /related_type:\s*'task'/);
  assert.ok(TYPES.has("reminder") && RELATED_TYPES.has("task"));
  const digest = fs.readFileSync(path.join(root, "src/lib/daily-digest.mjs"), "utf8");
  assert.match(digest, /relatedType:\s*"digest"/);
  assert.ok(RELATED_TYPES.has("digest") && TYPES.has("followup_reminder"));
});

// contract_created was withheld in S12 while the constraint rejected it; the sender is back.
test("POST /api/contracts sends contract_created after the contract is committed", () => {
  const src = fs.readFileSync(path.join(root, "src/app/api/contracts/route.ts"), "utf8");
  assert.ok(TYPES.has("contract_created"));
  const created = src.indexOf("const contract = created as");
  const sender = src.indexOf('type: "contract_created"');
  const respond = src.indexOf("{ status: 201 }");
  assert.ok(created >= 0 && sender > created && respond > sender, "sent after the RPC succeeded and before the response");
  assert.match(src, /dispatchPersistedNotification/);
  assert.match(src.slice(sender - 400, sender + 600), /catch \(notifyErr\)/, "a failed notification never fails the request");
});

test("quotation convert does not send contract_pending_approval for a draft; the submit path does", () => {
  const convert = fs.readFileSync(path.join(root, "src/app/api/quotations/[id]/convert/route.ts"), "utf8");
  assert.doesNotMatch(convert, /type:\s*"contract_pending_approval"/);
  const status = fs.readFileSync(path.join(root, "src/app/api/contracts/[id]/route.ts"), "utf8");
  assert.match(status, /type:\s*"contract_pending_approval"/);
});
