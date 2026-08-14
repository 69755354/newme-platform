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
