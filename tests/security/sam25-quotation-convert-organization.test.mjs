import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("SAM-25 conversion and payment chain carry request organization into RLS clients", async () => {
  const paths = [
    "../../src/app/api/quotations/[id]/convert/route.ts",
    "../../src/app/api/payments/route.ts",
    "../../src/app/api/payments/[id]/confirm/route.ts",
    "../../src/app/api/payments/[id]/allocate/route.ts",
  ];

  for (const path of paths) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(
      source,
      /createServerSupabase\(\s*bearerToken,\s*cookieHeader,\s*getRequestedOrganizationId\(request\) \?\? undefined,\s*\)/,
      path,
    );
  }
});
