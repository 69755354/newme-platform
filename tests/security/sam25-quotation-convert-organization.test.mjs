import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("SAM-25 conversion and payment chain carry request organization into RLS clients", async () => {
  const conversion = await readFile(
    new URL("../../src/app/api/quotations/[id]/convert/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(conversion, /resolveOrganizationAuthorization\(/);
  assert.match(conversion, /quotations\.convert/);
  assert.match(conversion, /request\.headers\.get\("idempotency-key"\)/);
  assert.match(conversion, /v4_convert_quotation_for_organization/);
  assert.match(conversion, /p_organization_id: access\.organizationId/);
  assert.doesNotMatch(conversion, /\.from\(["'](?:contracts|payment_plans|contract_approvals|projects|activities)["']\)/);
  assert.doesNotMatch(conversion, /\.from\("profiles"\)[\s\S]{0,160}\.select\("role"\)/);

  const cases = [
    ["../../src/app/api/payments/route.ts", "payments.create"],
    ["../../src/app/api/payments/[id]/confirm/route.ts", "payments.confirm"],
    ["../../src/app/api/payments/[id]/allocate/route.ts", "payments.allocate"],
  ];

  for (const [path, capability] of cases) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(source, /resolveOrganizationAuthorization\(/, path);
    assert.match(source, new RegExp(capability.replaceAll(".", "\\.")), path);
    assert.match(source, /\.eq\("organization_id", access\.organizationId\)/, path);
    assert.doesNotMatch(source, /\.from\("profiles"\)[\s\S]{0,160}\.select\("role"\)/, path);
  }
});
