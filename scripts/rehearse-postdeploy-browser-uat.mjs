#!/usr/bin/env node
// STAGING ONLY. Rehearses the browser half of the post-deploy production acceptance
// against the staging app, before a release goes anywhere near production.
//
// Why it exists: the production acceptance (scripts/run-postdeploy-browser-uat.mjs)
// walks every role in both languages and fails on ANY console error. Two releases in
// a row were rolled back for a problem that only that route could see. This runs the
// SAME runner file, byte for byte, in the SAME pinned Playwright image and container
// limits as production, so the route can be passed on staging first.
//
// How the staging app is reached without editing the runner:
//   * the runner insists on https://app.newme.ae; Chromium inside the container maps
//     that name to a local TLS forwarder (a throwaway self-signed certificate, port
//     chosen here), which relays to the staging app on 127.0.0.1:310x. The app sees
//     Host: app.newme.ae, so its own origin and secure-cookie rules behave as they do
//     in production.
//   * the runner's fixture (one lead, one contract) is seeded into the STAGING
//     database by scripts/rehearse-postdeploy-browser-uat-fixture.mjs and removed after.
//
// Run parts of the production acceptance that are NOT rehearsed here (they need
// production credentials, the signing key, or run on the release host):
//   - the business-flow producer (scripts/run-postdeploy-acceptance.mjs): seeds fixtures
//     in the production database and drives lead -> contract -> payment flows;
//   - the signed receipt: this uses a throwaway key, the artifacts are discarded;
//   - the release host checks (immutable asset ownership/mode, deployment evidence,
//     attest/finalize), and the Cloudflare-injected analytics script.
//
// Usage:  node scripts/rehearse-postdeploy-browser-uat.mjs [--runs N] [--base http://127.0.0.1:3101]
//         [--accounts FILE] [--log FILE]
// Needs: sudo (docker, fixture seeding as root), the pinned image already pulled,
// the staging accounts file (tab separated: slot, email, password, role, user id).
// Output never contains passwords; a failing run prints the runner's failure code and
// the console/page errors the browser saw (staging data only).
import { execFileSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { browserContainerArgs } from "./canonical-browser-uat.mjs";
import { INPUT_VERSION, REQUIRED_ROLES, browserRunnerSourceSha256 } from "./run-postdeploy-browser-uat.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const DEFAULT_ACCOUNTS = "/home/claude-ops/.config/newme/staging-qa-accounts.txt";
const STAGING_ENV = "/etc/newme-staging/staging.env";
const CONTAINER_ENTRY = "scripts/rehearse-postdeploy-browser-uat-container.mjs";
const FIXTURE_SCRIPT = path.join(HERE, "rehearse-postdeploy-browser-uat-fixture.mjs");
const STAGING_BASE = /^http:\/\/127\.0\.0\.1:31[0-9]{2}$/;
const SLOT_FOR_ROLE = Object.freeze({ admin: "admin", boss: "boss", operator: "operator", sales: "sales_a" });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function assertStagingBase(base) {
  if (typeof base !== "string" || !STAGING_BASE.test(base)) {
    throw new Error("rehearsal only targets the local staging app (http://127.0.0.1:310x)");
  }
  return base;
}

/** Tab separated: slot, email, password, role, user id. Comment lines start with '#'. */
export function parseAccounts(text) {
  const accounts = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [slot, email, password, role, userId] = line.split("\t");
    if (slot && email && password && role && UUID.test(userId ?? "")) accounts.set(slot, { email, password, role, actor_id: userId });
  }
  return accounts;
}

export function rolesInput(accounts) {
  return REQUIRED_ROLES.map((role) => {
    const account = accounts.get(SLOT_FOR_ROLE[role]);
    if (!account) throw new Error(`staging account for role ${role} is missing`);
    return { role, actor_id: account.actor_id, email: account.email, password: account.password };
  });
}

/** The production container arguments, plus host networking and the rehearsal entry point. */
export function rehearsalContainerArgs({ containerName, releaseGid, releaseRoot, evidenceParent, forwarderPort }) {
  const production = browserContainerArgs({ containerName, releaseGid, releaseRoot, evidenceParent });
  const runner = production.pop();
  if (!runner.endsWith("scripts/run-postdeploy-browser-uat.mjs")) throw new Error("unexpected production container arguments");
  const [run, ...rest] = production;
  // NODE_EXTRA_CA_CERTS: the runner's Node-side identity reads must trust the throwaway certificate.
  return [run, "--network=host", "--env", "NODE_EXTRA_CA_CERTS=/release/forwarder-cert.pem", ...rest, `/release/${CONTAINER_ENTRY}`, String(forwarderPort)];
}

/** TLS forwarder: app.newme.ae (as seen by the browser) -> the staging app. */
export function startForwarder({ upstreamPort, key, cert }) {
  const server = https.createServer({ key, cert }, (request, response) => {
    const upstream = http.request(
      { host: "127.0.0.1", port: upstreamPort, method: request.method, path: request.url, headers: { ...request.headers, "x-forwarded-proto": "https" } },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.on("aborted", () => upstream.destroy());
    response.on("close", () => { if (!response.writableFinished) upstream.destroy(); });
    request.pipe(upstream);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function selfSignedCertificate(directory) {
  const keyFile = path.join(directory, "key.pem");
  const certFile = path.join(directory, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "2",
    "-subj", "/CN=app.newme.ae", "-addext", "subjectAltName=DNS:app.newme.ae", "-keyout", keyFile, "-out", certFile,
  ], { stdio: "ignore" });
  return { key: readFileSync(keyFile), cert: readFileSync(certFile) };
}

/** A release-shaped directory: the production runner copied byte for byte, plus what it imports. */
function prepareReleaseRoot(directory) {
  const scripts = path.join(directory, "scripts");
  mkdirSync(scripts, { recursive: true });
  for (const file of ["run-postdeploy-browser-uat.mjs", "postdeploy-receipt.mjs", "rehearse-postdeploy-browser-uat-container.mjs"]) {
    copyFileSync(path.join(HERE, file), path.join(scripts, file));
  }
  const copied = createHash("sha256").update(readFileSync(path.join(scripts, "run-postdeploy-browser-uat.mjs"))).digest("hex");
  if (copied !== browserRunnerSourceSha256()) throw new Error("runner copy differs from the production runner");
  for (const mod of ["playwright", "playwright-core"]) cpSync(path.join(REPO, "node_modules", mod), path.join(directory, "node_modules", mod), { recursive: true, dereference: true });
  writeFileSync(path.join(directory, "package.json"), '{"type":"module"}\n');
  execFileSync("chmod", ["-R", "a+rX", directory]);
}

// The container writes its evidence as its own user, so the tree needs root to remove.
function removeTree(directory) {
  if (!directory.startsWith(`${tmpdir()}${path.sep}s14-rehearsal-`)) throw new Error("refusing to remove an unexpected path");
  try { sudo(["rm", "-rf", "--one-file-system", directory]); } catch { /* best effort */ }
}

function sudo(args, options = {}) {
  return execFileSync("sudo", ["-n", ...args], { encoding: "utf8", ...options });
}

function seedFixture(salesId) {
  const out = sudo(["node", `--env-file=${STAGING_ENV}`, FIXTURE_SCRIPT, "seed", salesId]);
  const fixture = JSON.parse(out.trim().split("\n").at(-1));
  if (!UUID.test(fixture.lead_id) || !UUID.test(fixture.contract_id)) throw new Error("fixture seed returned unexpected ids");
  return fixture;
}

function cleanupFixture(fixture) {
  try { sudo(["node", `--env-file=${STAGING_ENV}`, FIXTURE_SCRIPT, "cleanup", fixture.lead_id, fixture.contract_id]); } catch { /* staging data is disposable */ }
}

function runContainer(args, inputText) {
  return new Promise((resolve) => {
    const child = spawn("sudo", ["-n", "/usr/bin/docker", ...args], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.stdin.on("error", () => {});
    child.on("close", (status) => resolve({ status, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    child.stdin.end(inputText);
  });
}

export function summarizeRun({ status, stdout, stderr }) {
  let output = null;
  try { output = JSON.parse(stdout.trim().split("\n").at(-1)); } catch { /* handled below */ }
  const diag = stderr.split("\n").filter((line) => line.startsWith("REHEARSAL-DIAG "));
  const passed = status === 0 && output?.status === "pass";
  return {
    passed,
    failure_code: passed ? null : (output?.failure_code ?? "no_runner_output"),
    sessions: passed ? (output.sessions?.length ?? 0) : null,
    diagnostics: diag,
  };
}

function parseArgs(argv) {
  const options = { runs: 1, base: "http://127.0.0.1:3101", accounts: DEFAULT_ACCOUNTS, log: null };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === "--runs") options.runs = Number(value);
    else if (flag === "--base") options.base = value;
    else if (flag === "--accounts") options.accounts = value;
    else if (flag === "--log") options.log = value;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 50) throw new Error("--runs must be 1..50");
  assertStagingBase(options.base);
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const say = (line) => { process.stdout.write(`${line}\n`); if (options.log) appendFileSync(options.log, `${line}\n`); };
  const upstreamPort = Number(new URL(options.base).port);
  const accounts = parseAccounts(readFileSync(options.accounts, "utf8"));
  const roles = rolesInput(accounts);
  const salesId = roles.find((role) => role.role === "sales").actor_id;

  const work = mkdtempSync(path.join(tmpdir(), "s14-rehearsal-"));
  const releaseRoot = path.join(work, "release");
  const certificate = selfSignedCertificate(work);
  prepareReleaseRoot(releaseRoot);
  writeFileSync(path.join(releaseRoot, "forwarder-cert.pem"), certificate.cert);
  execFileSync("chmod", ["a+r", path.join(releaseRoot, "forwarder-cert.pem")]);
  const forwarder = await startForwarder({ upstreamPort, ...certificate });
  const gid = Number(execFileSync("id", ["-g"], { encoding: "utf8" }).trim());
  say(`rehearsal start ${new Date().toISOString()} runs=${options.runs} base=${options.base} runner_sha256=${browserRunnerSourceSha256()}`);
  let passes = 0;
  try {
    for (let run = 1; run <= options.runs; run += 1) {
      const fixture = seedFixture(salesId);
      const evidenceParent = path.join(work, `evidence-${run}`);
      mkdirSync(evidenceParent);
      chmodSync(evidenceParent, 0o777);
      const containerName = `newme-rehearsal-${randomUUID()}`;
      const input = {
        input_version: INPUT_VERSION,
        base_url: "https://app.newme.ae",
        release: { git_sha: "0".repeat(40), build_id: "rehearsal", deploy_run_id: "1", deployed_at: new Date().toISOString().replace(/\.\d+Z$/, "Z") },
        fixture,
        artifact_directory: "/evidence/output",
        receipt_private_key_pem: generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }),
        roles,
      };
      const started = Date.now();
      const result = summarizeRun(await runContainer(
        rehearsalContainerArgs({ containerName, releaseGid: gid, releaseRoot, evidenceParent, forwarderPort: forwarder.port }),
        JSON.stringify(input),
      ));
      cleanupFixture(fixture);
      removeTree(evidenceParent);
      if (result.passed) passes += 1;
      say(`run ${run}/${options.runs}: ${result.passed ? `PASS (${result.sessions} sessions)` : `FAIL ${result.failure_code}`} in ${Math.round((Date.now() - started) / 1000)}s`);
      for (const line of result.diagnostics) say(`  ${line}`);
    }
  } finally {
    forwarder.server.close();
    removeTree(work);
  }
  say(`rehearsal result: ${passes}/${options.runs} passed`);
  return passes === options.runs ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
