import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("bearer fallback authenticates its service-scoped profile lookup", async () => {
  const proxy = await readFile(new URL("../../src/proxy.ts", import.meta.url), "utf8");
  const fallback = proxy.slice(proxy.indexOf("if (usedBearerFallback)"), proxy.indexOf("if (profileErr)", proxy.indexOf("if (usedBearerFallback)")));
  assert.match(fallback, /apikey: serviceRoleKey/);
  assert.match(fallback, /Authorization: `Bearer \$\{serviceRoleKey\}`/);
  assert.match(proxy, /return authUnavailable\(request, isApiRequest\)/);
});
