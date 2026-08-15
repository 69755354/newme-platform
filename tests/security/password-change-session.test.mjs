import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadTypeScriptModule(relativePath, mocks) {
  const ts = require("typescript");
  const filename = path.join(root, relativePath);
  const source = readFileSync(filename, "utf8");
  const { outputText } = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const previousLoad = Module._load;
  Module._load = (request, parent, isMain) =>
    Object.hasOwn(mocks, request) ? mocks[request] : previousLoad.call(Module, request, parent, isMain);
  try {
    loaded._compile(outputText, filename);
    return loaded.exports;
  } finally {
    Module._load = previousLoad;
  }
}

function loadPasswordChange(revocationResult) {
  const calls = [];
  const callerClient = {
    auth: {
      getUser: async () => ({ data: { user: { id: "caller-1", email: "caller@example.invalid" } }, error: null }),
      signInWithPassword: async () => ({ data: {}, error: null }),
    },
  };
  const profileQuery = {
    update: (values) => {
      calls.push({ op: "profile", values });
      return { eq: async () => ({ error: null }) };
    },
  };
  const adminClient = {
    auth: {
      admin: {
        updateUserById: async (id) => {
          calls.push({ op: "password", id });
          return { data: {}, error: null };
        },
      },
    },
    from: (table) => {
      assert.equal(table, "profiles");
      return profileQuery;
    },
    rpc: async (name, args) => {
      calls.push({ op: "rpc", name, args });
      return revocationResult;
    },
  };
  const route = loadTypeScriptModule("src/app/api/auth/change-password/route.ts", {
    "next/server": {
      NextResponse: { json: (body, init) => ({ body, status: init?.status ?? 200 }) },
    },
    "@/lib/supabase-server": { createServerSupabase: async () => callerClient },
    "@/lib/supabase-admin": { supabaseAdmin: adminClient },
    "@/lib/logger": { logger: { error() {} } },
  });
  return { post: route.POST, calls };
}

function passwordChangeRequest() {
  return new Request("https://app.newme.ae/api/auth/change-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ oldPassword: "<old-password>", newPassword: "<new-password>" }),
  });
}

// F-07: self-service password change must prove ownership of the CURRENT
// password. This suite previously asserted that the reset route performed the
// self-change itself (`updateUserById(user.id, { password })`) with no old-password
// proof — it pinned the vulnerable implementation as the expected one. The
// assertions below check the security property instead of the source shape.

test("admin reset route uses the shared admin client and never a raw client", () => {
  const route = readFileSync("src/app/api/users/[id]/password/route.ts", "utf8");
  assert.match(route, /import \{ supabaseAdmin \} from "@\/lib\/supabase-admin"/);
  assert.doesNotMatch(route, /createClient\(/);
});

test("reset route refuses to change a password without old-password proof", () => {
  const route = readFileSync("src/app/api/users/[id]/password/route.ts", "utf8");
  const start = route.indexOf('if (targetId === "change-password")');
  assert.notEqual(start, -1, "the change-password guard must still be present");
  const end = route.indexOf('if (!["admin", "boss"].includes(context.role))', start);
  assert.notEqual(end, -1, "the admin authorization boundary must follow the sentinel refusal");
  const selfChange = route.slice(start, end);

  // It must NOT update any password on this path...
  assert.doesNotMatch(selfChange, /updateUserById/);
  assert.doesNotMatch(selfChange, /supabase\.auth\.updateUser/);
  // ...and must reject, pointing at the verifying endpoint.
  assert.match(selfChange, /status:\s*400/);
  assert.match(selfChange, /change-password/);
});

test("the verifying endpoint proves the old password before updating", () => {
  const verifying = readFileSync("src/app/api/auth/change-password/route.ts", "utf8");
  const signInAt = verifying.search(/signInWithPassword/);
  const updateAt = verifying.search(/updateUserById/);
  assert.notEqual(signInAt, -1, "must re-authenticate with the current password");
  assert.notEqual(updateAt, -1, "must then update the password");
  assert.ok(signInAt < updateAt, "verification must happen BEFORE the update");
  assert.match(verifying, /oldPassword/);
});

test("no caller-supplied identity is trusted for a self password change", () => {
  const verifying = readFileSync("src/app/api/auth/change-password/route.ts", "utf8");
  // The subject must come from the authenticated session, never the request body.
  assert.match(verifying, /updateUserById\(\s*\n?\s*user\.id/);
});

test("self password change returns 200 only for a verified session revocation", async () => {
  const { post, calls } = loadPasswordChange({ data: { verified: true }, error: null });
  const response = await post(passwordChangeRequest());

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { success: true, sessionsRevoked: true });
  assert.deepEqual(calls.map((call) => call.op), ["password", "profile", "rpc"]);
  assert.deepEqual(calls.at(-1), {
    op: "rpc",
    name: "revoke_user_sessions",
    args: { p_user_id: "caller-1", p_reason: "self_password_change" },
  });
});

test("self password change reports partial completion when revocation is errored, null, or false", async (t) => {
  const cases = [
    ["RPC error", { data: { verified: true }, error: { message: "rpc failed" } }],
    ["null result", { data: null, error: null }],
    ["verified false", { data: { verified: false }, error: null }],
  ];

  for (const [label, revocation] of cases) {
    await t.test(label, async () => {
      const { post, calls } = loadPasswordChange(revocation);
      const response = await post(passwordChangeRequest());

      assert.equal(response.status, 502);
      assert.equal(response.body.passwordChanged, true);
      assert.equal(response.body.sessionsRevoked, false);
      assert.notEqual(response.body.success, true);
      assert.equal(calls.filter((call) => call.op === "password").length, 1);
      assert.equal(calls.filter((call) => call.op === "rpc").length, 1);
    });
  }
});
