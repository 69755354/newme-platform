import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("lead list does not cache deleted records", async () => {
  const source = await readFile(
    new URL("../../src/app/api/leads/list/route.ts", import.meta.url),
    "utf8",
  );
  assert.equal(source.includes('from "@/lib/api-cache"'), false);
  assert.equal(source.includes("getCached("), false);
  assert.equal(source.includes("setCache("), false);
});