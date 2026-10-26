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

  const deploy = read("scripts/deploy-immutable.sh");
  const gitignore = read(".gitignore");
  assert.match(deploy, /CRM_REGRESSION_RESULT_FILE/);
  assert.match(deploy, /deploy-verify\.sh/);
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
  assert.doesNotMatch(harness, /all users active|所有用户活跃/);
});

function runSyntheticAssignmentRegression(options = {}) {
  const script = `
import contextlib, importlib.util, io, json, sys, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("crm_regression", "scripts/crm-regression.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
options = json.load(sys.stdin)
class SyntheticRegression(module.Regression):
    def run_application_checks(self):
        self.check("synthetic health", not options.get("health_failure", False))
    def service_key_state(self):
        return "registered", ""
    def run_database_checks(self):
        return []
    def run_activity_checks(self):
        pass
    def run_source_checks(self):
        pass
    def db_query(self, table, select="id", limit=1):
        assert table == "leads"
        return True, [
            {"id": str(i), "assigned_to": None if i < options.get("unassigned", 31) else "synthetic-owner",
             "customer_name": None if options.get("missing_name", False) and i == 0 else "Synthetic"}
            for i in range(options.get("total", 107))
        ]
    def db_count(self, table):
        assert table == "notifications"
        return True, options.get("notifications", 0)
with tempfile.TemporaryDirectory(prefix="crm-warning-contract-") as directory:
    report = Path(directory) / "result.json"
    regression = SyntheticRegression(base_url="https://example.invalid", supabase_url="https://example.invalid",
        service_key="fictional", publishable_key="fictional", result_file=report, verbose=False)
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        exit_code = regression.run("pre-deploy")
    print(json.dumps({"exit_code": exit_code, "report": json.loads(report.read_text()), "output": output.getvalue()}))
`;
  const result = spawnSync("python3", ["-c", script], {
    cwd: root, encoding: "utf8", input: JSON.stringify(options),
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test("assignment backlog is a visible, persisted warning without a technical failure", () => {
  const result = runSyntheticAssignmentRegression();
  assert.equal(result.exit_code, 0);
  assert.equal(result.report.fail, 0);
  assert.deepEqual(result.report.errors, []);
  assert.equal(result.report.warnings.length, 1);
  assert.match(result.report.warnings[0], /31 条未分配 \/ 共 107/);
  assert.match(result.report.warnings[0], /21.4/);
  assert.match(result.output, /WARN: 业务告警/);
  assert.doesNotMatch(result.output, /Synthetic|synthetic-owner/);
});

test("assignment warning retains the 20 percent threshold and ten-record floor", () => {
  for (const options of [{ unassigned: 21 }, { total: 10, unassigned: 10 }]) {
    const result = runSyntheticAssignmentRegression(options);
    assert.equal(result.exit_code, 0);
    assert.deepEqual(result.report.warnings, []);
    assert.doesNotMatch(result.output, /WARN:/);
  }
  assert.equal(runSyntheticAssignmentRegression({ unassigned: 22 }).report.warnings.length, 1);
});

test("assignment warning never suppresses other technical or integrity failures", () => {
  for (const options of [{ health_failure: true }, { missing_name: true }, { notifications: 5001 }]) {
    const result = runSyntheticAssignmentRegression(options);
    assert.equal(result.exit_code, 1);
    assert.equal(result.report.fail, 1);
    assert.equal(result.report.errors.length, 1);
    assert.equal(result.report.warnings.length, 1);
    assert.match(result.output, /WARN: 业务告警/);
    assert.match(result.output, /1 失败/);
  }
});
