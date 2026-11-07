// OS fix S1 · version skew after a release (review 3-code-quality E1/F1, 0-总报告 #1).
//
// After a deploy, an open tab still runs the previous bundle. Without a release
// identifier Next.js cannot tell, so the stale bundle keeps calling server
// actions whose ids no longer exist ("Server Reference ID did not match",
// "Expected RSC response, got text/plain"), and the "who am I" hooks turned that
// into a push to /login or an empty, unprivileged page.
//
// These tests pin the three parts of the fix:
//   1. one stable id per release (next.config.ts deploymentId from the release
//      SHA that scripts/deploy-immutable.sh already passes to the build);
//   2. a client whose release no longer matches the server's reloads exactly
//      once and never loops, and never goes to /login for that reason;
//   3. the on-load identity lookup is a route handler (GET /api/auth/me), not a
//      server action, so it keeps its URL across releases.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const skewModule = await import("../../src/lib/deployment-skew.mjs");

function load(relative, mocks = {}, cache = new Map()) {
  const ts = require("typescript");
  const filename = path.join(ROOT, relative);
  if (cache.has(filename)) return cache.get(filename);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const previousLoad = Module._load;
  Module._load = (request, parent, isMain) => {
    if (Object.hasOwn(mocks, request)) return mocks[request];
    if (request.startsWith("@/")) {
      // A TypeScript module under the alias is transpiled the same way; it is
      // part of the behaviour under test, not a dependency to stub.
      const target = path.join("src", request.slice(2));
      if (fs.existsSync(path.join(ROOT, `${target}.ts`))) return load(`${target}.ts`, mocks, cache);
      return previousLoad.call(Module, path.join(ROOT, target), parent, isMain);
    }
    return previousLoad.call(Module, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, filename);
    cache.set(filename, loaded.exports);
    return loaded.exports;
  } finally {
    Module._load = previousLoad;
  }
}

function fakeStorage() {
  const map = new Map();
  return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)) };
}

function withEnv(t, key, value) {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

// ---------------------------------------------------------------------------
// 1. One stable identifier per release
// ---------------------------------------------------------------------------

test("the build carries one deployment id per release, taken from the release SHA", () => {
  const config = read("next.config.ts");
  assert.match(config, /const releaseId = process\.env\.NEXT_DEPLOYMENT_ID \|\| gitHash/);
  assert.match(config, /^\s*deploymentId: releaseId,/m, "deploymentId must be set so Next.js detects skew on navigation");
  // deploymentId makes BUILD_ID constant unless generateBuildId is set, and the
  // release pipeline compares BUILD_ID between releases.
  assert.match(config, /generateBuildId: async \(\) => releaseId/);
  assert.match(config, /NEXT_PUBLIC_DEPLOYMENT_ID: releaseId/, "the client bundle must know its own release");

  const deploy = read("scripts/deploy-immutable.sh");
  assert.match(deploy, /NEXT_DEPLOYMENT_ID="\$SHA"[^\n]*\n\s*NODE_OPTIONS=[^\n]*npm run build/,
    "deploy-immutable.sh must pass the release SHA as NEXT_DEPLOYMENT_ID to the build");
});

test("the prerender cache never writes into the read-only release directory", () => {
  // Review 3-code-quality E2: /opt/newme/releases/<sha> is root-owned 0550 and
  // mounted read-only; the file-system cache's seed promotion and every
  // revalidatePath() then logs "Failed to update prerender cache ... ENOENT".
  const config = read("next.config.ts");
  assert.match(config, /isrFlushToDisk: false/);
});

// ---------------------------------------------------------------------------
// 2. Mismatch → exactly one reload, never /login, never a loop
// ---------------------------------------------------------------------------

test("a mismatched release id reloads once, and only once, per client release", (t) => {
  withEnv(t, "NEXT_PUBLIC_DEPLOYMENT_ID", "release-old");
  const skew = skewModule;
  const storage = fakeStorage();
  let reloads = 0;
  const location = { reload: () => { reloads += 1; } };

  assert.equal(skew.isDeploymentMismatch("release-new"), true);
  assert.equal(skew.isDeploymentMismatch("release-old"), false);
  assert.equal(skew.isDeploymentMismatch(null), false, "an absent header is not a mismatch");
  assert.equal(skew.isDeploymentMismatch("release-new", null), false, "a local build without an id never reloads");

  assert.equal(skew.reloadOnceForVersionSkew({ storage, location }), true);
  assert.equal(reloads, 1);
  // The reload somehow landed on the same stale bundle (cache in front of the
  // app, half-finished switch): fall through to the ordinary error state.
  assert.equal(skew.reloadOnceForVersionSkew({ storage, location }), false);
  assert.equal(reloads, 1, "a second mismatch for the same client release must not reload again");
  // A genuinely new client release is allowed its own single reload.
  assert.equal(skew.reloadOnceForVersionSkew({ storage, location, clientId: "release-new" }), true);
  assert.equal(reloads, 2);
});

test("the errors Next.js raises for a stale bundle's server action are recognised as skew", (t) => {
  withEnv(t, "NEXT_PUBLIC_DEPLOYMENT_ID", "release-old");
  const skew = skewModule;
  for (const error of [
    Object.assign(new Error("anything"), { name: "UnrecognizedActionError" }),
    new Error('Failed to find Server Action "abc". This request might be from an older or newer deployment.'),
    new Error("Server Reference ID did not match"),
    new Error('Server Action "x" did not match the expected format'),
  ]) {
    assert.equal(skew.isVersionSkewError(error), true, error.message);
  }
  for (const error of [new Error("Failed to fetch"), new Error("unauthorized"), new Error("Expected RSC response, got text/plain"), null, "string", { status: 401 }]) {
    assert.equal(skew.isVersionSkewError(error), false);
  }
});

test("the shared session reader reloads a stale tab once and still reports the session, never 'unauthenticated'", async (t) => {
  withEnv(t, "NEXT_PUBLIC_DEPLOYMENT_ID", "release-old");
  const storage = fakeStorage();
  let reloads = 0;
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = { sessionStorage: storage, location: { reload: () => { reloads += 1; } } };
  t.after(() => {
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  });

  const identity = { userId: "u1", email: "u@example.test", role: "boss", isActive: true, forcePasswordChange: false, fullName: null };
  let status = 200;
  globalThis.fetch = async () => new Response(JSON.stringify(identity), {
    status,
    headers: { "content-type": "application/json", "x-newme-deployment-id": "release-new" },
  });

  const session = load("src/lib/session-identity.ts");
  const first = await session.readSessionIdentity();
  assert.equal(first.status, "active", "a valid session on a newer server is still a valid session");
  assert.equal(first.identity.role, "boss");
  assert.equal(reloads, 1);

  const second = await session.readSessionIdentity();
  assert.equal(second.status, "active");
  assert.equal(reloads, 1, "the same stale client must not be reloaded a second time");

  // An unavailable answer is reported as such, not as "signed out".
  status = 503;
  assert.deepEqual(await session.readSessionIdentity({ retryDelaysMs: [] }), { status: "unavailable" });
  status = 401;
  assert.deepEqual(await session.readSessionIdentity(), { status: "unauthenticated" });
  assert.equal(reloads, 1);
});

test("a server whose release matches, or reports none, never triggers a reload", async (t) => {
  withEnv(t, "NEXT_PUBLIC_DEPLOYMENT_ID", "release-old");
  let reloads = 0;
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = { sessionStorage: fakeStorage(), location: { reload: () => { reloads += 1; } } };
  t.after(() => {
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  });
  const identity = { userId: "u1", email: null, role: "sales", isActive: true, forcePasswordChange: false, fullName: null };
  for (const headers of [{ "x-newme-deployment-id": "release-old" }, {}]) {
    globalThis.fetch = async () => new Response(JSON.stringify(identity), { status: 200, headers });
    const session = load("src/lib/session-identity.ts");
    assert.equal((await session.readSessionIdentity()).status, "active");
  }
  assert.equal(reloads, 0);
});

test("GET /api/auth/me reports the release that answered, under the header the client compares", async (t) => {
  withEnv(t, "NEXT_PUBLIC_DEPLOYMENT_ID", "release-server");
  const skew = skewModule;
  const { NextResponse } = require("next/server");
  const names = { authToken: "sb-fixture-auth-token", refreshToken: "sb-fixture-refresh-token" };
  const user = { id: "fixture", email: "fixture@example.test" };
  const profile = { id: user.id, role: "sales", is_active: true, force_password_change: false };
  const client = {
    auth: { getUser: async () => ({ data: { user }, error: null }) },
    rpc: async () => ({ data: "ok", error: null }),
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: profile, error: null }) }) }) }),
  };
  const me = load("src/app/api/auth/me/route.ts", {
    "next/server": { NextResponse },
    "@/lib/supabase-server": {
      createServerSupabase: async () => client,
      getRefreshedCookies: () => [],
      getRefreshAttempted: () => true,
      getRefreshFailure: () => undefined,
    },
    "@/lib/supabase-cookie-names": { getSupabaseCookieNames: () => names },
    "@/lib/forced-password-change.mjs": { FORCED_SESSION_ERROR: "password_change_required", isForcedPasswordChange: () => false },
    "@/lib/logger": { logger: { error() {} } },
  });
  const response = await me.GET(new Request("https://example.test/api/auth/me", { headers: { cookie: `${names.refreshToken}=refresh` } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get(skew.DEPLOYMENT_ID_HEADER), "release-server");
  assert.equal(skew.DEPLOYMENT_ID_HEADER, "x-newme-deployment-id");
  // The route spells the header out (it must not import a client module); the
  // two spellings have to agree or the client never sees a mismatch.
  assert.match(read("src/app/api/auth/me/route.ts"), /headers\.set\("x-newme-deployment-id", releaseId\)/);
});

// ---------------------------------------------------------------------------
// 3. The on-load identity lookup is not a server action, and never a /login
// ---------------------------------------------------------------------------

test("no on-load identity lookup goes through the getCurrentUser() server action", () => {
  const callers = [
    "src/hooks/useRequireRole.ts",
    "src/hooks/useUserRole.ts",
    "src/hooks/useAuthRedirect.ts",
    "src/app/(dashboard)/analytics/_components/PaymentTracker.tsx",
  ];
  for (const file of callers) {
    const source = read(file);
    assert.equal(source.includes("@/app/actions/auth"), false, `${file} must not call the getCurrentUser() server action`);
    assert.doesNotMatch(source, /getCurrentUser\(\)\.then|await getCurrentUser\(/, `${file} must not call the getCurrentUser() server action`);
    assert.match(source, /readSessionIdentity/, `${file} must read GET /api/auth/me through the shared reader`);
  }
  // The action itself still exists for /change-password; nothing under the
  // dashboard tree may import it for an on-load lookup.
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
  const offenders = walk(path.join(ROOT, "src/app/(dashboard)"))
    .filter((file) => /\.(ts|tsx)$/.test(file) && fs.readFileSync(file, "utf8").includes("@/app/actions/auth"));
  assert.deepEqual(offenders, []);
});

test("an unavailable identity answer keeps the page waiting; only a real refusal goes to /login", () => {
  const requireRole = read("src/hooks/useRequireRole.ts");
  assert.match(requireRole, /outcome\.status === "unauthenticated"\)\s*\{\s*router\.push\("\/login"\)/);
  assert.match(requireRole, /outcome\.status === "unavailable"\)\s*\{\s*setUnavailable\(true\);\s*return;/);
  assert.doesNotMatch(requireRole, /catch\s*\{[^}]*router\.push\("\/login"\)/, "a thrown lookup must not be treated as signed out");

  const userRole = read("src/hooks/useUserRole.ts");
  assert.match(userRole, /outcome\.status === "unavailable"\)\s*return;/, "role must stay unresolved, not null, while the answer is unavailable");

  const authRedirect = read("src/hooks/useAuthRedirect.ts");
  assert.doesNotMatch(authRedirect, /setTimeout\(\(\)\s*=>\s*\{\s*if \(!cancelled\) router\.push\("\/login"\)/,
    "a slow /api/auth/me must show the connection-error state, not log the user out");
  assert.match(authRedirect, /setTimeout\(\(\) => \{\s*if \(cancelled\) return;\s*setAuthError\(true\);\s*setAuthLoading\(false\);\s*\}, 5000\)/);
  assert.match(authRedirect, /outcome\.status === "unauthenticated"\)\s*\{\s*router\.push\("\/login"\)/);
});

test("the dashboard layout and its error boundary reload a stale bundle once instead of showing an error", () => {
  const layout = read("src/app/(dashboard)/layout.tsx");
  assert.match(layout, /useVersionSkewReload\(\)/);
  const boundary = read("src/components/DashboardErrorBoundary.tsx");
  assert.match(boundary, /isVersionSkewError\(error\) && reloadOnceForVersionSkew\(\)\) return;/);
  const hook = read("src/hooks/useVersionSkewReload.ts");
  assert.match(hook, /addEventListener\("unhandledrejection"/);
  assert.doesNotMatch(hook, /\/login/);
  assert.doesNotMatch(read("src/lib/deployment-skew.mjs"), /["'`]\/login["'`]/);
});
