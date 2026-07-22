import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

const read = (file) => fs.readFile(new URL(`../../${file}`, import.meta.url), "utf8");

test("health endpoint exposes only a minimal public status", async () => {
  const source = await read("src/app/api/health/route.ts");
  assert.match(source, /status: "ok"/);
  assert.match(source, /service: "newme-crm"/);
  assert.doesNotMatch(source, /release|uptime|checks|process\.cwd|fs\.writeFile|errMsg/);
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
  assert.match(cookieNames, /new URL\(supabaseUrl/);
  assert.doesNotMatch(cookieNames + server + session, /vfopmpxlhwzpxqegayew/);
  assert.match(server, /httpOnly: true/);
  assert.match(session, /httpOnly: true/);
  assert.match(session, /sameSite: "strict"/);
  assert.match(session, /secure: true/);
});

test("login delegates cookie creation to the same-origin server endpoint", async () => {
  const login = await read("src/app/login/page.tsx");
  const proxy = await read("src/proxy.ts");
  assert.match(login, /\/api\/auth\/session/);
  assert.doesNotMatch(login, /document\.cookie\s*=.*refresh/);
  assert.match(proxy, /"\/api\/auth\/session"/);
});
