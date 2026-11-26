// Lead detail delete must go through the same atomic path as the list (/api/leads/[id]/delete -> delete_lead_atomic),
// never a direct browser delete on the leads table, and a failure must not be reported as deleted.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const src = read("src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts");
const body = src.slice(src.indexOf("const confirmDelete"), src.indexOf("// ─── Mark lead as poor quality"));

test("lead detail delete does not delete from the leads table directly", () => {
  assert.equal(/from\("leads"\)\s*\.delete\(/.test(src), false);
});

test("lead detail delete calls the atomic delete route with an idempotency key", () => {
  assert.match(body, /fetch\(`\/api\/leads\/\$\{lead\.id\}\/delete`/);
  assert.match(body, /method: "POST"/);
  assert.match(body, /idempotencyKey: crypto\.randomUUID\(\)/);
  const route = read("src/app/api/leads/[id]/delete/route.ts");
  assert.match(route, /rpc\("delete_lead_atomic"/);
});

test("lead detail delete shows an error and keeps the dialog open on failure, success only after ok", () => {
  assert.match(body, /if \(!response\.ok\)[^]*?toast\.error[^]*?return false;/);
  assert.ok(body.indexOf("toast.error") < body.indexOf("toast.success"));
  assert.ok(body.indexOf("!response.ok") < body.indexOf("toast.success"));
  assert.match(body, /catch[^]*?toast\.error[^]*?return false;/);
});
