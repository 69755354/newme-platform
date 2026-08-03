import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeUrl = new URL(
  "../../src/app/api/admin/impersonate/route.ts",
  import.meta.url,
);

test("legacy impersonation is permanently retired without reading caller input", async () => {
  const route = await import(routeUrl);
  let requestWasRead = false;
  const poisonRequest = new Proxy({}, {
    get() {
      requestWasRead = true;
      throw new Error("retired route read request input");
    },
  });

  const response = await route.POST(poisonRequest);

  assert.equal(requestWasRead, false);
  assert.equal(response.status, 410);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    error: "impersonation_endpoint_retired",
  });
});

test("retired impersonation route has no authorization or magic-link compatibility path", async () => {
  const source = await readFile(routeUrl, "utf8");

  assert.match(source, /export async function POST\(\)/);
  assert.match(source, /status: 410/);
  assert.match(source, /"Cache-Control": "no-store"/);
  assert.doesNotMatch(source, /NextRequest|request\.json|request\.|supabaseAdmin/);
  assert.doesNotMatch(source, /generateLink|magiclink|getRequestAuthContext|targetUserId/);
});
