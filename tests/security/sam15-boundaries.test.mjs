import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const read = (file) => fs.readFile(new URL(`../../${file}`, import.meta.url), "utf8");

test("health endpoint exposes only a minimal public status", async () => {
  const source = await read("src/app/api/health/route.ts");
  assert.match(source, /status: "ok"/);
  assert.doesNotMatch(source, /service:|version:|release|uptime|checks|process\.cwd|fs\.writeFile|errMsg/);
});

test("production headers include CSP and HSTS", async () => {
  const source = await read("next.config.ts");
  assert.match(source, /Content-Security-Policy/);
  assert.match(source, /Strict-Transport-Security/);
  assert.match(source, /frame-ancestors 'none'/);
  assert.match(source, /upgrade-insecure-requests/);
});

test("session cookies use dynamic names and secure server refresh attributes", async () => {
  const cookieNames = await read("src/lib/supabase-cookie-names.ts");
  const server = await read("src/lib/supabase-server.ts");
  const session = await read("src/app/api/auth/session/route.ts");
  const login = await read("src/app/api/auth/login/route.ts");
  // Cookie attributes live in one shared module so the login and bootstrap
  // endpoints cannot drift apart. Both must route through it and neither may
  // hand-roll its own Set-Cookie.
  const cookies = await read("src/lib/session-cookies.ts");
  assert.match(cookieNames, /new URL\(supabaseUrl/);
  assert.doesNotMatch(cookieNames + server + session + login + cookies, /vfopmpxlhwzpxqegayew/);
  assert.match(server, /httpOnly: true/);
  assert.match(cookies, /JSON\.stringify\(\{[\s\S]*access_token: tokens\.accessToken/);
  assert.doesNotMatch(cookies, /const cookiePayload = JSON\.stringify\(\{[\s\S]*refresh_token/);
  assert.doesNotMatch(server, /_cookieStore\.set/);
  assert.match(cookies, /httpOnly: true/);
  assert.match(cookies, /sameSite: "strict"/);
  assert.match(cookies, /secure: true/);
  for (const [name, source] of [["session", session], ["login", login]]) {
    assert.match(source, /applySessionCookies\(/, `${name} must use the shared cookie contract`);
    assert.doesNotMatch(source, /cookies\.set\(/, `${name} must not set cookies directly`);
  }
});

test("middleware uses the custom split-session refresh boundary", async () => {
  const middleware = await read("src/lib/supabase-middleware.ts");
  assert.match(middleware, /createServerSupabase\([\s\S]*bearerToken,[\s\S]*request\.headers\.get\("cookie"\)/);
  assert.match(middleware, /getRefreshedCookies\(supabase\)/);
  assert.match(middleware, /request\.cookies\.set\(name, value\)/);
  assert.match(middleware, /response\.cookies\.set\(name, value, options/);
  assert.doesNotMatch(middleware, /@supabase\/ssr|CookieOptions|setAll/);
  assert.match(middleware, /getResponse: \(\) => response/);
  const proxy = await read("src/proxy.ts");
  assert.doesNotMatch(proxy, /const \{ supabase, response \}/);
  assert.match(proxy, /const \{ supabase, getResponse \} = (?:await createMiddlewareClient\(request\)|middlewareClient)/);
  assert.match(proxy, /return getResponse\(\)/);
});

test("login delegates the whole password grant to the same-origin server", async () => {
  const login = await read("src/app/login/page.tsx");
  const route = await read("src/app/api/auth/login/route.ts");
  const proxy = await read("src/proxy.ts");
  // The browser must never hold a raw token or speak to Supabase Auth itself:
  // that both bypassed the edge and put the grant response in page scripts.
  assert.match(login, /fetch\("\/api\/auth\/login"/);
  assert.doesNotMatch(login, /auth\/v1\//);
  assert.doesNotMatch(login, /access_token|refresh_token/);
  assert.doesNotMatch(login, /NEXT_PUBLIC_SUPABASE/);
  assert.doesNotMatch(login, /document\.cookie\s*=/);
  assert.match(route, /grant_type=password/);
  assert.match(proxy, /"\/api\/auth\/login"/);
  assert.match(proxy, /"\/api\/auth\/session"/);
});

test("session cookie payload is consumable by the SSR token parser contract", async () => {
  const session = await read("src/app/api/auth/session/route.ts");
  const server = await read("src/lib/supabase-server.ts");
  const payload = JSON.stringify({
    access_token: "access-token",
    refresh_token: "refresh-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
  const parsed = JSON.parse(payload);
  assert.equal(parsed.access_token, "access-token");
  assert.equal(parsed.refresh_token, "refresh-token");
  const cookies = await read("src/lib/session-cookies.ts");
  assert.match(cookies, /const cookiePayload = JSON\.stringify\(\{[\s\S]*access_token: tokens\.accessToken,\s*expires_at:/);
  assert.doesNotMatch(cookies, /const cookiePayload = JSON\.stringify\(\{[\s\S]*refresh_token/);
  assert.match(cookies, /response\.cookies\.set\(refreshCookie, tokens\.refreshToken/);
  assert.match(session, /applySessionCookies\(/);
  assert.match(server, /parseSsrCookie/);
});
test("every third-party origin the CSP grants is accounted for", async () => {
  // One boundary, three copies: the CSP here, the runner's route decision, and
  // whatever `src/**` actually talks to. This test is the thing that compares
  // them. `evidence` must match somewhere under src/ for an application origin;
  // an edge_injected origin must be named as such by the runner, allowed through
  // its route rule, and referenced nowhere in the application.
  const INVENTORY = Object.freeze({
    "https://*.supabase.co": { reason: "application", evidence: /NEXT_PUBLIC_SUPABASE_URL|createBrowserClient/ },
    "https://*.sentry.io": { reason: "application", evidence: /@sentry\/nextjs/ },
    "https://static.cloudflareinsights.com": { reason: "edge_injected" },
  });

  const config = await read("next.config.ts");
  const csp = config.match(/key: "Content-Security-Policy",[\s\S]{0,40}?value: "([^"]+)"/)?.[1];
  assert.ok(csp, "could not read the CSP value out of next.config.ts");
  const granted = new Set(csp.split(/[;\s]+/).filter((token) => token.startsWith("https://")));
  // Guard the parser: a regex that matched nothing would make the comparison
  // below trivially true.
  assert.ok(granted.size >= 3, `parsed only ${granted.size} origins out of the CSP`);
  assert.deepEqual([...granted].sort(), Object.keys(INVENTORY).sort());

  const srcFiles = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(new URL(`../../${dir}`, import.meta.url), { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(`${dir}/${entry.name}`);
      else if (/\.(?:ts|tsx|mjs|js)$/.test(entry.name)) srcFiles.push(`${dir}/${entry.name}`);
    }
  };
  await walk("src");
  assert.ok(srcFiles.length >= 100, `walked only ${srcFiles.length} source files`);
  const sources = await Promise.all(srcFiles.map((file) => read(file)));
  const corpus = sources.join("\u000a");

  const { EDGE_INJECTED_SCRIPT_ORIGINS, routeDecision } = await import(
    "../../scripts/run-postdeploy-browser-uat.mjs"
  );
  for (const [origin, entry] of Object.entries(INVENTORY)) {
    if (entry.reason === "application") {
      assert.match(corpus, entry.evidence, `${origin} is granted but nothing under src/ references it`);
      continue;
    }
    // Edge-injected means exactly that: not in the repository, and allowed
    // through by the browser gate, because aborting it is reported as a console
    // error and stubbing it fails the injected SRI digest.
    // Substring, not a regex: building a pattern out of the host meant escaping
    // dots, which CodeQL flagged as incomplete escaping (it left backslashes
    // alone). An exact substring search needs no escaping and is the stronger
    // statement anyway.
    const host = origin.replace("https://", "");
    assert.ok(!corpus.includes(host), `${origin} is not edge-injected: src/ references it`);
    assert.ok(
      EDGE_INJECTED_SCRIPT_ORIGINS.has(origin),
      `${origin} must be declared edge-injected in the browser gate`,
    );
    assert.equal(
      routeDecision(`${origin}/beacon.min.js`),
      "continue",
      `${origin} is granted by the CSP but the browser gate does not let it through`,
    );
  }
});
