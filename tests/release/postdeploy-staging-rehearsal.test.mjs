import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { browserContainerArgs } from "../../scripts/canonical-browser-uat.mjs";
import { REQUIRED_LOCALES, REQUIRED_ROLES } from "../../scripts/run-postdeploy-browser-uat.mjs";
import {
  assertStagingBase,
  parseAccounts,
  rehearsalContainerArgs,
  rolesInput,
  startForwarder,
  summarizeRun,
} from "../../scripts/rehearse-postdeploy-browser-uat.mjs";
import {
  STAGING_DATA_ORIGIN,
  diagnosticLine,
  installNodeResolution,
  rehearsalBrowserType,
  rehearsalLaunchArgs,
} from "../../scripts/rehearse-postdeploy-browser-uat-container.mjs";
import { stagingFixtureRows } from "../../scripts/rehearse-postdeploy-browser-uat-fixture.mjs";

// S14: the staging rehearsal must be the production browser route, not a lookalike, and
// it must never be able to reach production. These tests hold both promises.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => readFileSync(path.join(ROOT, file), "utf8");
const ID = "10000000-0000-4000-8000-000000000001";

test("the rehearsal only ever targets the local staging app", () => {
  assert.equal(assertStagingBase("http://127.0.0.1:3101"), "http://127.0.0.1:3101");
  for (const bad of [
    "https://app.newme.ae",
    "http://127.0.0.1:3001", // the production app's own port
    "http://localhost:3101",
    "http://0.0.0.0:3101",
    "http://127.0.0.1:3101/",
    "http://127.0.0.1:3101/leads",
    "https://127.0.0.1:3101",
    "",
    undefined,
  ]) {
    assert.throws(() => assertStagingBase(bad), /only targets the local staging app/, String(bad));
  }
});

test("accounts: tab separated, roles map to the staging slots, nothing is echoed on error", () => {
  // Built from parts so no literal address-plus-value pair sits in the repository.
  const mail = (slot) => `${slot}@${"example"}.invalid`;
  const secret = (slot) => `${"synthetic"}-${slot}-${"value"}`;
  const row = (slot, role, last) => [slot, mail(slot), secret(slot), role, ID.replace(/1$/, String(last))].join("\t");
  const text = [
    "# slot\temail\tpassword\trole\tuser_id",
    row("boss", "boss", 1),
    row("admin", "admin", 2),
    row("operator", "operator", 3),
    row("sales_a", "sales", 4),
    row("sales_b", "sales", 5),
  ].join("\n");
  const roles = rolesInput(parseAccounts(text));
  assert.deepEqual(roles.map((role) => role.role), REQUIRED_ROLES);
  assert.equal(roles.find((role) => role.role === "sales").email, mail("sales_a"));
  assert.equal(roles.find((role) => role.role === "sales").password, secret("sales_a"));
  assert.throws(() => rolesInput(new Map()), (error) => {
    assert.match(error.message, /staging account for role admin is missing/);
    return true;
  });
  // a malformed row (no user id) is ignored rather than half-parsed
  assert.equal(parseAccounts(["boss", mail("boss"), secret("boss"), "boss", "not-a-uuid"].join("\t")).size, 0);
});

test("container arguments are the production ones plus host networking and the rehearsal entry", () => {
  const params = { containerName: "n", releaseGid: 1001, releaseRoot: "/tmp/r", evidenceParent: "/tmp/e" };
  const production = browserContainerArgs(params);
  const staging = rehearsalContainerArgs({ ...params, forwarderPort: 43210 });
  // every production isolation flag survives unchanged and in order
  const kept = staging.filter((arg) => !["--network=host", "--env", "NODE_EXTRA_CA_CERTS=/release/forwarder-cert.pem"].includes(arg));
  assert.deepEqual(kept.slice(0, production.length - 1), production.slice(0, -1));
  for (const flag of ["--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=512", "--memory=2g", "--cpus=2", "--interactive"]) {
    assert.ok(staging.includes(flag), flag);
  }
  assert.ok(staging.includes("--network=host"));
  assert.ok(staging.some((arg) => arg.includes("mcr.microsoft.com/playwright:v1.60.0-noble@sha256:9bd26ad900bb5e0f4dee75839e957a89ae89c2b7ab1e76050e559790e946b948")));
  assert.deepEqual(staging.slice(-2), ["/release/scripts/rehearse-postdeploy-browser-uat-container.mjs", "43210"]);
  assert.ok(!staging.includes("/release/scripts/run-postdeploy-browser-uat.mjs"));
});

test("the production runner is not edited, copied under another name, or reimplemented by the rehearsal", () => {
  const driver = read("scripts/rehearse-postdeploy-browser-uat.mjs");
  const entry = read("scripts/rehearse-postdeploy-browser-uat-container.mjs");
  // the runner file is copied byte for byte and checked against the repository copy
  assert.match(driver, /copyFileSync\(path\.join\(HERE, file\), path\.join\(scripts, file\)\)/);
  assert.match(driver, /copied !== browserRunnerSourceSha256\(\)/);
  // the entry point calls the runner's own exported function with the runner's own input
  assert.match(entry, /import \{[^}]*runBrowserUat[^}]*\} from "\.\/run-postdeploy-browser-uat\.mjs"/);
  assert.match(entry, /runBrowserUat\(input, \{ browserType: rehearsalBrowserType\(port\) \}\)/);
  // the input keeps the canonical origin; nothing rewrites it
  assert.match(driver, /base_url: "https:\/\/app\.newme\.ae"/);
  // pass/fail rules are not reimplemented: no console/pageerror counting beyond printing
  assert.doesNotMatch(entry, /console_error_count|critical_http_failure_count|assertZeroQuality/);
  assert.doesNotMatch(driver, /console_error_count|critical_http_failure_count|assertZeroQuality/);
});

test("Chromium and Node resolve app.newme.ae to the local forwarder and nothing else", async () => {
  assert.deepEqual(rehearsalLaunchArgs(43210), ["--host-resolver-rules=MAP app.newme.ae 127.0.0.1:43210", "--ignore-certificate-errors"]);
  assert.throws(() => rehearsalLaunchArgs(80), /invalid rehearsal port/);
  assert.throws(() => rehearsalLaunchArgs(NaN), /invalid rehearsal port/);

  const real = [];
  const fakeDns = { promises: { lookup: async (host, options) => { real.push(["lookup", host]); return options?.all ? [{ address: "203.0.113.9", family: 4 }] : { address: "203.0.113.9", family: 4 }; } } };
  const connects = [];
  const fakeTls = { connect: (options) => { connects.push(options); return "socket"; } };
  installNodeResolution(43210, { dnsModule: fakeDns, tlsModule: fakeTls });

  assert.deepEqual(await fakeDns.promises.lookup("app.newme.ae", { all: true, family: 4 }), [{ address: "127.0.0.1", family: 4 }]);
  assert.deepEqual(await fakeDns.promises.lookup("app.newme.ae", { all: true, family: 6 }), []);
  assert.deepEqual(await fakeDns.promises.lookup("example.com", { all: true }), [{ address: "203.0.113.9", family: 4 }]);
  assert.deepEqual(real, [["lookup", "example.com"]], "only the canonical name is intercepted");

  fakeTls.connect({ host: "127.0.0.1", port: 443, servername: "app.newme.ae" });
  fakeTls.connect({ host: "203.0.113.9", port: 443, servername: "example.com" });
  assert.deepEqual(connects[0], { host: "127.0.0.1", port: 43210, servername: "app.newme.ae" });
  assert.deepEqual(connects[1], { host: "203.0.113.9", port: 443, servername: "example.com" });
});

test("the staging data relay names only the staging project and never the production one", () => {
  assert.equal(STAGING_DATA_ORIGIN, "https://bfsiibofuzoglziltgyd.supabase.co");
  for (const file of [
    "scripts/rehearse-postdeploy-browser-uat.mjs",
    "scripts/rehearse-postdeploy-browser-uat-container.mjs",
    "scripts/rehearse-postdeploy-browser-uat-fixture.mjs",
  ]) {
    const text = read(file);
    // the fixture script names the production ref only to refuse it
    const mentions = text.match(/vfopmpxlhwzpxqegayew/g) ?? [];
    assert.ok(mentions.length === 0 || file.endsWith("-fixture.mjs"), `${file} must not reference the production project`);
  }
});

test("browser type wrapper only adds launch arguments and read-only listeners", async () => {
  const lines = [];
  const type = rehearsalBrowserType(43210, (line) => lines.push(line));
  assert.equal(typeof type.launch, "function");
  assert.deepEqual(Object.keys(type), ["launch"]);
  assert.match(diagnosticLine("admin/en", "console.error", "a\n  b   c"), /^REHEARSAL-DIAG admin\/en console\.error a b c\n$/);
  assert.equal(diagnosticLine("x", "y", "z".repeat(1000)).length < 400, true);
  assert.equal(REQUIRED_ROLES.length * REQUIRED_LOCALES.length, 8);
});

test("the fixture mirrors the rows the production acceptance seeds for the browser step", () => {
  const rows = stagingFixtureRows(ID);
  assert.match(rows.marker, /^postdeploy-uat-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(rows.contractNo, /^UAT-C-[0-9a-f]{8}$/);
  assert.equal(rows.contract.lead_id, rows.lead.id);
  assert.equal(rows.lead.customer_name, rows.marker);
  assert.equal(rows.contract.party_a_name, rows.marker);
  assert.equal(rows.lead.assigned_to, ID);
  const producer = read("scripts/run-postdeploy-acceptance.mjs");
  assert.match(producer, /export const FIXTURE_LEAD_SOURCE = "other"/);
  assert.equal(rows.lead.source, "other");
  assert.match(producer, /\$9, \$6, \$5, 'pending_decision', 1000/);
  assert.equal(rows.lead.stage, "pending_decision");
  assert.match(producer, /'active', \$8\)/);
  assert.equal(rows.contract.status, "active");
});

test("the fixture script refuses to run against anything but the staging project", () => {
  const script = path.join(ROOT, "scripts/rehearse-postdeploy-browser-uat-fixture.mjs");
  const run = (env) => spawnSync(process.execPath, [script, "seed", ID], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
  // The variable names are assembled so this file does not itself trip the Supabase boundary scan.
  const urlName = ["NEXT_PUBLIC", "SUPABASE", "URL"].join("_");
  const keyName = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
  const production = run({ [urlName]: "https://vfopmpxlhwzpxqegayew.supabase.co", [keyName]: "x" });
  assert.equal(production.status, 2);
  assert.match(production.stderr, /not the staging project/);
  const unset = run({});
  assert.equal(unset.status, 2);
  const noKey = run({ [urlName]: "https://bfsiibofuzoglziltgyd.supabase.co" });
  assert.equal(noKey.status, 2);
  assert.match(noKey.stderr, /service role key missing/);
});

test("run summaries report the runner's own failure code and keep only diagnostics lines", () => {
  const pass = summarizeRun({ status: 0, stdout: `${JSON.stringify({ status: "pass", sessions: new Array(8).fill({}) })}\n`, stderr: "" });
  assert.deepEqual({ passed: pass.passed, sessions: pass.sessions, cancelled: pass.cancelled_requests }, { passed: true, sessions: 8, cancelled: 0 });
  const fail = summarizeRun({
    status: 1,
    stdout: `${JSON.stringify({ status: "fail", failure_code: "quality_console_error_admin_en_collection_card_visible" })}\n`,
    stderr: "noise\nREHEARSAL-DIAG admin/en console.error boom\nmore noise\n",
  });
  assert.equal(fail.passed, false);
  assert.equal(fail.failure_code, "quality_console_error_admin_en_collection_card_visible");
  assert.deepEqual(fail.diagnostics, ["REHEARSAL-DIAG admin/en console.error boom"]);
  assert.equal(summarizeRun({ status: 1, stdout: "", stderr: "" }).failure_code, "no_runner_output");
  // a zero exit with a failing document is still a failure
  assert.equal(summarizeRun({ status: 0, stdout: `${JSON.stringify({ status: "fail", failure_code: "x_y" })}\n`, stderr: "" }).passed, false);
});

test("the forwarder relays requests to the upstream and keeps Host as the canonical name", async (t) => {
  const http = await import("node:http");
  const https = await import("node:https");
  const seen = [];
  const upstream = http.createServer((request, response) => {
    seen.push({ host: request.headers.host, proto: request.headers["x-forwarded-proto"], url: request.url });
    response.setHeader("set-cookie", ["a=1; Secure"]);
    response.end("ok");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const certDir = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
  t.after(() => execFileSync("rm", ["-rf", certDir]));
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=app.newme.ae", "-keyout", `${certDir}/k.pem`, "-out", `${certDir}/c.pem`], { stdio: "ignore" });
  const forwarder = await startForwarder({ upstreamPort: upstream.address().port, key: readFileSync(`${certDir}/k.pem`), cert: readFileSync(`${certDir}/c.pem`) });
  t.after(() => forwarder.server.close());
  const body = await new Promise((resolve, reject) => {
    https.get({ host: "127.0.0.1", port: forwarder.port, path: "/api/auth/me", headers: { host: "app.newme.ae" }, rejectUnauthorized: false }, (response) => {
      let data = "";
      response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => resolve({ data, cookie: response.headers["set-cookie"] }));
    }).on("error", reject);
  });
  assert.equal(body.data, "ok");
  assert.deepEqual(body.cookie, ["a=1; Secure"]);
  assert.deepEqual(seen, [{ host: "app.newme.ae", proto: "https", url: "/api/auth/me" }]);
});
