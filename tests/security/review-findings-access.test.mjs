import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setImmediate as flush } from "node:timers/promises";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { NextResponse } = require("next/server");

function load(relative, mocks) {
  const ts = require("typescript");
  const filename = path.join(root, relative);
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  // Keep mocked dynamic imports local to this module after initial compilation.
  loaded.require = function (name) {
    return Object.hasOwn(mocks, name) ? mocks[name] : Module.prototype.require.call(this, name);
  };
  const original = Module._load;
  Module._load = function (name, parent, main) {
    return Object.hasOwn(mocks, name) ? mocks[name] : original.call(this, name, parent, main);
  };
  try { loaded._compile(output, filename); return loaded.exports; }
  finally { Module._load = original; }
}

const log = { error() {}, warn() {}, info() {} };
const request = (body) => new Request("https://example.test/api", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const member = { email: "member@example.test", password: crypto.randomUUID(), full_name: "Fixture Member", role: "sales", phone: "+10000000000" };

for (const entry of ["action", "route"]) {
  for (const triggerPresent of [true, false]) {
    test(`${entry}: creating a team member completes profiles with trigger=${triggerPresent}`, async () => {
      let row;
      let deleted = false;
      const admin = {
        auth: { admin: {
          async createUser() {
            if (triggerPresent) row = { id: "new-user", full_name: member.full_name };
            return { data: { user: { id: "new-user" } }, error: null };
          },
          async deleteUser() { deleted = true; return { error: null }; },
        } },
        from(table) {
          assert.equal(table, "profiles");
          return {
            async insert(values) {
              if (row) return { error: { code: "23505" } };
              row = values;
              return { error: null };
            },
            async upsert(values, options) {
              assert.equal(options.onConflict, "id");
              row = { ...row, ...values };
              return { error: null };
            },
          };
        },
      };
      const mocks = {
        "next/server": { NextResponse },
        "@/lib/supabase-admin": { supabaseAdmin: admin },
        "@/lib/action-auth-context": { getActionAuthContext: async () => ({ role: "admin" }) },
        "@/lib/lead-reassignment.mjs": {},
        "@/lib/notifications": { getAdminUserIds: async () => [], createNotificationsBulk: async () => {} },
        "@/lib/supabase-server": { createServerSupabase: async () => ({
          auth: { getUser: async () => ({ data: { user: { id: "admin" } } }) },
          from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { role: "admin" } }) }) }) }),
        }) },
      };
      if (entry === "action") {
        const action = load("src/app/actions/team.ts", mocks);
        assert.equal((await action.addTeamMember(member)).id, "new-user");
      } else {
        const route = load("src/app/api/users/route.ts", mocks);
        assert.equal((await route.POST(request(member))).status, 201);
      }
      assert.equal(deleted, false);
      assert.deepEqual(row, { id: "new-user", email: member.email, full_name: member.full_name, role: "sales", phone: member.phone, is_active: true, force_password_change: true });
    });
  }
}

function contractRoutes(role, owner = true) {
  const signed = [];
  const updates = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "caller" } } }) },
    from(table) {
      return {
        select: () => ({ eq: () => ({ single: async () => ({ data: table === "contracts" ? { id: "contract", sales_id: owner ? "caller" : "other" } : { role } }) }) }),
        update: (values) => ({ eq: async () => { updates.push(values); return { error: null }; } }),
      };
    },
  };
  const mocks = {
    "next/server": { NextResponse },
    "@/lib/supabase-server": { createServerSupabase: async () => client },
    "@/lib/logger": { logger: log, genReqId: () => "request" },
    "@/lib/release-script": { resolveReleaseScript: () => "/fixture/presign.py" },
    child_process: { execFile: (_bin, args, _options, cb) => {
      signed.push(args[2]); cb(null, JSON.stringify({ url: "https://example.test/signed", key: args[2] }), "");
    } },
  };
  const upload = load("src/app/api/contracts/[id]/upload-url/route.ts", mocks);
  const confirm = load("src/app/api/contracts/[id]/confirm-upload/route.ts", mocks);
  const params = { params: Promise.resolve({ id: "contract" }) };
  return {
    signed, updates,
    upload: (version) => upload.POST(request({ filename: "contract.pdf", version }), params),
    confirm: (key) => confirm.POST(request({ key, filename: "contract.pdf", size: 100 }), params),
  };
}

test("contract upload rejects non-enum versions before signing, including sealed arrays", async () => {
  for (const role of ["sales", "admin"]) {
    const routes = contractRoutes(role);
    for (const version of [["sealed"], ["draft"], {}, null, true, 1, "", "other", "../sealed"]) {
      assert.equal((await routes.upload(version)).status, 400, JSON.stringify({ role, version }));
    }
    assert.deepEqual(routes.signed, []);
  }
});

test("contract signing and confirmation enforce the same role/version/ownership rules", async () => {
  for (const role of ["sales", "admin", "boss"]) {
    for (const owner of [true, false]) {
      const routes = contractRoutes(role, owner);
      for (const version of [undefined, "draft", "sealed"]) {
        const allowed = role !== "sales" || (owner && version !== "sealed");
        const upload = await routes.upload(version);
        assert.equal(upload.status, allowed ? 200 : 403, `${role}/${owner}/${version}`);
        const key = `contracts/contract/${version ?? "draft"}_contract.pdf`;
        assert.equal((await routes.confirm(key)).status, allowed ? 200 : 403);
      }
      assert.equal(routes.signed.length, routes.updates.length);
    }
  }
});

test("contract confirmation rejects foreign and malformed object keys without updating", async () => {
  const routes = contractRoutes("admin");
  for (const key of ["contracts/other/draft_file.pdf", "contracts/contract/other_file.pdf", "contracts/contract/sealed_../file.pdf", "contracts/contract/draft_", "contracts/contract/draft_file.pdf/extra", "contracts/contract/draft_%2fsealed_file.pdf"]) {
    assert.equal((await routes.confirm(key)).status, 400, key);
  }
  assert.deepEqual(routes.updates, []);
});

test("KNX status rechecks current lead access for progress, completion and failures", async () => {
  const store = load("src/lib/knx-task-store.ts", {}).getStore();
  let assignedTo = "sales-a";
  let profile = { userId: "sales-a", role: "sales" };
  const leadAuth = load("src/lib/lead-auth.ts", {
    "@/lib/auth-profile.mjs": { isActiveProfile: () => true },
    "@/lib/supabase-server": { createServerSupabase: async () => ({
      from: () => ({ select: () => ({ eq: (_field, leadId) => {
        assert.equal(leadId, "lead-a");
        return { single: async () => ({ data: { assigned_to: assignedTo } }) };
      } }) }),
    }) },
  });
  const route = load("src/app/api/hermes/knx-design/status/route.ts", {
    "next/server": { NextResponse },
    "@/lib/knx-task-store": { getStore: () => store },
    "@/lib/lead-auth": { ...leadAuth, getAuthProfile: async () => profile },
  });
  const poll = () => route.GET({ headers: new Headers(), nextUrl: new URL("https://example.test/api?task_id=task") });
  for (const status of ["started", "running", "completed", "failed"]) {
    store.set("task", { lead_id: "lead-a", status, progress_pct: 50, progress_label: "progress", result: { total_aed: 100 } });
    profile = { userId: "sales-a", role: "sales" };
    assignedTo = "sales-a";
    const own = await poll();
    assert.equal(own.status, 200);
    assert.equal(Object.hasOwn(await own.json(), "lead_id"), false);
    assignedTo = "sales-b";
    assert.equal((await poll()).status, 403, "former owner loses access after reassignment");
    profile = { userId: "sales-b", role: "sales" };
    assert.equal((await poll()).status, 200);
    for (const role of ["admin", "boss", "operator"]) {
      profile = { userId: "management", role };
      assert.equal((await poll()).status, 200);
    }
  }
  store.set("task", { status: "running" });
  assert.equal((await poll()).status, 403, "legacy task without lead metadata fails closed");
  store.clear();
  assert.equal((await poll()).status, 404);
});

for (const failPipeline of [false, true]) {
  test(`KNX pipeline retains lead metadata through ${failPipeline ? "failure" : "every progress and completion"}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(globalThis, "fetch", async () => ({ ok: false }));
    t.mock.method(console, "error", () => {});
    const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-only";
    t.after(() => {
      if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
      if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
    });
    const snapshots = [];
    const store = new Map();
    const originalSet = store.set.bind(store);
    store.set = (id, value) => { snapshots.push(value); return originalSet(id, value); };
    let clientCalls = 0;
    const route = load("src/app/api/hermes/knx-design/route.ts", {
      "next/server": { NextResponse },
      "@/lib/knx-task-store": { getStore: () => store },
      "@/lib/lead-auth": { getAuthProfile: async () => ({ userId: "sales", role: "sales" }), canAccessLead: async () => true },
      "@/lib/quotation-engine": { calculateQuotation: () => ({ total: 100, devices_json: { sensor: 2 } }) },
      "@supabase/supabase-js": { createClient: () => {
        if (++clientCalls === 2 && failPipeline) throw new Error("fixture pipeline failure");
        return {
          from: () => ({
            select: () => ({ eq: () => ({
              single: async () => ({ data: { id: "lead-a", devices_json: { sensor: 2 } }, error: null }),
              maybeSingle: async () => ({ data: null }),
            }) }),
            insert: async () => ({ error: null }),
          }),
        };
      } },
    });
    const response = await route.POST(request({ lead_id: "lead-a" }));
    assert.equal(response.status, 200);
    for (const elapsed of [2000, 2000, 1500, 2000]) {
      await flush();
      t.mock.timers.tick(elapsed);
    }
    await flush();
    assert.ok(snapshots.every(snapshot => snapshot.lead_id === "lead-a"));
    assert.deepEqual(snapshots.map(snapshot => snapshot.status), failPipeline
      ? ["started", "failed"]
      : ["started", "running", "running", "running", "running", "completed"]);
    if (!failPipeline) assert.equal(snapshots.at(-1).result.lead_id, "lead-a");
  });
}
