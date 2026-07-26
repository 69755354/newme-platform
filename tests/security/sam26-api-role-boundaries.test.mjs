import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const read = (file) => fs.readFile(new URL(`../../${file}`, import.meta.url), "utf8");

function assertFailClosedBeforeCache(source, {
  rolesName,
  roles,
  roleExpression,
}) {
  const declaration = `const ${rolesName} = new Set([${roles.map((role) => `"${role}"`).join(", ")}])`;
  const declarationIndex = source.indexOf(declaration);
  assert.notEqual(declarationIndex, -1, `${rolesName} must declare the exact allowlist`);

  const gate = `if (!${rolesName}.has(${roleExpression}))`;
  const gateIndex = source.indexOf(gate);
  assert.notEqual(gateIndex, -1, `${rolesName} must reject roles outside the allowlist`);

  const forbiddenIndex = source.indexOf('status: 403', gateIndex);
  assert.notEqual(forbiddenIndex, -1, `${rolesName} must return HTTP 403`);

  const cacheIndex = source.indexOf("const cacheKey");
  assert.ok(
    cacheIndex === -1 || forbiddenIndex < cacheIndex,
    `${rolesName} must reject before reading a response cache`,
  );
}

test("sales workspace APIs fail closed for finance and designer", async () => {
  const [workbench, pipeline] = await Promise.all([
    read("src/app/api/workbench/route.ts"),
    read("src/app/api/pipeline/list/route.ts"),
  ]);

  assertFailClosedBeforeCache(workbench, {
    rolesName: "WORKBENCH_ROLES",
    roles: ["sales"],
    roleExpression: "profile.role",
  });
  assertFailClosedBeforeCache(pipeline, {
    rolesName: "PIPELINE_ROLES",
    roles: ["admin", "boss", "operator", "sales"],
    roleExpression: "role",
  });
});

test("aggregate APIs never treat an unknown non-sales role as management", async () => {
  const [dashboard, analytics] = await Promise.all([
    read("src/app/api/dashboard/summary/route.ts"),
    read("src/app/api/analytics/summary/route.ts"),
  ]);

  assertFailClosedBeforeCache(dashboard, {
    rolesName: "DASHBOARD_ROLES",
    roles: ["admin", "boss", "operator", "sales"],
    roleExpression: "role",
  });
  assertFailClosedBeforeCache(analytics, {
    rolesName: "ANALYTICS_ROLES",
    roles: ["admin", "boss", "operator", "sales"],
    roleExpression: "role",
  });
});
