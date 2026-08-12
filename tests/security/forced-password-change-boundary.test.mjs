// ============================================================================
// A2 — a forced session is refused by the server, not only by the browser
// ============================================================================
// Round-4 review A2: "src/proxy.ts does not read or reject force_password_change.
// A forced admin request can reach a service-role password-reset path. Required
// closure: the proxy and shared server-side auth context must reject forced
// sessions everywhere except the narrowly allowed password-change/logout/
// session-information endpoints. Inventory and behavior-test every service-role
// route."
//
// This file is that closure's evidence, in three parts:
//   1. the exception list itself, as a unit;
//   2. the two boundaries' behaviour — refusal, allowance, and the order in
//      which refusals are decided — by executing the real modules with mocked
//      Supabase clients;
//   3. an inventory of every route that constructs a service-role client, held
//      against the proxy matcher and the exception list, so that "a forced
//      session cannot reach a service-role route" is a checked claim about the
//      routes that exist rather than about the ones this test remembered.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  FORCED_SESSION_ALLOWED_API_PATHS,
  FORCED_SESSION_ALLOWED_PAGE_PATHS,
  FORCED_SESSION_ERROR,
  FORCED_SESSION_REDIRECT_PATH,
  isForcedPasswordChange,
  isForcedSessionAllowedPath,
} from "../../src/lib/forced-password-change.mjs";
import { isActiveProfile } from "../../src/lib/auth-profile.mjs";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Compile one repository TypeScript module with `mocks` standing in for imports. */
function loadModule(relativePath, mocks) {
  const ts = require("typescript");
  const filename = path.join(root, relativePath);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const previousLoad = Module._load;
  Module._load = (request, parent, isMain) => Object.hasOwn(mocks, request)
    ? mocks[request]
    : previousLoad.call(Module, request, parent, isMain);
  try {
    loaded._compile(outputText, filename);
    return loaded.exports;
  } finally {
    Module._load = previousLoad;
  }
}

function nextServer() {
  return {
    NextRequest: class {},
    NextResponse: {
      json: (body, init) => ({ body, status: init?.status ?? 200, headers: new Headers(), cookies: { set: () => {} } }),
      next: () => ({ status: 200 }),
      redirect: (url) => ({ location: String(url), status: 307 }),
    },
  };
}

function request(pathname, method = "POST", headers = {}) {
  return {
    headers: new Headers(headers),
    method,
    nextUrl: { pathname },
    url: `https://app.newme.ae${pathname}`,
  };
}

/** A structurally valid access token whose `iat` is now, so the staleness gate passes. */
function accessToken() {
  const payload = Buffer.from(JSON.stringify({ iat: Math.floor(Date.now() / 1000) })).toString("base64url");
  return `header.${payload}.signature`;
}

const FORCED = { id: "u1", role: "admin", is_active: true, password_changed_at: null, force_password_change: true };
const CLEAR = { ...FORCED, force_password_change: false };

/** The URL path a file under src/app serves, with route groups removed. */
function urlPathOf(file) {
  const relative = path.relative(path.join(root, "src/app"), path.dirname(file)).replaceAll("\\", "/");
  const withoutGroups = relative.replace(/\(.*?\)\/?/g, "");
  return `/${withoutGroups}`.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1");
}

/** Every file named `name` under src/app, as URL paths. */
function appPaths(name) {
  const found = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === name) found.add(urlPathOf(full));
    }
  };
  walk(path.join(root, "src/app"));
  return found;
}

/** A refusal is a 403 JSON body; the cookie/header carriers are not the claim. */
function assertRefused(response, where) {
  assert.equal(response.status, 403, `${where} was not refused`);
  assert.deepEqual(response.body, { error: FORCED_SESSION_ERROR }, where);
}

function loadProxy(profile) {
  const table = {
    select: () => ({ eq: () => ({ single: async () => ({ data: profile, error: null }) }) }),
    update: () => ({ eq: () => ({ then: (resolve) => resolve({ error: null }) }) }),
  };
  return loadModule("src/proxy.ts", {
    "next/server": nextServer(),
    "@/lib/supabase-middleware": {
      createMiddlewareClient: async () => ({
        supabase: {
          auth: {
            getUser: async () => ({ data: { user: { id: "u1" } } }),
            getSession: async () => ({ data: { session: { access_token: accessToken() } } }),
          },
          from: () => table,
        },
        getResponse: () => ({ status: 200 }),
      }),
    },
    "@/lib/report-server-error": { reportServerError: async () => {} },
    "@/lib/auth-profile.mjs": { isActiveProfile },
    "@/lib/forced-password-change.mjs": {
      FORCED_SESSION_ERROR,
      FORCED_SESSION_REDIRECT_PATH: "/change-password",
      isForcedPasswordChange,
      isForcedSessionAllowedPath,
    },
  });
}

// --- 1 · the exception list -------------------------------------------------

test("the exception list is the escape hatch and nothing else", () => {
  assert.deepEqual([...FORCED_SESSION_ALLOWED_API_PATHS].sort(), [
    "/api/auth/change-password",
    "/api/auth/login",
    "/api/auth/logout",
    "/api/auth/me",
    "/api/auth/session",
  ]);
  assert.deepEqual([...FORCED_SESSION_ALLOWED_PAGE_PATHS].sort(), ["/change-password", "/login"]);

  // Every allowed path must be a real route or page in the tree, or the list is
  // documenting an endpoint that does not exist — and an exception that does not
  // resolve is a hole nobody can see.
  const routes = appPaths("route.ts");
  for (const apiPath of FORCED_SESSION_ALLOWED_API_PATHS) {
    assert.ok(routes.has(apiPath), `${apiPath} has no route.ts under src/app`);
  }
  const pages = appPaths("page.tsx");
  for (const pagePath of FORCED_SESSION_ALLOWED_PAGE_PATHS) {
    assert.ok(pages.has(pagePath), `${pagePath} has no page.tsx under src/app`);
  }
  assert.equal(FORCED_SESSION_REDIRECT_PATH, "/change-password");
  assert.ok(FORCED_SESSION_ALLOWED_PAGE_PATHS.has(FORCED_SESSION_REDIRECT_PATH));
});

test("path matching is exact, and the predicate only reacts to a literal true", () => {
  assert.equal(isForcedSessionAllowedPath("/api/auth/change-password"), true);
  assert.equal(isForcedSessionAllowedPath("/change-password/"), true);
  assert.equal(isForcedSessionAllowedPath("/api/auth/change-password/../../users/1/password"), false);
  assert.equal(isForcedSessionAllowedPath("/api/auth/change-passwordx"), false);
  assert.equal(isForcedSessionAllowedPath("/api/users/1/password"), false);
  assert.equal(isForcedSessionAllowedPath(""), false);
  assert.equal(isForcedSessionAllowedPath(undefined), false);

  assert.equal(isForcedPasswordChange({ force_password_change: true }), true);
  for (const value of [false, null, undefined, 0, "true"]) {
    assert.equal(isForcedPasswordChange({ force_password_change: value }), false, String(value));
  }
  assert.equal(isForcedPasswordChange(null), false);
});

// --- 2 · the two boundaries -------------------------------------------------

test("the proxy refuses a forced session on every path but the escape hatch", async () => {
  const proxy = loadProxy(FORCED);

  // The route the review named: a forced admin reaching a service-role reset.
  const reset = "/api/users/00000000-0000-0000-0000-000000000001/password";
  assertRefused(await proxy.proxy(request(reset, "PATCH")), reset);
  // Mutations and reads alike.
  assertRefused(await proxy.proxy(request("/api/leads/a/stage")), "POST /api/leads/a/stage");
  assertRefused(await proxy.proxy(request("/api/contracts", "GET")), "GET /api/contracts");
  assertRefused(await proxy.proxy(request("/api/kpi/targets", "PUT")), "PUT /api/kpi/targets");

  // Pages are redirected to the one page that can clear the state.
  const page = await proxy.proxy(request("/dashboard", "GET"));
  assert.equal(page.status, 307);
  assert.match(page.location, /\/change-password\?reason=password_change_required$/);

  // The escape hatch itself stays reachable.
  assert.deepEqual(await proxy.proxy(request("/api/auth/change-password")), { status: 200 });
  assert.deepEqual(await proxy.proxy(request("/api/auth/me", "GET")), { status: 200 });
  assert.deepEqual(await proxy.proxy(request("/api/auth/logout")), { status: 200 });
});

test("a session that is not forced is unaffected", async () => {
  const proxy = loadProxy(CLEAR);
  assert.deepEqual(await proxy.proxy(request("/api/leads/a/stage")), { status: 200 });
  assert.deepEqual(await proxy.proxy(request("/api/users/1/password", "PATCH")), { status: 200 });
  assert.deepEqual(await proxy.proxy(request("/dashboard", "GET")), { status: 200 });
});

test("the Bearer path asks the database for the flag it enforces", async (t) => {
  // The Bearer fallback reads the profile over PostgREST rather than through the
  // cookie client. If that select omits force_password_change the refusal above
  // silently becomes unreachable for token callers — the exact shape of the
  // original defect, one code path further in.
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const previousAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "publishable-key";
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return { ok: true, json: async () => [FORCED] };
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
    if (previousAnon === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = previousAnon;
  });

  const proxy = loadModule("src/proxy.ts", {
    "next/server": nextServer(),
    "@/lib/supabase-middleware": {
      createMiddlewareClient: async () => ({
        supabase: {
          auth: {
            getUser: async (token) => ({ data: { user: token === "user-token" ? { id: "u1" } : null } }),
          },
        },
        getResponse: () => ({ status: 200 }),
      }),
    },
    "@/lib/report-server-error": { reportServerError: async () => {} },
    "@/lib/auth-profile.mjs": { isActiveProfile },
    "@/lib/forced-password-change.mjs": {
      FORCED_SESSION_ERROR,
      FORCED_SESSION_REDIRECT_PATH: "/change-password",
      isForcedPasswordChange,
      isForcedSessionAllowedPath,
    },
  });

  const bearer = request("/api/contracts", "GET", { Authorization: "Bearer user-token" });
  assertRefused(await proxy.proxy(bearer), "GET /api/contracts with a Bearer token");
  assert.match(requestedUrl, /select=[^&]*force_password_change/);
});

test("the shared auth context refuses a forced session and lets the escape hatch opt out", async () => {
  const profileRow = (profile) => ({
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: profile, error: null }) }) }),
    }),
    auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
  });
  const load = (profile) => loadModule("src/lib/request-auth-context.ts", {
    "next/server": nextServer(),
    "@/lib/supabase-server": {
      createServerSupabase: async () => profileRow(profile),
      getRefreshAttempted: () => false,
      getRefreshFailure: () => undefined,
      getRefreshedCookies: () => [],
    },
    "@/lib/supabase-cookie-names": { getSupabaseCookieNames: () => ({ authToken: "a", refreshToken: "r" }) },
    "@/lib/forced-password-change.mjs": { FORCED_SESSION_ERROR, isForcedPasswordChange },
  });

  const forced = load(FORCED);
  const httpRequest = new Request("https://app.newme.ae/api/tasks");

  const error = await forced.getRequestAuthContext(httpRequest).then(
    () => null,
    (caught) => caught,
  );
  assert.ok(error, "a forced session resolved an auth context");
  assert.equal(error.code, FORCED_SESSION_ERROR);
  assert.equal(error.status, 403);
  assert.deepEqual(
    await forced.requestAuthErrorResponse(error).body,
    { error: FORCED_SESSION_ERROR },
  );

  // The opt-out, and only for callers that ask for it.
  const allowed = await forced.getRequestAuthContext(httpRequest, { allowForcedPasswordChange: true });
  assert.equal(allowed.role, "admin");
  assert.equal(allowed.profile.force_password_change, true);

  // A cleared flag needs no opt-out.
  const clear = load(CLEAR);
  assert.equal((await clear.getRequestAuthContext(httpRequest)).role, "admin");

  // And a deactivated forced profile is still reported as deactivated: the
  // stronger refusal must not be masked by the newer one.
  const inactive = load({ ...FORCED, is_active: false });
  const inactiveError = await inactive.getRequestAuthContext(httpRequest).then(() => null, (caught) => caught);
  assert.equal(inactiveError.code, "inactive_account");
  assert.equal(inactiveError.status, 401);
});

// --- 3 · the inventory ------------------------------------------------------

/** Every route file that constructs a service-role client, as a URL path. */
function serviceRoleRoutes() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name !== "route.ts") continue;
      const source = fs.readFileSync(full, "utf8");
      if (!/@\/lib\/supabase-admin|SUPABASE_SERVICE_ROLE_KEY/.test(source)) continue;
      const urlPath = path
        .relative(path.join(root, "src/app"), path.dirname(full))
        .replaceAll("\\", "/")
        .replace(/\/?\(.*?\)\/?/g, "/");
      found.push(`/${urlPath}`.replace(/\/{2,}/g, "/"));
    }
  };
  walk(path.join(root, "src/app/api"));
  return found.sort();
}

test("no service-role route is reachable by a forced session", async () => {
  const routes = serviceRoleRoutes();
  assert.ok(routes.length >= 15, `only ${routes.length} service-role routes found — the inventory has drifted`);

  // The proxy runs in front of every one of them: they are all under /api, and
  // the matcher claims /api/:path*. Without that, the refusal above would be
  // decided by which paths someone remembered to list.
  const proxySource = fs.readFileSync(path.join(root, "src/proxy.ts"), "utf8");
  assert.match(proxySource, /"\/api\/:path\*"/);
  for (const route of routes) {
    assert.ok(route.startsWith("/api/"), `${route} is a service-role route outside /api`);
  }

  // Of those, exactly one is in the escape hatch, and it is the one that clears
  // the flag. Any other overlap would mean a forced session keeps service-role
  // reach — for example the admin reset route, which is what A2 reported.
  const exempt = routes.filter((route) => FORCED_SESSION_ALLOWED_API_PATHS.has(route));
  assert.deepEqual(exempt, ["/api/auth/change-password"]);
  assert.ok(
    routes.includes("/api/users/[id]/password"),
    "the admin reset route disappeared from the inventory; re-check what replaced it",
  );

  // Externally-authorized ingress (cron, webhooks) is service-role by design and
  // is authorized by a shared secret rather than by a session. It is exempt from
  // the *unauthenticated* gates, not from this one: a request that does carry a
  // forced user's cookies is still a forced session, and is still refused. Both
  // halves are asserted, because "exempt route" is the shape a hole hides in.
  const external = routes.filter((route) => /^\/api\/(cron\/|leads\/meta-capi|meta\/oauth-callback)/.test(route));
  assert.ok(external.length >= 5, `only ${external.length} externally-authorized service-role routes`);
  const forcedProxy = loadProxy(FORCED);
  for (const route of external) {
    assert.ok(!FORCED_SESSION_ALLOWED_API_PATHS.has(route), `${route} is in the escape hatch`);
    assertRefused(await forcedProxy.proxy(request(route, "POST")), `forced session on ${route}`);
  }

  // And every remaining service-role route, exercised through the proxy rather
  // than reasoned about: this is the "behavior-test every service-role route"
  // half of the closure.
  for (const route of routes) {
    if (FORCED_SESSION_ALLOWED_API_PATHS.has(route)) continue;
    const concrete = route.replaceAll(/\[[^\]]+\]/g, "00000000-0000-0000-0000-000000000001");
    for (const method of ["GET", "POST"]) {
      assertRefused(await forcedProxy.proxy(request(concrete, method)), `forced ${method} ${concrete}`);
    }
  }
});

test("every authenticated page is behind the proxy, so no page escapes the boundary", async () => {
  // A boundary in the proxy is worth exactly the matcher's coverage. Server
  // actions POST to their own page's path, so a page the matcher does not list
  // is an unchecked action entry point as well as an unchecked render — for this
  // refusal and for the older is_active one. This test found /payments, /tasks
  // and /workbench missing; it exists so the next page cannot go missing quietly.
  const proxySource = fs.readFileSync(path.join(root, "src/proxy.ts"), "utf8");
  const matcherBlock = proxySource.slice(proxySource.indexOf("matcher: ["));
  const patterns = [...matcherBlock.matchAll(/"(\/[^"]*)"/g)].map((match) => match[1]);
  const covered = (pathname) => patterns.some((pattern) => {
    if (pattern === "/") return pathname === "/";
    const base = pattern.replace("/:path*", "");
    return pathname === base || pathname.startsWith(`${base}/`);
  });

  const authenticatedPages = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "page.tsx") authenticatedPages.push(urlPathOf(full));
    }
  };
  walk(path.join(root, "src/app/(dashboard)"));
  assert.ok(authenticatedPages.length >= 15, `only ${authenticatedPages.length} pages under (dashboard)`);

  const uncovered = authenticatedPages.filter((pathname) => !covered(pathname));
  assert.deepEqual(uncovered, [], "authenticated pages the proxy never sees");

  // The pages the escape hatch needs must stay renderable, or a forced session
  // has no way to clear the flag.
  const forcedProxy = loadProxy(FORCED);
  for (const pagePath of FORCED_SESSION_ALLOWED_PAGE_PATHS) {
    const response = await forcedProxy.proxy(request(pagePath, "GET"));
    assert.notEqual(response.status, 307, `${pagePath} redirects a forced session`);
  }

  // And a representative page that was previously unmatched is now refused,
  // including the server-action POST to it.
  for (const method of ["GET", "POST"]) {
    const response = await forcedProxy.proxy(request("/tasks", method));
    assert.equal(response.status, 307, `forced ${method} /tasks was not redirected`);
    assert.match(response.location, /\/change-password\?reason=password_change_required$/);
  }
});

test("only the escape hatch opts out of the forced-session refusal", () => {
  // A route that passes allowForcedPasswordChange is asserting it is part of the
  // password-change flow. The refusal is only as good as that list staying short.
  const callers = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (/allowForcedPasswordChange/.test(fs.readFileSync(full, "utf8"))) {
        callers.push(path.relative(root, full).replaceAll("\\", "/"));
      }
    }
  };
  walk(path.join(root, "src"));
  assert.deepEqual(callers, ["src/lib/request-auth-context.ts"], "unexpected opt-out of the A2 boundary");
});
