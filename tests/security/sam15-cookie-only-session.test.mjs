import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parseAuthSessionCookie } from "../../src/lib/auth-cookie.mjs";

const root = new URL("../../", import.meta.url);

test("browser auth session is read from the controlled auth cookie", () => {
  const payload = JSON.stringify({
    access_token: "access-token",
    refresh_token: "refresh-token",
    expires_at: 2_000_000_000,
  });
  const session = parseAuthSessionCookie(`sb-demo-auth-token=${encodeURIComponent(payload)}`, "sb-demo-auth-token");

  assert.deepEqual(session, {
    access_token: "access-token",
    refresh_token: "refresh-token",
    expires_at: 2_000_000_000,
  });
});

test("browser auth session is absent when only localStorage contains a token", () => {
  globalThis.localStorage = {
    getItem: () => JSON.stringify({ access_token: "storage-token" }),
  };

  assert.equal(parseAuthSessionCookie("", "sb-demo-auth-token"), null);
});

test("cookie-only browser session contract does not use localStorage or client persistence", async () => {
  const [login, client, logout, session, server] = await Promise.all([
    readFile(new URL("src/app/login/page.tsx", root), "utf8"),
    readFile(new URL("src/lib/supabase.ts", root), "utf8"),
    readFile(new URL("src/app/api/auth/logout/route.ts", root), "utf8"),
    readFile(new URL("src/app/api/auth/session/route.ts", root), "utf8"),
    readFile(new URL("src/lib/supabase-server.ts", root), "utf8"),
  ]);

  assert.doesNotMatch(login, /localStorage/);
  assert.doesNotMatch(client, /localStorage|storage:/);
  assert.match(client, /Authorization:.*nextToken/);
  assert.match(client, /persistSession: false/);
  assert.match(logout, /getSupabaseCookieNames/);
  assert.match(session, /httpOnly: true/);
  assert.match(server, /httpOnly: true/);
});
