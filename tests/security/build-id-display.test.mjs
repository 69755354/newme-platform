import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL("../../" + path, import.meta.url), "utf8");

test("public liveness does not disclose runtime build metadata", async () => {
  const [health, sidebar] = await Promise.all([
    read("src/app/api/health/route.ts"),
    read("src/components/dashboard/DashboardSidebar.tsx"),
  ]);
  assert.equal(health.includes("process.env.NEXT_PUBLIC_APP_VERSION"), false);
  assert.equal(health.includes("readFileSync"), false);
  assert.equal(health.includes(".slice(0, 12)"), false);
  assert.equal(sidebar.includes('fetch("/api/health")'), false);
  assert.equal(sidebar.includes("v{buildId}"), false);
});
