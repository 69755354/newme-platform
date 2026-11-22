// OS fix S22 (page speed). Every case here pins a behaviour that makes a page
// load with fewer or shorter request chains, without changing what it shows or
// who may see it. The TypeScript modules are transpiled so the real code runs.
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

// ── 1. start a fetch early, let the component that needs it take it over ────

test("early fetch: a fetch started early is reused once by the consumer, never twice", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); return new Response("{}", { status: 200 }); };
  const early = load("src/lib/early-fetch.ts");

  early.startEarlyFetch("/api/alerts");
  early.startEarlyFetch("/api/alerts"); // a second start while one is pending is a no-op
  assert.equal(urls.length, 1);
  const first = await early.takeEarlyFetch("/api/alerts");
  assert.equal(first.status, 200);
  assert.equal(urls.length, 1, "the consumer used the early request");
  await early.takeEarlyFetch("/api/alerts");
  assert.equal(urls.length, 2, "a second take is an ordinary, fresh request");
});

test("early fetch: an unclaimed early result expires instead of serving stale data", async (t) => {
  const previous = globalThis.fetch;
  const realNow = Date.now;
  t.after(() => { globalThis.fetch = previous; Date.now = realNow; });
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("{}"); };
  const early = load("src/lib/early-fetch.ts");
  let now = 1_000_000;
  Date.now = () => now;
  early.startEarlyFetch("/api/alerts");
  now += early.EARLY_FETCH_TTL_MS + 1;
  await early.takeEarlyFetch("/api/alerts");
  assert.equal(calls, 2, "an expired early request is not reused");
});

test("early fetch: a failed early request neither crashes nor poisons the consumer", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async () => { throw new TypeError("offline"); };
  const early = load("src/lib/early-fetch.ts");
  early.startEarlyFetch("/api/alerts");
  await assert.rejects(early.takeEarlyFetch("/api/alerts"), /offline/, "the consumer sees the same failure it always did");
  // never claimed: must not surface as an unhandled rejection
  early.startEarlyFetch("/api/notifications/unread-count");
  await new Promise((resolve) => setTimeout(resolve, 5));
});

// ── 2. the layout's identity read is handed to the page that mounts next ───

test("session handoff: the layout's fresh read is used once, by the first page, and expires", () => {
  const { createSessionHandoff, SESSION_HANDOFF_TTL_MS } = load("src/lib/session-handoff.ts");
  let now = 5_000;
  const handoff = createSessionHandoff(() => now);
  assert.equal(handoff.take(), null, "nothing offered, nothing to take");
  handoff.offer({ userId: "u1", role: "boss" });
  assert.deepEqual(handoff.take(), { userId: "u1", role: "boss" });
  assert.equal(handoff.take(), null, "one page only: the next page reads the session itself");
  handoff.offer({ userId: "u1", role: "boss" });
  now += SESSION_HANDOFF_TTL_MS + 1;
  assert.equal(handoff.take(), null, "an old read is never reused: revocation is re-checked on later visits");
  assert.ok(SESSION_HANDOFF_TTL_MS <= 5_000);
});

test("the session reader itself still has no reusable state (revocation boundary)", () => {
  const source = read("src/lib/session-identity.ts");
  assert.doesNotMatch(source, /lastActive|peekSessionIdentity|handoff|early-fetch/i);
});

// ── 3. one identity lookup per request ─────────────────────────────────────

function authContextHarness(overrides = {}) {
  const calls = { getUser: 0, rpc: 0, profile: 0, create: 0 };
  const client = {
    auth: { async getUser() { calls.getUser += 1; return { data: { user: { id: "u1" } }, error: null }; } },
    async rpc() { calls.rpc += 1; return { data: "ok", error: null }; },
    from() {
      return { select() { return { eq() { return { async single() {
        calls.profile += 1;
        return { data: { id: "u1", role: "boss", is_active: true, full_name: "A", email: "a@example.com", force_password_change: false }, error: null };
      } }; } }; } };
    },
  };
  const mocks = {
    "next/server": { NextResponse: { json: (body, init) => ({ body, init, headers: new Headers(), cookies: { set() {} } }) } },
    "@/lib/supabase-server": {
      async createServerSupabase() { calls.create += 1; return client; },
      getRefreshedCookies: () => [],
      getRefreshAttempted: () => false,
      getRefreshFailure: () => undefined,
      ...overrides,
    },
    "@/lib/supabase-cookie-names": { getSupabaseCookieNames: () => ({ authToken: "a", refreshToken: "r" }) },
  };
  return { calls, mocks };
}

test("request auth: the same request resolves its identity once, however many helpers ask", async () => {
  const { calls, mocks } = authContextHarness();
  const { getRequestAuthContext } = load("src/lib/request-auth-context.ts", mocks);
  const request = new Request("https://app.example/api/x", { headers: { cookie: "a=1" } });
  const [one, two] = await Promise.all([getRequestAuthContext(request), getRequestAuthContext(request)]);
  const three = await getRequestAuthContext(request);
  assert.equal(one, two);
  assert.equal(one, three);
  assert.deepEqual(calls, { getUser: 1, rpc: 1, profile: 1, create: 1 });
});

test("request auth: another request, or a different forced-password option, is never answered from the first", async () => {
  const { calls, mocks } = authContextHarness();
  const { getRequestAuthContext } = load("src/lib/request-auth-context.ts", mocks);
  const a = new Request("https://app.example/api/x", { headers: { cookie: "a=1" } });
  const b = new Request("https://app.example/api/x", { headers: { cookie: "a=1" } });
  await getRequestAuthContext(a);
  await getRequestAuthContext(b);
  assert.equal(calls.getUser, 2, "no identity is shared between requests");
  await getRequestAuthContext(a, { allowForcedPasswordChange: true });
  assert.equal(calls.getUser, 3, "the option changes the verdict, so it is part of the key");
});

test("request auth: a refusal is remembered for the request too, and is not retried into a different answer", async () => {
  const { calls, mocks } = authContextHarness();
  mocks["@/lib/supabase-server"].createServerSupabase = async () => {
    calls.create += 1;
    return {
      auth: { async getUser() { calls.getUser += 1; return { data: { user: null }, error: { status: 401 } }; } },
    };
  };
  const { getRequestAuthContext, RequestAuthError } = load("src/lib/request-auth-context.ts", mocks);
  const request = new Request("https://app.example/api/x");
  await assert.rejects(getRequestAuthContext(request), RequestAuthError);
  await assert.rejects(getRequestAuthContext(request), RequestAuthError);
  assert.equal(calls.getUser, 1);
});

// ── 4. dashboard: summary, alerts and the weekly review go out together ────

test("dashboard page starts alerts with the summary and does not hold the weekly review for the role", () => {
  const page = read("src/app/(dashboard)/dashboard/page.tsx");
  // S37: the overdue sentence uses the lead summary count, so the alerts feed is not requested at mount any more.
  assert.doesNotMatch(page, /startEarlyFetch\("\/api\/alerts"\)/);
  const weekly = page.slice(page.indexOf("params.set(\"start\", weeklyReviewStart)") - 400, page.indexOf("/api/dashboard/weekly-review") + 200);
  assert.doesNotMatch(weekly, /!userRole/, "the weekly review no longer waits for the summary to supply the role");
  assert.doesNotMatch(page.slice(page.indexOf("weekly-review?"), page.indexOf("weekly-review?") + 1200), /\[userRole,/);
  const panel = read("src/app/(dashboard)/dashboard/_components/AlertPanel.tsx");
  assert.match(panel, /takeEarlyFetch\("\/api\/alerts"\)/);
});

// ── 5. analytics: one identity read, no unused summary call ────────────────

test("analytics page resolves the role once and shares it; no component reads the session again", () => {
  const page = read("src/app/(dashboard)/analytics/page.tsx");
  assert.match(page, /PageIdentityContext\.Provider/);
  assert.doesNotMatch(page, /fetch\("\/api\/analytics\/summary"/, "nothing reads this payload, and it is the slowest call");
  for (const file of ["LeadHealth", "PipelineFunnel", "PaymentTracker", "SalesLoad"]) {
    assert.doesNotMatch(read(`src/app/(dashboard)/analytics/_components/${file}.tsx`), /readSessionIdentity/, file);
  }
});

test("role hooks use the page's identity, then the layout's handoff, and only then ask the server", () => {
  for (const file of ["useRequireRole", "useUserRole"]) {
    const source = read(`src/hooks/${file}.ts`);
    assert.match(source, /PageIdentityContext/, file);
    assert.match(source, /SessionHandoffContext/, file);
    assert.match(source, /readSessionIdentity\(\)/, `${file} still reads live when nothing was handed over`);
  }
  const layout = read("src/app/(dashboard)/layout.tsx");
  assert.match(layout, /SessionHandoffContext\.Provider/);
  assert.match(read("src/hooks/useAuthRedirect.ts"), /handoff\.offer\(/);
});

test("role hooks: inside a page that already resolved the role they answer without a request", async () => {
  const { identityFromPage } = load("src/lib/page-identity.ts");
  assert.deepEqual(identityFromPage({ role: "boss", userId: "u1" }, ["admin", "boss"]), { role: "boss", userId: "u1", blocked: false });
  assert.deepEqual(identityFromPage({ role: "sales", userId: "u2" }, ["admin", "boss"]), { role: "sales", userId: "u2", blocked: true });
  assert.equal(identityFromPage(null, ["admin"]), null);
});

// ── 6. lead page: a missing lead is a final answer ────────────────────────

test("lead detail: a lead that does not exist ends in 'not found' and starts nothing else", () => {
  const data = read("src/app/(dashboard)/leads/[id]/useLeadDetailData.ts");
  assert.match(data, /notFound/);
  assert.match(data, /isLeadMissing\(/);
  const page = read("src/app/(dashboard)/leads/[id]/page.tsx");
  assert.match(page, /notFound/);
  assert.match(page, /enabled: !!currentUserId && !notFound/);
  const { isLeadMissing } = load("src/app/(dashboard)/leads/[id]/missing.ts");
  assert.equal(isLeadMissing({ data: null, error: null }), true, "no row");
  assert.equal(isLeadMissing({ data: null, error: { code: "PGRST116" } }), true);
  assert.equal(isLeadMissing({ data: null, error: { code: "22P02" } }), true, "an id that is not even a valid uuid");
  assert.equal(isLeadMissing({ data: null, error: { code: "57014" } }), false, "a timeout is an error, not an absence");
  assert.equal(isLeadMissing({ data: { id: "x" }, error: null }), false);
});

// ── 7. measuring ──────────────────────────────────────────────────────────

test("the request-count script ships with usage notes and refuses production", () => {
  const script = read("scripts/measure-page-requests.mjs");
  assert.match(script, /Usage/);
  assert.match(script, /refus/i);
  assert.match(script, /app\.newme\.ae/);
});

test("the request-count script measures chains correctly and exits before touching production", async () => {
  const { longestChain } = await import("../../scripts/measure-page-requests.mjs");
  assert.equal(longestChain([]), 0);
  // three requests that all start together: one round trip
  assert.equal(longestChain([{ s: 0, e: 100 }, { s: 1, e: 120 }, { s: 2, e: 90 }]), 1);
  // me -> (unread, data in parallel) -> alerts after data: three in a row
  assert.equal(longestChain([{ s: 0, e: 100 }, { s: 105, e: 200 }, { s: 105, e: 180 }, { s: 205, e: 300 }]), 3);
  const { spawnSync } = await import("node:child_process");
  const run = spawnSync(process.execPath, ["scripts/measure-page-requests.mjs", "--base", "https://app.newme.ae"], {
    cwd: ROOT, encoding: "utf8", env: { ...process.env, MEASURE_EMAIL: "", MEASURE_PASSWORD: "" },
  });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /refusing/);
});
