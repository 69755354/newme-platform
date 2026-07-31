import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

register("./sam68-next-route-loader.mjs", import.meta.url);

const monitoring = await import("../../src/app/api/monitoring/report/route.ts");
const readiness = await import("../../src/app/api/ready/route.ts");

function hostilePayload(nonce) {
  return {
    headers: { cookie: `session=secret-cookie-${nonce}`, authorization: `Bearer secret-token-${nonce}` },
    nested: { token: `nested-token-${nonce}`, email: `person-${nonce}@example.com`, phone: "+971 50 123 4567" },
    database: { details: `Key (email)=(person-${nonce}@example.com)`, hint: `token=database-token-${nonce}` },
    stack: `Error: secret-${nonce}\n    at /srv/app/private/module-${nonce}.ts:1:1`,
    path: `/srv/app/private/module-${nonce}.ts`,
  };
}

test("SAM-68 route handlers reject hostile monitoring input without file cardinality", async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "sam68-monitoring-"));
  const originalTmpDir = process.env.TMPDIR;
  process.env.TMPDIR = temporaryDirectory;
  t.after(async () => {
    if (originalTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpDir;
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  for (let nonce = 0; nonce < 32; nonce += 1) {
    const request = new Request("https://local.test/api/monitoring/report", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `request-cookie=secret-${nonce}`,
        authorization: `Bearer request-token-${nonce}`,
      },
      body: JSON.stringify(hostilePayload(nonce)),
    });
    const response = await monitoring.POST(request);
    assert.equal(request.bodyUsed, false, "retired handler must not parse attacker-controlled input");
    assert.equal(response.status, 410);
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
    const responseText = await response.text();
    assert.equal(responseText, JSON.stringify({ error: "Monitoring endpoint retired" }));
    for (const forbidden of ["secret", "example.com", "971", "/srv/app", "database-token"]) {
      assert.equal(responseText.includes(forbidden), false);
    }
  }

  assert.deepEqual(await readdir(temporaryDirectory), [], "retired handler must create zero monitoring files");
});

test("SAM-68 readiness handler rejects unauthenticated callers and bounds upstream timeout", async (t) => {
  const originalToken = process.env.NEWME_READINESS_TOKEN;
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    if (originalToken === undefined) delete process.env.NEWME_READINESS_TOKEN;
    else process.env.NEWME_READINESS_TOKEN = originalToken;
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
    globalThis.fetch = originalFetch;
  });

  delete process.env.NEWME_READINESS_TOKEN;
  const unauthorized = await readiness.GET(new Request("https://local.test/api/ready"));
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get("cache-control"), "no-store, max-age=0");
  assert.deepEqual(await unauthorized.json(), { status: "unauthorized" });

  process.env.NEWME_READINESS_TOKEN = "runtime-test-token";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://upstream.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "runtime-test-key";
  globalThis.fetch = (_url, init) => new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("probe aborted")), { once: true });
  });
  const started = Date.now();
  const degraded = await readiness.GET(new Request("https://local.test/api/ready", {
    headers: { "x-newme-readiness-token": "runtime-test-token" },
  }));
  assert.ok(Date.now() - started < 4_000, "readiness probe must abort within the 3s bound");
  assert.equal(degraded.status, 503);
  assert.equal(degraded.headers.get("cache-control"), "no-store, max-age=0");
  assert.deepEqual(await degraded.json(), { status: "degraded" });
});
