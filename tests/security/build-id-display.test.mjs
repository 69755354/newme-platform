import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL("../../" + path, import.meta.url), "utf8");

test("sidebar displays the full runtime BUILD_ID", async () => {
  const [health, sidebar] = await Promise.all([
    read("src/app/api/health/route.ts"),
    read("src/components/dashboard/DashboardSidebar.tsx"),
  ]);
  assert.ok(health.includes('fs.readFileSync(p, "utf-8").trim()') || health.includes('fs.readFileSync(buildIdPath, "utf-8").trim()'));
  assert.equal(health.includes(".slice(0, 12)"), false);
  assert.ok(sidebar.includes('fetch("/api/health")'));
  assert.ok(sidebar.includes("v{buildId}"));
});