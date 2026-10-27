import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Round-4 A0 · the two development bootstrap routes must refuse rather than fall
// back to a credential that is published in this repository's git history.
//
//   src/app/api/dev/setup/route.ts        POST — creates the identity
//   src/app/api/auth/dev-login/route.ts   POST — signs in as it
//
// The resolver tests are pure. The route tests load the real transpiled modules
// against a recording double and assert what reached Supabase, because "the
// literal is gone from the source" is a property of a diff and "an unconfigured
// environment cannot mint an admin" is a property of the running code.
//
// scripts/check-published-credentials.mjs is the other half: it fails the build
// if a credential is published anywhere in the tree again, and
// tests/security/published-credentials.test.mjs shows it rejects each shape that
// really was here.
import { auditSource } from "../../scripts/check-published-credentials.mjs";
import {
  DEV_IDENTITY_MIN_PASSWORD_LENGTH,
  DEV_IDENTITY_OPT_IN,
  DEV_IDENTITY_REFUSALS,
  resolveDevIdentity,
} from "../../src/lib/dev-identity.mjs";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const SETUP = "src/app/api/dev/setup/route.ts";
const LOGIN = "src/app/api/auth/dev-login/route.ts";

const EMAIL = "bootstrap@example.test";
const PASSWORD = "a-configured-password-long-enough";

/** A fully configured non-production environment. */
const configured = (overrides = {}) => ({
  NODE_ENV: "development",
  [DEV_IDENTITY_OPT_IN]: "true",
  DEV_EMAIL: EMAIL,
  DEV_PASSWORD: PASSWORD,
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-only-placeholder",
  SUPABASE_SERVICE_ROLE_KEY: "test-only-placeholder",
  ...overrides,
});

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

test("a fully configured non-production environment resolves", () => {
  const resolved = resolveDevIdentity(configured());
  assert.deepEqual(resolved, { ok: true, email: EMAIL, password: PASSWORD });
});

test("every way of being unconfigured refuses, and says which without saying what", () => {
  const cases = [
    [{ NODE_ENV: "production" }, DEV_IDENTITY_REFUSALS.PRODUCTION, 403],
    [{ [DEV_IDENTITY_OPT_IN]: undefined }, DEV_IDENTITY_REFUSALS.NOT_OPTED_IN, 403],
    [{ [DEV_IDENTITY_OPT_IN]: "1" }, DEV_IDENTITY_REFUSALS.NOT_OPTED_IN, 403],
    [{ [DEV_IDENTITY_OPT_IN]: "TRUE" }, DEV_IDENTITY_REFUSALS.NOT_OPTED_IN, 403],
    [{ DEV_EMAIL: undefined }, DEV_IDENTITY_REFUSALS.UNCONFIGURED, 503],
    [{ DEV_EMAIL: "   " }, DEV_IDENTITY_REFUSALS.UNCONFIGURED, 503],
    [{ DEV_PASSWORD: undefined }, DEV_IDENTITY_REFUSALS.UNCONFIGURED, 503],
    [{ DEV_PASSWORD: "" }, DEV_IDENTITY_REFUSALS.UNCONFIGURED, 503],
    [{ DEV_EMAIL: "not-an-address" }, DEV_IDENTITY_REFUSALS.EMAIL_NOT_AN_ADDRESS, 503],
    [{ DEV_PASSWORD: "x".repeat(DEV_IDENTITY_MIN_PASSWORD_LENGTH - 1) }, DEV_IDENTITY_REFUSALS.PASSWORD_TOO_SHORT, 503],
  ];

  for (const [overrides, reason, status] of cases) {
    const resolved = resolveDevIdentity(configured(overrides));
    assert.deepEqual(resolved, { ok: false, reason, status }, JSON.stringify(Object.keys(overrides)));
    // A refusal is a code. If it carried the value, every CI log that printed it
    // would republish the credential this item exists to remove.
    const env = configured(overrides);
    for (const name of ["DEV_PASSWORD", "DEV_EMAIL"]) {
      const value = env[name];
      if (typeof value === "string" && value.trim() !== "") {
        assert.equal(resolved.reason.includes(value.trim()), false, `${name} leaked into the refusal`);
      }
    }
  }
});

test("production is refused even when everything else is configured to allow it", () => {
  // Order matters: an operator who set the opt-in on a production box must not
  // get a bootstrap route because the rest of the environment looks right.
  const resolved = resolveDevIdentity(configured({ NODE_ENV: "production" }));
  assert.equal(resolved.reason, DEV_IDENTITY_REFUSALS.PRODUCTION);
});

test("the opt-in is server-only, and nothing gates on the build-time flag any more", () => {
  // NEXT_PUBLIC_* is inlined into the client bundle at build time, so it is
  // neither a secret nor a runtime decision. /api/dev/setup used to gate on
  // NEXT_PUBLIC_DEV_MODE, which made its guard a build artefact.
  //
  // The pattern is `process.env.NEXT_PUBLIC_DEV_MODE`, i.e. a read: the resolver
  // and both routes name the old flag in a comment on purpose, and a test that
  // forbade the name would forbid explaining what was fixed.
  assert.equal(DEV_IDENTITY_OPT_IN.startsWith("NEXT_PUBLIC_"), false);
  for (const file of ["src/lib/dev-identity.mjs", SETUP, LOGIN]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(source, /process\.env\.NEXT_PUBLIC_DEV_MODE/, file);
    assert.doesNotMatch(source, /env\[["']NEXT_PUBLIC_DEV_MODE["']\]/, file);
  }
});

test("the minimum length excludes a credential of the shape that was published", () => {
  // The published values were 6, 9 and 10 characters. Nothing here records what
  // they were; the assertion is that none of those lengths can be configured.
  for (const length of [6, 9, 10]) {
    const resolved = resolveDevIdentity(configured({ DEV_PASSWORD: "x".repeat(length) }));
    assert.equal(resolved.ok, false, `${length} characters was accepted`);
  }
});

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

/**
 * Load one route with its imports replaced and `process.env` set, and invoke it
 * while both are still in place.
 *
 * The callback is not named `use`: eslint's react-hooks rules read any `use(...)`
 * call as a React hook and reject it inside a try block.
 */
async function withRoute(relativePath, { env, mocks }, invoke) {
  const ts = require("typescript");
  const filename = path.join(root, relativePath);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });

  const loaded = new Module(filename);
  const previousLoad = Module._load;
  const previousEnv = process.env;
  Module._load = (request, parent, isMain) => {
    if (Object.hasOwn(mocks, request)) return mocks[request];
    if (request.startsWith("@/")) {
      return previousLoad.call(Module, path.join(root, "src", request.slice(2)), parent, isMain);
    }
    return previousLoad.call(Module, request, parent, isMain);
  };
  process.env = env;
  try {
    loaded._compile(outputText, filename);
    return await invoke(loaded.exports);
  } finally {
    Module._load = previousLoad;
    process.env = previousEnv;
  }
}

const nextServer = () => ({
  NextResponse: { json: (body, init) => ({ body, status: init?.status ?? 200 }) },
});

/** A Supabase double that records every admin call and every credential it is given. */
function recordingSupabase({ existingUser = null, signInSucceeds = true } = {}) {
  const calls = [];
  const client = {
    auth: {
      admin: {
        listUsers: async () => {
          calls.push({ op: "listUsers" });
          return { data: { users: existingUser ? [existingUser] : [] }, error: null };
        },
        createUser: async (attributes) => {
          calls.push({ op: "createUser", email: attributes.email, password: attributes.password });
          return { data: { user: { id: "created" } }, error: null };
        },
        updateUserById: async (id, attributes) => {
          calls.push({ op: "updateUserById", id, keys: Object.keys(attributes) });
          return { data: { user: { id } }, error: null };
        },
      },
      signInWithPassword: async (credentials) => {
        calls.push({ op: "signInWithPassword", email: credentials.email, password: credentials.password });
        return signInSucceeds
          ? { data: { session: { user: { id: "signed-in", email: credentials.email } } }, error: null }
          : { data: { session: null }, error: { message: "invalid" } };
      },
    },
    from(table) {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => {
          calls.push({ op: "readProfile", table });
          return { data: { id: "created", role: "admin" }, error: null };
        } }) }),
        insert: async (values) => {
          calls.push({ op: "insertProfile", table, role: values.role });
          return { error: null };
        },
        update: () => ({ eq: async () => ({ error: null }) }),
      };
    },
  };
  return { client, calls };
}

const callSetup = (env, options) => {
  const { client, calls } = recordingSupabase(options);
  return withRoute(
    SETUP,
    { env, mocks: { "next/server": nextServer(), "@supabase/supabase-js": { createClient: () => client } } },
    (route) => route.POST(),
  ).then((response) => ({ response, calls }));
};

const callLogin = (env, options) => {
  const { client, calls } = recordingSupabase(options);
  return withRoute(
    LOGIN,
    { env, mocks: { "next/server": nextServer(), "@supabase/supabase-js": { createClient: () => client } } },
    (route) => route.POST(),
  ).then((response) => ({ response, calls }));
};

test("neither bootstrap route touches Supabase when the identity is not configured", async () => {
  for (const call of [callSetup, callLogin]) {
    for (const overrides of [
      { [DEV_IDENTITY_OPT_IN]: undefined },
      { DEV_PASSWORD: undefined },
      { DEV_EMAIL: undefined },
      { NODE_ENV: "production" },
      { DEV_PASSWORD: "short" },
    ]) {
      const { response, calls } = await call(configured(overrides));
      assert.ok(response.status === 403 || response.status === 503, `status ${response.status}`);
      assert.equal(response.body.ok, undefined);
      // The refusal is the point: nothing was created, nothing was signed in.
      assert.deepEqual(calls, [], `${JSON.stringify(Object.keys(overrides))} still called Supabase`);
      assert.ok(Object.values(DEV_IDENTITY_REFUSALS).includes(response.body.error), response.body.error);
    }
  }
});

test("a configured setup creates the identity with the configured credential only", async () => {
  const { response, calls } = await callSetup(configured());
  assert.deepEqual(response, { body: { ok: true }, status: 200 });

  const created = calls.find((entry) => entry.op === "createUser");
  assert.equal(created.email, EMAIL);
  assert.equal(created.password, PASSWORD);
  // Whatever is created is the configured identity, not a remembered one.
  assert.equal(calls.some((entry) => entry.email && entry.email !== EMAIL), false);
});

test("setup does not reset the credential of an identity that already exists", async () => {
  // A bootstrap endpoint that re-applies a password is a password-reset endpoint
  // with no authorisation check.
  const existing = { id: "existing", email: EMAIL, email_confirmed_at: null };
  const { response, calls } = await callSetup(configured(), { existingUser: existing });
  assert.equal(response.status, 200);
  assert.equal(calls.some((entry) => entry.op === "createUser"), false);
  const updated = calls.find((entry) => entry.op === "updateUserById");
  assert.deepEqual(updated.keys, ["email_confirm"], "the update must not carry a password");
});

test("a configured login signs in with the configured credential", async () => {
  const { response, calls } = await callLogin(configured());
  assert.equal(response.status, 200);
  assert.equal(response.body.email, EMAIL);
  const signIn = calls.find((entry) => entry.op === "signInWithPassword");
  assert.equal(signIn.email, EMAIL);
  assert.equal(signIn.password, PASSWORD);
});

test("a missing Supabase configuration is a refusal, not a thrown assertion", async () => {
  // Both routes used to assert their configuration with `!`, so a missing key
  // threw a stack trace out of a public endpoint.
  const setup = await callSetup(configured({ SUPABASE_SERVICE_ROLE_KEY: undefined }));
  assert.equal(setup.response.status, 503);
  assert.deepEqual(setup.calls, []);

  const login = await callLogin(configured({ NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined }));
  assert.equal(login.response.status, 503);
  assert.deepEqual(login.calls, []);
});

// ---------------------------------------------------------------------------
// Coupling
// ---------------------------------------------------------------------------

test("the routes have no credential of their own left", () => {
  // Judged by the gate rather than by a second set of regexes here: it is the
  // tested one (tests/security/published-credentials.test.mjs), and the routes
  // quote the removed `process.env.DEV_PASSWORD || "<literal>"` shape in a
  // comment — which the gate correctly reads as a placeholder, and which a
  // hand-rolled pattern in this file read as a finding.
  for (const route of [SETUP, LOGIN, "src/lib/dev-identity.mjs"]) {
    const source = fs.readFileSync(path.join(root, route), "utf8");
    assert.deepEqual(auditSource(source), [], route);
  }

  // And both routes resolve through the one place that decides.
  for (const route of [SETUP, LOGIN]) {
    assert.match(fs.readFileSync(path.join(root, route), "utf8"), /resolveDevIdentity\(\)/, route);
  }
});

test("the gate would have caught the shape that was removed from these routes", () => {
  // The negative half: auditSource() reporting nothing above has to mean the
  // routes are clean, not that the rule stopped working.
  const before = 'const DEV_PASSWORD = process.env.DEV_PASSWORD || "not-a-real-value";';
  assert.deepEqual(
    auditSource(before).map((finding) => finding.rule),
    ["defaulted-credential"],
  );
});

test("resolveDevIdentity has exactly these two callers", () => {
  const callers = fs
    .readdirSync(path.join(root, "src"), { recursive: true, encoding: "utf8" })
    .filter((entry) => /\.(ts|tsx|mts|mjs)$/.test(entry))
    .filter((entry) => fs.readFileSync(path.join(root, "src", entry), "utf8").includes("resolveDevIdentity"))
    .map((entry) => entry.split(path.sep).join("/"))
    .sort();

  assert.deepEqual(callers, [
    "app/api/auth/dev-login/route.ts",
    "app/api/dev/setup/route.ts",
    "lib/dev-identity.d.mts",
    "lib/dev-identity.mjs",
  ]);
});
