import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync("src/app/api/admin/impersonate/route.ts", "utf8");

test("SAM-14 requires a reason before a legacy impersonation link can be requested", () => {
  assert.match(route, /const reason = typeof input\.reason === "string" \? input\.reason\.trim\(\) : "";/);
  assert.match(route, /if \(!reason\) \{[\s\S]*reason required[\s\S]*status: 400/);
  assert.match(route, /details: \{[\s\S]*reason,/);
});

test("SAM-14 fails closed when the impersonation audit write fails", () => {
  const auditWrite = route.indexOf('const { error: auditError } = await supabaseAdmin.from("audit_logs").insert({');
  const auditFailure = route.indexOf("if (auditError)");
  const magicLink = route.indexOf("supabaseAdmin.auth.admin.generateLink");

  assert.ok(auditWrite >= 0, "audit write must be awaited");
  assert.ok(auditFailure > auditWrite, "audit failure must be handled after the write");
  assert.ok(magicLink > auditFailure, "magic link must be generated only after audit success");
  assert.match(route, /Audit logging unavailable; access denied/);
  assert.match(route, /status: 503/);
  assert.doesNotMatch(route, /\.insert\([\s\S]*?\.then\(/);
});
