import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { FORCED_SESSION_ERROR } from "../../src/lib/forced-password-change.mjs";

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
//
// R2 changed one thing this file used to assert the other way round: a failed
// profiles update no longer skips the revocation. The password has already been
// replaced by then, so that failure is the case where the target's live sessions
// are most certainly stale — and it was the one case that left them alone. The
// two writes protect different things (the timestamp makes an already-minted
// access token fail the `iat` check; the RPC deletes the refresh token that would
// mint a newer one), so the first failing is a reason to attempt the second. The
// tests below pin the new order, and a mutation re-introduces the old early exit
// to show the difference is real.

const require = createRequire(import.meta.url);
const Module = require("node:module");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const ROUTE = "src/app/api/users/[id]/password/route.ts";
const ACTION = "src/app/actions/team.ts";

// The replacement password these fixtures send. It is written in the placeholder
// shape `<...>` on purpose: scripts/check-published-credentials.mjs reads
// `password = "<some literal>"` as a published credential site, and it is right to
// — it cannot tell a test fixture from a real credential, and the five sites it was
// written for all looked like fixtures too. Nothing here depends on the value.
const NEW_PASSWORD = "<new-password>";

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

function callerProfile(overrides = {}) {
  return {
    id: CALLER,
    role: "admin",
    is_active: true,
    full_name: "An Administrator",
    email: "admin@newme.ae",
    force_password_change: false,
    ...overrides,
  };
}

/**
 * The caller's own RLS client.
 *
 * R1 · resetUserPassword resolves its caller through
 * src/lib/action-auth-context.ts now, which reads the caller's profile with this
 * client instead of with the service key, and checks is_active and
 * force_password_change on the way. So the double answers a profiles select, and
 * the action's caller role arrives here rather than through recordingAdmin.
 */
function serverSupabase({ user = { id: CALLER }, profile = callerProfile() } = {}) {
  const query = {
    select: () => query,
    eq: () => query,
    single: async () => ({ data: profile, error: null }),
  };
  return {
    createServerSupabase: async () => ({
      auth: { getUser: async () => ({ data: { user }, error: null }) },
      from: () => query,
      rpc: async (name) => {
        assert.equal(name, "session_boundary_state");
        const state = profile?.is_active !== true
          ? "inactive"
          : profile?.force_password_change === true ? "password_change_required" : "ok";
        return { data: state, error: null };
      },
    }),
  };
}

function patchRequest(password = NEW_PASSWORD) {
  return { headers: new Headers(), json: async () => ({ password }) };
}

function requestAuthContext(profile) {
  class RequestAuthError extends Error {
    constructor(code) {
      super(code);
      this.name = "RequestAuthError";
      this.code = code;
      this.status = code === FORCED_SESSION_ERROR ? 403 : 401;
    }
  }

  return {
    RequestAuthError,
    getRequestAuthContext: async () => {
      if (profile.is_active !== true) throw new RequestAuthError("inactive_account");
      if (profile.force_password_change === true) throw new RequestAuthError(FORCED_SESSION_ERROR);
      return {
        profile,
        role: profile.role ?? "sales",
        user: { id: profile.id },
        refreshedCookies: [],
      };
    },
    applyRequestAuthCookies: (_context, response) => response,
    requestAuthErrorResponse: (error) => ({ body: { error: error.code }, status: error.status }),
  };
}

async function callRoute(options, mutate = (source) => source) {
  const { client, calls } = recordingAdmin(options);
  const profile = callerProfile({ role: options.callerRole ?? "admin", ...options.callerProfile });
  const response = await withModule(
    ROUTE,
    {
      "next/server": nextServer(),
      "@/lib/supabase-admin": { supabaseAdmin: client },
      "@/lib/request-auth-context": requestAuthContext(profile),
    },
    mutate,
    (route) => route.PATCH(patchRequest(), { params: Promise.resolve({ id: TARGET }) }),
  );
  return { response, calls };
}

async function callAction(options, mutate = (source) => source) {
  const { client, calls } = recordingAdmin(options);
  const profile = callerProfile({ role: options.callerRole ?? "admin", ...options.callerProfile });
  const supabaseServer = serverSupabase({ profile });
  // This file owns reset/revocation ordering, not the shared action-auth
  // implementation (which has its own exhaustive behaviour suite). Keep the
  // reset double deterministic and avoid loading a second transpiled module
  // through a process-wide CommonJS hook.
  const actionAuthContext = {
    getActionAuthContext: async () => {
      const refuse = (code) => {
        const error = new Error(code);
        error.name = "ActionAuthError";
        throw error;
      };
      if (profile.is_active !== true) refuse("inactive_account");
      if (profile.force_password_change === true) refuse(FORCED_SESSION_ERROR);
      return { profile, role: profile.role, user: { id: profile.id } };
    },
  };
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
        "@/lib/supabase-server": supabaseServer,
        "@/lib/action-auth-context": actionAuthContext,
        "@/lib/supabase-admin": { supabaseAdmin: client },
        "@/lib/lead-reassignment.mjs": { resolveActiveLeadReassignmentTarget: async () => null },
        "@supabase/supabase-js": { createClient: () => client },
      },
      mutate,
      (team) =>
        team.resetUserPassword(TARGET, NEW_PASSWORD).then(
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

test("a timestamp that was not recorded still revokes, and still is not a completed reset", async () => {
  // R2 · password_changed_at is the other half of the boundary: without it the
  // restrictive policy has nothing to compare an already-minted token against.
  // Both paths used to stop here, before the revocation ran. The password is
  // already replaced at this point, so stopping left the target's live sessions
  // in place — the outcome this whole file exists to prevent, reached through the
  // one failure nobody tested.
  const failure = { message: "permission denied for table profiles" };

  const { response, calls } = await callRoute({ revocation: verified, profileUpdateError: failure });
  assert.equal(response.status, 500);
  assert.notEqual(response.body?.success, true);
  // The revocation happened, in its usual place, with its usual arguments.
  const rpc = calls.find((call) => call.op === "rpc");
  assert.ok(rpc, "the profile failure skipped the revocation");
  assert.deepEqual(rpc.args, { p_user_id: TARGET, p_reason: "admin_password_reset" });
  assert.deepEqual(
    calls.filter((call) => call.op !== "readCallerRole").map((call) => call.op),
    ["setPassword", "updateProfile", "rpc"],
  );
  // And the administrator is told which half is missing, because the two have
  // different remedies: this one is "reset again", not "the account is exposed".
  assert.match(response.body.error, /sessions were revoked/);
  assert.match(response.body.error, /audit timestamp could not be recorded/);
  assert.doesNotMatch(response.body.error, /still signed in/i);

  const action = await callAction({ revocation: verified, profileUpdateError: failure });
  assert.equal(action.result.value, undefined);
  assert.ok(action.calls.some((call) => call.op === "rpc"), "the action skipped the revocation");
  assert.match(action.result.error.message, /existing sessions were revoked/);
  assert.match(action.result.error.message, /timestamp could not be recorded/);
  assert.doesNotMatch(action.result.error.message, /still signed in/i);
});

test("when both halves fail, the caller is told about the sessions first", async () => {
  // The two failures are not equally dangerous and must not be reported as one
  // message. An unrecorded timestamp with the sessions gone leaves nothing to
  // sign in with; a recorded timestamp with the sessions intact leaves a refresh
  // token that mints tokens whose `iat` passes the check. So when both fail, the
  // sessions win the message.
  const failure = { message: "permission denied for table profiles" };

  const { response } = await callRoute({ revocation: unverified, profileUpdateError: failure });
  assert.equal(response.status, 502);
  assert.match(response.body.error, /could not be verifiably revoked/);
  assert.match(response.body.error, /still signed in/i);

  const action = await callAction({ revocation: unverified, profileUpdateError: failure });
  assert.equal(action.result.value, undefined);
  assert.match(action.result.error.message, /could not be verifiably revoked/);
});

test("R1 · both reset paths refuse a forced or revoked caller before resetting anything", async () => {
  // resetUserPassword is an administrator action that hands out a new password.
  // A caller whose own credential the operator has already decided must be
  // replaced, or whose account has been deactivated, must not be the one doing
  // that — and before R1 neither state was checked here at all.
  for (const [label, overrides] of [
    ["forced", { force_password_change: true }],
    ["revoked", { is_active: false }],
  ]) {
    const route = await callRoute({ revocation: verified, callerProfile: overrides });
    assert.equal(route.response.status, label === "forced" ? 403 : 401, `${label} route status`);
    assert.deepEqual(route.calls, [], `${label} caller reached the route's service-role client`);

    const { result, calls } = await callAction({ revocation: verified, callerProfile: overrides });
    assert.equal(result.value, undefined, `${label} caller completed a reset`);
    assert.equal(result.error.name, "ActionAuthError", `${label} caller: ${result.error.message}`);
    assert.deepEqual(calls, [], `${label} caller reached the service-role client`);
  }
});

test("a caller who is neither admin nor boss never reaches the reset at all", async () => {
  const { response, calls } = await callRoute({ revocation: verified, callerRole: "sales" });
  assert.equal(response.status, 403);
  assert.deepEqual(calls, []);

  const action = await callAction({ revocation: verified, callerRole: "sales" });
  assert.match(action.result.error.message, /Forbidden/);
  assert.equal(action.calls.some((call) => call.op === "setPassword"), false);
});

// ---------------------------------------------------------------------------
// Coupling: only the two administrator reset paths and the authenticated
// self-change path call the RPC, and the RPC remains server-only.
// ---------------------------------------------------------------------------

test("revoke_user_sessions is called from exactly the intended password-change paths", () => {
  const sources = fs
    .readdirSync(path.join(root, "src"), { recursive: true, encoding: "utf8" })
    .filter((entry) => /\.(ts|tsx|mts|mjs)$/.test(entry))
    .filter((entry) => fs.readFileSync(path.join(root, "src", entry), "utf8").includes("revoke_user_sessions"));

  assert.deepEqual(
    sources.map((entry) => entry.split(path.sep).join("/")).sort(),
    [
      "app/actions/team.ts",
      "app/api/auth/change-password/route.ts",
      "app/api/users/[id]/password/route.ts",
      // The typed signature the callers share; a caller inventing different
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
    const end = source.indexOf("return respond({ success: true });", start);
    assert.notEqual(end, -1);
    return source.slice(0, start) + source.slice(end);
  };
  const mutant = await callRoute({ revocation: unverified }, withoutRouteGuard);
  assert.deepEqual(mutant.response, { body: { success: true }, status: 200 });

  // The action's guard: without it, the same failure resolves instead of throwing.
  const withoutActionGuard = (source) => {
    const start = source.indexOf("if (!sessionsRevoked) {");
    assert.notEqual(start, -1, "the action's fail-closed guard must still be present");
    const end = source.indexOf("if (profileError) {", start);
    assert.notEqual(end, -1, "the action's profile-failure report must still be present");
    return source.slice(0, start) + source.slice(end);
  };
  const actionMutant = await callAction({ revocation: unverified }, withoutActionGuard);
  assert.deepEqual(actionMutant.result, { value: { success: true } });
});

test("re-introducing the pre-R2 early exit is what stops the revocation", async () => {
  // The R2 fix is an ordering, and an ordering is invisible unless the other
  // order is exercised. These two mutations are the code as it was: report the
  // profile failure the moment it is seen, before the revocation. Both then leave
  // a target whose password an administrator has just replaced still signed in —
  // which is what the tests above would otherwise only be asserting by shape.
  const failure = { message: "permission denied for table profiles" };

  const routeEarlyExit = (source) => {
    const anchor = "    // R2 · a failed timestamp write does not skip the revocation.";
    assert.ok(source.includes(anchor), "the route's R2 note must still mark the ordering");
    return source.replace(
      anchor,
      '    if (profileErr) return NextResponse.json({ error: "pre-R2 early exit" }, { status: 500 });\n' + anchor,
    );
  };
  const route = await callRoute({ revocation: verified, profileUpdateError: failure }, routeEarlyExit);
  assert.equal(route.response.status, 500);
  assert.equal(route.response.body.error, "pre-R2 early exit");
  assert.equal(route.calls.some((call) => call.op === "rpc"), false, "the mutation did not remove the revocation");

  const actionEarlyExit = (source) => {
    const anchor = "  // R2 · the timestamp failing does not make the revocation optional.";
    assert.ok(source.includes(anchor), "the action's R2 note must still mark the ordering");
    return source.replace(
      anchor,
      "  if (profileError) throw new Error('pre-R2 early exit')\n" + anchor,
    );
  };
  const action = await callAction({ revocation: verified, profileUpdateError: failure }, actionEarlyExit);
  assert.equal(action.result.error.message, "pre-R2 early exit");
  assert.equal(action.calls.some((call) => call.op === "rpc"), false, "the mutation did not remove the revocation");
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
