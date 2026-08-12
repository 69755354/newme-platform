import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// A3 · an administrator password reset must end with the target's existing
// sessions verifiably gone, and must not report success otherwise.
//
// Both administrator reset paths are covered:
//   src/app/api/users/[id]/password/route.ts  PATCH
//   src/app/actions/team.ts                   resetUserPassword
//
// These run the real transpiled modules against a recording double, so they
// assert behaviour (what is called, in what order, and what the caller is told)
// rather than source shape. The last test in the file is the reason to believe
// the others: it re-loads each module with one guard deleted from its source and
// shows the outcome flip, so no assertion here can pass vacuously.
//
// The database half of this boundary — that revoke_user_sessions() actually
// clears auth.sessions/auth.refresh_tokens, verifies the absence afterwards,
// refuses an end-user identity, and is executable by service_role only — is
// measured by the seventeen a3-* assertions in
// supabase/replay/10_assert_release_contracts.sql, each one shown to fail against
// the floor. GoTrue's own behaviour is measured by
// scripts/gotrue-revocation-drill.sh.

const require = createRequire(import.meta.url);
const Module = require("node:module");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const ROUTE = "src/app/api/users/[id]/password/route.ts";
const ACTION = "src/app/actions/team.ts";

/**
 * Load one TypeScript module with its imports replaced by doubles, and run
 * `invoke` against it while those doubles are still installed.
 *
 * The callback is not named `use`: eslint's react-hooks rules read any
 * `use(...)` call as a React hook and reject it inside a try block.
 *
 * The second half matters: `resetUserPassword` reaches @supabase/supabase-js
 * through a dynamic import, which resolves after the module body has finished,
 * so a hook that is torn down at the end of loading is a hook that is gone by
 * the time the code under test actually needs it.
 *
 * `mutate` rewrites the source before it is compiled; the mutation tests at the
 * bottom use it to remove a single guard.
 */
async function withModule(relativePath, mocks, mutate, invoke) {
  const ts = require("typescript");
  const filename = path.join(root, relativePath);
  const source = mutate(fs.readFileSync(filename, "utf8"));
  const { outputText } = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const loaded = new Module(filename);
  const previousLoad = Module._load;
  Module._load = (request, parent, isMain) => {
    if (Object.hasOwn(mocks, request)) return mocks[request];
    if (request.startsWith("@/")) {
      return previousLoad.call(Module, path.join(root, "src", request.slice(2)), parent, isMain);
    }
    return previousLoad.call(Module, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, filename);
    return await invoke(loaded.exports);
  } finally {
    Module._load = previousLoad;
  }
}

const CALLER = "aaaaaaaa-0000-0000-0000-000000000001";
const TARGET = "bbbbbbbb-0000-0000-0000-000000000002";

/**
 * A service-key client double that records every call in order.
 *
 * `revocation` decides what the RPC answers, which is the only knob the failure
 * cases need: everything else succeeds, so a non-200 can only come from the
 * revocation being unverified.
 */
function recordingAdmin({ revocation, profileUpdateError = null, callerRole = "admin" }) {
  const calls = [];
  const client = {
    auth: {
      admin: {
        updateUserById: async (id, attributes) => {
          calls.push({ op: "setPassword", id, keys: Object.keys(attributes) });
          return { data: { user: { id } }, error: null };
        },
      },
    },
    from(table) {
      return {
        select: () => ({
          eq: () => ({
            single: async () => {
              calls.push({ op: "readCallerRole", table });
              return { data: { id: CALLER, role: callerRole }, error: null };
            },
          }),
        }),
        update(values) {
          calls.push({ op: "updateProfile", table, values });
          return { eq: async () => ({ error: profileUpdateError }) };
        },
      };
    },
    rpc: async (name, args) => {
      calls.push({ op: "rpc", name, args });
      return revocation(name, args);
    },
  };
  return { client, calls };
}

const verified = () => ({ data: { user_id: TARGET, verified: true, sessions_deleted: 2 }, error: null });
const unverified = () => ({ data: { user_id: TARGET, verified: false }, error: null });
const rpcMissing = () => ({ data: null, error: { message: "function public.revoke_user_sessions does not exist" } });

function nextServer() {
  return {
    NextResponse: {
      json: (body, init) => ({ body, status: init?.status ?? 200 }),
    },
  };
}

function serverSupabase(user = { id: CALLER }) {
  return { createServerSupabase: async () => ({ auth: { getUser: async () => ({ data: { user }, error: null }) } }) };
}

function patchRequest(password = "a-new-password") {
  return { headers: new Headers(), json: async () => ({ password }) };
}

async function callRoute(options, mutate = (source) => source) {
  const { client, calls } = recordingAdmin(options);
  const response = await withModule(
    ROUTE,
    {
      "next/server": nextServer(),
      "@/lib/supabase-server": serverSupabase(),
      "@/lib/supabase-admin": { supabaseAdmin: client },
    },
    mutate,
    (route) => route.PATCH(patchRequest(), { params: Promise.resolve({ id: TARGET }) }),
  );
  return { response, calls };
}

async function callAction(options, mutate = (source) => source) {
  const { client, calls } = recordingAdmin(options);
  const previous = {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-placeholder";
  try {
    const result = await withModule(
      ACTION,
      {
        "@/lib/supabase-server": serverSupabase(),
        "@/lib/supabase-admin": { supabaseAdmin: client },
        "@/lib/lead-reassignment.mjs": { resolveActiveLeadReassignmentTarget: async () => null },
        "@supabase/supabase-js": { createClient: () => client },
      },
      mutate,
      (team) =>
        team.resetUserPassword(TARGET, "a-new-password").then(
          (value) => ({ value }),
          (error) => ({ error }),
        ),
    );
    return { result, calls };
  } finally {
    for (const [name, value] of [
      ["NEXT_PUBLIC_SUPABASE_URL", previous.url],
      ["SUPABASE_SERVICE_ROLE_KEY", previous.key],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Positive: what a completed reset does, and in which order.
// ---------------------------------------------------------------------------

test("the reset route revokes the target's sessions and only then reports success", async () => {
  const { response, calls } = await callRoute({ revocation: verified });

  assert.deepEqual(response, { body: { success: true }, status: 200 });

  const order = calls.filter((call) => call.op !== "readCallerRole").map((call) => call.op);
  // The password first, then the timestamp the database policy compares an
  // access token's `iat` against, then the revocation that stops a pre-reset
  // refresh token from minting a token whose `iat` is newer than it.
  assert.deepEqual(order, ["setPassword", "updateProfile", "rpc"]);

  const profile = calls.find((call) => call.op === "updateProfile");
  assert.equal(profile.table, "profiles");
  assert.equal(typeof profile.values.password_changed_at, "string");
  assert.ok(Number.isFinite(Date.parse(profile.values.password_changed_at)));
  assert.equal(profile.values.force_password_change, true);

  const rpc = calls.find((call) => call.op === "rpc");
  assert.equal(rpc.name, "revoke_user_sessions");
  assert.deepEqual(rpc.args, { p_user_id: TARGET, p_reason: "admin_password_reset" });
});

test("the reset server action revokes the target's sessions and only then reports success", async () => {
  const { result, calls } = await callAction({ revocation: verified });

  assert.deepEqual(result, { value: { success: true } });

  const order = calls.filter((call) => call.op !== "readCallerRole").map((call) => call.op);
  assert.deepEqual(order, ["setPassword", "updateProfile", "rpc"]);

  const profile = calls.find((call) => call.op === "updateProfile");
  assert.equal(profile.values.force_password_change, true);
  assert.ok(Number.isFinite(Date.parse(profile.values.password_changed_at)));

  const rpc = calls.find((call) => call.op === "rpc");
  assert.equal(rpc.name, "revoke_user_sessions");
  assert.deepEqual(rpc.args, { p_user_id: TARGET, p_reason: "admin_password_reset" });
});

// ---------------------------------------------------------------------------
// Negative: every way the revocation can fail to happen must fail the reset.
// ---------------------------------------------------------------------------

test("an unverified revocation is not a completed reset", async () => {
  const { response } = await callRoute({ revocation: unverified });
  assert.equal(response.status, 502);
  assert.notEqual(response.body?.success, true);
  assert.match(response.body.error, /could not be verifiably revoked/);
  // The administrator has to be told the account is still reachable, otherwise
  // a 502 reads as "retry later" rather than "this identity is not secured yet".
  assert.match(response.body.error, /still signed in/i);
});

test("an RPC that is not installed or not permitted is not a completed reset", async () => {
  const { response } = await callRoute({ revocation: rpcMissing });
  assert.equal(response.status, 502);
  assert.notEqual(response.body?.success, true);
});

test("a revocation that answers nothing at all is not a completed reset", async () => {
  const { response } = await callRoute({ revocation: () => ({ data: null, error: null }) });
  assert.equal(response.status, 502);
  assert.notEqual(response.body?.success, true);
});

test("a revocation whose answer is not the documented shape is not a completed reset", async () => {
  // A future signature change, or a stray migration returning void, must not be
  // read as consent: only `verified: true` is.
  const { response } = await callRoute({ revocation: () => ({ data: { ok: "yes" }, error: null }) });
  assert.equal(response.status, 502);
  assert.notEqual(response.body?.success, true);
});

test("a failed revocation makes the server action throw rather than return success", async () => {
  for (const revocation of [unverified, rpcMissing, () => ({ data: null, error: null })]) {
    const { result } = await callAction({ revocation });
    assert.equal(result.value, undefined);
    assert.match(result.error.message, /could not be verifiably revoked/);
  }
});

test("a timestamp that was not recorded stops the reset before it can be reported as done", async () => {
  // password_changed_at is the other half of the boundary: without it the
  // restrictive policy has nothing to compare an already-minted token against.
  const { response, calls } = await callRoute({
    revocation: verified,
    profileUpdateError: { message: "permission denied for table profiles" },
  });
  assert.equal(response.status, 500);
  assert.notEqual(response.body?.success, true);
  assert.equal(calls.some((call) => call.op === "rpc"), false);

  const action = await callAction({
    revocation: verified,
    profileUpdateError: { message: "permission denied for table profiles" },
  });
  assert.equal(action.result.value, undefined);
  assert.match(action.result.error.message, /still signed in/i);
});

test("a caller who is neither admin nor boss never reaches the reset at all", async () => {
  const { response, calls } = await callRoute({ revocation: verified, callerRole: "sales" });
  assert.equal(response.status, 403);
  assert.deepEqual(calls.map((call) => call.op), ["readCallerRole"]);

  const action = await callAction({ revocation: verified, callerRole: "sales" });
  assert.match(action.result.error.message, /Forbidden/);
  assert.equal(action.calls.some((call) => call.op === "setPassword"), false);
});

// ---------------------------------------------------------------------------
// Coupling: these two are the only callers, and the RPC is server-only.
// ---------------------------------------------------------------------------

test("revoke_user_sessions is called from exactly the two administrator reset paths", () => {
  const sources = fs
    .readdirSync(path.join(root, "src"), { recursive: true, encoding: "utf8" })
    .filter((entry) => /\.(ts|tsx|mts|mjs)$/.test(entry))
    .filter((entry) => fs.readFileSync(path.join(root, "src", entry), "utf8").includes("revoke_user_sessions"));

  assert.deepEqual(
    sources.map((entry) => entry.split(path.sep).join("/")).sort(),
    [
      "app/actions/team.ts",
      "app/api/users/[id]/password/route.ts",
      // The typed signature the two callers share; a caller inventing different
      // argument names is a compile error rather than a silent no-op.
      "types/database.ts",
    ],
  );
});

test("the migration that owns the RPC keeps it away from end-user roles", () => {
  const migration = fs.readFileSync(
    path.join(root, "supabase/migrations/20260817120000_admin_reset_session_revocation.sql"),
    "utf8",
  );
  assert.match(migration, /revoke all on function public\.revoke_user_sessions\(uuid, text\)\s+from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.revoke_user_sessions\(uuid, text\) to service_role/);
});

// ---------------------------------------------------------------------------
// Mutation: each guard above is load-bearing.
// ---------------------------------------------------------------------------

test("deleting the fail-closed guard flips each reset path back to reporting success", async () => {
  // The route's guard: without it, an unverified revocation returns 200.
  const withoutRouteGuard = (source) => {
    const start = source.indexOf("if (revokeError ||");
    assert.notEqual(start, -1, "the route's fail-closed guard must still be present");
    const end = source.indexOf("return NextResponse.json({ success: true });", start);
    assert.notEqual(end, -1);
    return source.slice(0, start) + source.slice(end);
  };
  const mutant = await callRoute({ revocation: unverified }, withoutRouteGuard);
  assert.deepEqual(mutant.response, { body: { success: true }, status: 200 });

  // The action's guard: without it, the same failure resolves instead of throwing.
  const withoutActionGuard = (source) => {
    const start = source.indexOf("if (revokeError ||");
    assert.notEqual(start, -1, "the action's fail-closed guard must still be present");
    const end = source.indexOf("return { success: true }", start);
    assert.notEqual(end, -1);
    return source.slice(0, start) + source.slice(end);
  };
  const actionMutant = await callAction({ revocation: unverified }, withoutActionGuard);
  assert.deepEqual(actionMutant.result, { value: { success: true } });
});

test("deleting the revocation call itself is what the positive tests would otherwise miss", async () => {
  // Removing the RPC call makes `revocation` undefined, so the guard rejects —
  // which is the point: there is no arrangement of this route where a reset is
  // reported without a verified revocation having been observed.
  const withoutRpc = (source) =>
    source.replace(
      /const \{ data: revocation, error: revokeError \} = await supabaseAdmin\.rpc\([\s\S]*?\}\);/,
      "const revocation = null; const revokeError = null;",
    );
  const { response, calls } = await callRoute({ revocation: verified }, withoutRpc);
  assert.equal(calls.some((call) => call.op === "rpc"), false);
  assert.equal(response.status, 502);
});
