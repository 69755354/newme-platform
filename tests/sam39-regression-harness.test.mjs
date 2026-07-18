import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("SAM-39 deploy verification defaults to the versioned regression harness", () => {
  const deployVerify = read("scripts/deploy-verify.sh");

  assert.match(
    deployVerify,
    /REGRESSION_SCRIPT="\$\{CRM_REGRESSION_SCRIPT:-\$SCRIPT_DIR\/crm-regression\.py\}"/,
  );
  assert.doesNotMatch(deployVerify, /\/home\/ubuntu\/\.hermes/);
  assert.match(deployVerify, /test -r "\$REGRESSION_SCRIPT"/);

  const deploy = read("scripts/deploy.sh");
  const gitignore = read(".gitignore");
  assert.match(deploy, /CRM_REGRESSION_RESULT_FILE/);
  assert.match(deploy, /json\.load/);
  assert.doesNotMatch(deploy, /EVI_REGRESSION_PASSED=23/);
  assert.match(gitignore, /^\.audit\/$/m);
});

test("SAM-39 regression harness has an offline executable contract", () => {
  const result = spawnSync("python3", ["scripts/crm-regression.py", "--self-test"], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /contract self-test passed/);
});

test("SAM-39 CI executes the versioned contract", () => {
  const workflow = read(".github/workflows/ci.yml");
  assert.match(workflow, /python3 scripts\/crm-regression\.py --self-test/);
});

test("SAM-39 keeps candidate eligibility separate from historical identity", () => {
  const harness = read("scripts/crm-regression.py");

  assert.match(harness, /SALES_CAPABLE_ROLES = \{"sales", "operator", "boss"\}/);
  assert.match(harness, /profile\.get\("is_active"\) is True/);
  assert.match(harness, /profiles_by_id = \{profile\["id"\]: profile for profile in profiles\}/);
  assert.match(harness, /historical_owner_name\(lead, profiles_by_id\)/);
  assert.match(harness, /src\/app\/api\/leads\/list\/route\.ts/);
  assert.match(harness, /\.in\("role", \["sales", "operator", "boss"\]\)/);
  assert.match(harness, /\.eq\("is_active", true\)/);
  assert.doesNotMatch(harness, /all users active|所有用户活跃/);
});
