// S43 release order: the application may ship before the leave-cover migration (20261124300000) is applied.
// A select that names cover_user_id / cover_start / cover_end then fails with Postgres 42703 (undefined column);
// the team page user list and the daily brief must fall back to the query without those columns.
// The loader replaces Module._load for one load, so the runner gives this file its own process.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const ts = require("typescript");
const root = path.resolve(import.meta.dirname, "../..");

function loadModule(relativePath, mocks) {
  const filename = path.join(root, relativePath);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename, compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const previousLoad = Module._load;
  Module._load = (request, parent, isMain) => (Object.hasOwn(mocks, request) ? mocks[request] : previousLoad.call(Module, request, parent, isMain));
  try { loaded._compile(outputText, filename); return loaded.exports; } finally { Module._load = previousLoad; }
}

class FakeResponse { constructor(body, init) { this.body = body; this.status = init?.status ?? 200; } static json(body, init) { return new FakeResponse(body, init); } }
const ADMIN = "00000000-0000-4000-8000-0000000000ad";
const PEOPLE = [{ id: ADMIN, email: "a@example.test", full_name: "Admin", role: "admin", is_active: true, last_active_at: null, force_password_change: false }];

function loadUsers({ columnsExist, failWith = null }) {
  const selects = [];
  const profileQuery = (columns) => {
    selects.push(columns);
    const missing = !columnsExist && /cover_/.test(columns);
    const result = failWith ? { data: null, error: failWith } : missing ? { data: null, error: { code: "42703", message: 'column "cover_user_id" does not exist' } } : { data: PEOPLE, error: null };
    const q = { or: () => q, order: () => Promise.resolve(result) };
    return q;
  };
  const route = loadModule("src/app/api/users/route.ts", {
    "next/server": { NextRequest: class {}, NextResponse: FakeResponse },
    "@/lib/supabase-server": {
      createServerSupabase: async () => ({
        auth: { getUser: async () => ({ data: { user: { id: ADMIN } }, error: null }) },
        from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { role: "admin" }, error: null }) }) }) }),
      }),
    },
    "@/lib/supabase-admin": {
      supabaseAdmin: { from: () => ({ select: profileQuery }), auth: { admin: { listUsers: async () => ({ data: { users: [] } }) } } },
    },
    "@/lib/audit-log": { AUDIT_ACTIONS: {}, writeAuditLog: async () => {} },
    "@/lib/system-accounts.mjs": require("../../src/lib/system-accounts.mjs"),
  });
  return { route, selects };
}

const request = { headers: { get: () => null }, url: "https://app.example.test/api/users" };

test("users API: with the cover columns present the list carries them", async () => {
  const { route, selects } = loadUsers({ columnsExist: true });
  const response = await route.GET(request);
  assert.equal(response.status, 200);
  assert.equal(response.body.users.length, 1);
  assert.equal(selects.length, 1);
  assert.match(selects[0], /cover_user_id, cover_start, cover_end/);
});

test("users API: columns not migrated yet (42703) -> the list still comes back, read again without the cover columns", async () => {
  const { route, selects } = loadUsers({ columnsExist: false });
  const response = await route.GET(request);
  assert.equal(response.status, 200, "the team page must not get a 500 before the migration is applied");
  assert.equal(response.body.users.length, 1);
  assert.equal(selects.length, 2);
  assert.doesNotMatch(selects[1], /cover_/);
});

test("users API: any other database error is still a 500", async () => {
  const { route } = loadUsers({ columnsExist: true, failWith: { code: "57014", message: "timeout" } });
  assert.equal((await route.GET(request)).status, 500);
});

test("daily brief: the profile read falls back without the cover columns on 42703", async () => {
  const { loadData } = await import("../../scripts/daily-brief.mjs");
  for (const columnsExist of [true, false]) {
    const profileSelects = [];
    const db = {
      from(table) {
        let columns = "";
        const q = {
          select: (c) => { columns = String(c); if (table === "profiles") profileSelects.push(columns); return q; },
          eq: () => q, or: () => q, gte: () => q, neq: () => q, in: () => q, order: () => q, range: () => q, limit: () => q,
          then: (resolve) => resolve(table === "profiles" && !columnsExist && /cover_/.test(columns)
            ? { data: null, error: { code: "42703", message: "column does not exist" } }
            : { data: table === "profiles" ? [{ id: "u1", is_active: true }] : [], error: null, count: 0 }),
        };
        return q;
      },
    };
    const data = await loadData(db, new Date("2026-11-25T05:00:00Z"));
    assert.deepEqual(data.profiles.map((p) => p.id), ["u1"], `columnsExist=${columnsExist}`);
    assert.equal(profileSelects.length, columnsExist ? 1 : 2);
    if (!columnsExist) assert.doesNotMatch(profileSelects[1], /cover_/);
  }
});
