import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { validateSupplyChain } from "../../scripts/check-supply-chain.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const XREF = path.join(ROOT, "scripts/_supply_chain_xref.py");
const GATE = path.join(ROOT, "scripts/check-supply-chain.sh");
const advisory = (id = "GHSA-qx2v-qp2m-jg93") => ({
  source: 123456,
  name: "postcss",
  dependency: "postcss",
  title: "fixture advisory",
  url: `https://github.com/advisories/${id}`,
  severity: "high",
  range: "<8.4.31",
});

const audit = (id) => ({
  auditReportVersion: 2,
  vulnerabilities: {
    next: {
      name: "next",
      severity: "high",
      isDirect: true,
      via: ["postcss"],
      effects: [],
      range: "*",
      nodes: ["node_modules/next"],
      fixAvailable: false,
    },
    postcss: {
      name: "postcss",
      severity: "high",
      isDirect: false,
      via: [advisory(id)],
      effects: ["next"],
      range: "*",
      nodes: ["node_modules/next/node_modules/postcss"],
      fixAvailable: false,
    },
  },
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 2, critical: 0, total: 2 },
    dependencies: { prod: 2, dev: 0, optional: 0, peer: 0, peerOptional: 0, total: 2 },
  },
});

const accepted = (overrides = {}) => ({
  accepted: [{
    package: "postcss",
    vuln_id: "GHSA-qx2v-qp2m-jg93",
    severity: "high",
    risk_reason: "Fixture has no attacker-controlled CSS input.",
    mitigation: "Only trusted build-time CSS is processed.",
    owner: "security-owner",
    expires: "2999-01-01",
    audit_ref: "docs/security.md#fixture",
    ...overrides,
  }],
});

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "newme-supply-chain-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runXref(auditJson, acceptedJson) {
  return withTempDir(async (dir) => {
    const auditFile = path.join(dir, "audit.json");
    const acceptFile = path.join(dir, "accept.json");
    await writeFile(auditFile, JSON.stringify(auditJson));
    await writeFile(acceptFile, JSON.stringify(acceptedJson));
    return spawnSync("python3", [XREF, auditFile, acceptFile], { encoding: "utf8" });
  });
}

async function makeGateFixture(dir, auditPayload, acceptPayload) {
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await mkdir(path.join(dir, "node_modules/xlsx"), { recursive: true });
  await mkdir(path.join(dir, "fake-bin"), { recursive: true });
  await cp(GATE, path.join(dir, "scripts/check-supply-chain.sh"));
  await cp(XREF, path.join(dir, "scripts/_supply_chain_xref.py"));
  await writeFile(path.join(dir, "package.json"), JSON.stringify({
    packageManager: "npm@10.0.0",
    engines: { node: process.versions.node, npm: "10.0.0" },
    dependencies: { next: "16.2.12", react: "19.2.4", "react-dom": "19.2.4" },
  }));
  await writeFile(path.join(dir, "package-lock.json"), "{}\n");
  await writeFile(path.join(dir, ".nvmrc"), `${process.versions.node.split(".")[0]}\n`);
  await writeFile(path.join(dir, ".supply-chain-accept.json"), JSON.stringify(acceptPayload));
  await cp(
    path.join(ROOT, "node_modules/xlsx/package.json"),
    path.join(dir, "node_modules/xlsx/package.json"),
  );
  await writeFile(path.join(dir, "audit.json"), typeof auditPayload === "string" ? auditPayload : JSON.stringify(auditPayload));

  const fakeNpm = path.join(dir, "fake-bin/npm");
  await writeFile(fakeNpm, `#!/usr/bin/env bash\nset -euo pipefail\ncase "\${1:-}" in\n  --version) echo 10.0.0 ;;\n  ls) exit 0 ;;\n  audit) cat "\${FAKE_AUDIT_FILE}"; exit "\${FAKE_AUDIT_RC:-1}" ;;\n  *) exit 2 ;;\nesac\n`);
  await chmod(fakeNpm, 0o755);

}

async function runGate({ auditPayload, acceptPayload = accepted(), acceptKnown = true }) {
  return withTempDir(async (dir) => {
    await makeGateFixture(dir, auditPayload, acceptPayload);
    return spawnSync("bash", ["scripts/check-supply-chain.sh", ...(acceptKnown ? ["--accept-known"] : [])], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${path.join(dir, "fake-bin")}${path.delimiter}${process.env.PATH}`,
        FAKE_AUDIT_FILE: path.join(dir, "audit.json"),
        FAKE_AUDIT_RC: "1",
      },
    });
  });
}

test.skip("legacy Python xref parity (superseded by Node gate contract)", async () => {
  const exact = await runXref(audit(), accepted());
  assert.equal(exact.status, 0, exact.stderr);
  assert.match(exact.stdout, /COUNT=0/);

  const wrongId = await runXref(audit(), accepted({ vuln_id: "GHSA-0000-0000-0000" }));
  assert.equal(wrongId.status, 0, wrongId.stderr);
  assert.doesNotMatch(wrongId.stdout, /COUNT=0/);
});

test.skip("legacy Python exception validation (superseded by Node gate contract)", async () => {
  const expired = await runXref(audit(), accepted({ expires: "2000-01-01" }));
  assert.notEqual(expired.status, 0);

  const incomplete = accepted();
  delete incomplete.accepted[0].owner;
  const missingOwner = await runXref(audit(), incomplete);
  assert.notEqual(missingOwner.status, 0);
});

test.skip("legacy Bash gate (superseded by Node gate contract)", async () => {
  const acceptedAudit = await runGate({ auditPayload: audit() });
  assert.equal(acceptedAudit.status, 0, acceptedAudit.stdout + acceptedAudit.stderr);

  const noException = await runGate({ auditPayload: audit(), acceptKnown: false });
  assert.notEqual(noException.status, 0);

  const expiredException = await runGate({
    auditPayload: audit(),
    acceptPayload: accepted({ expires: "2000-01-01" }),
  });
  assert.notEqual(expiredException.status, 0);

  const malformed = await runGate({ auditPayload: "not-json" });
  assert.notEqual(malformed.status, 0);

  const registryError = await runGate({
    auditPayload: { error: { code: "EAI_AGAIN", summary: "registry unavailable" } },
  });
  assert.notEqual(registryError.status, 0);
});

async function nodeGate(input = {}) {
  const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const packageLock = JSON.parse(await readFile(path.join(ROOT, "package-lock.json"), "utf8"));
  const exceptions = JSON.parse(await readFile(path.join(ROOT, ".supply-chain-accept.json"), "utf8"));
  const xlsx = await readFile(path.join(ROOT, "node_modules/xlsx/package.json"));
  return validateSupplyChain({
    packageJson,
    packageLock,
    exceptions,
    nvmrc: process.versions.node,
    nodeVersion: process.versions.node,
    npmVersion: packageJson.packageManager.slice(4),
    xlsxHash: createHash("sha256").update(xlsx).digest("hex"),
    audit: audit(),
    acceptKnown: true,
    ...input,
  });
}

test("Node supply-chain gate fails closed on malformed audit, registry failure, unaccepted advisory, stale exception, lock drift, hash drift, and version drift", async () => {
  assert.deepEqual(await nodeGate(), []);
  assert.notDeepEqual(await nodeGate({ audit: "not-json" }), []);
  assert.notDeepEqual(await nodeGate({ audit: { error: { code: "EAI_AGAIN" } } }), []);
  assert.notDeepEqual(await nodeGate({ acceptKnown: false }), []);
  assert.notDeepEqual(await nodeGate({ exceptions: accepted({ expires: "2000-01-01" }) }), []);
  assert.notDeepEqual(await nodeGate({ xlsxHash: "0".repeat(64) }), []);
  assert.notDeepEqual(await nodeGate({ nvmrc: "0.0.0" }), []);
  const packageLock = JSON.parse(await readFile(path.join(ROOT, "package-lock.json"), "utf8"));
  packageLock.packages[""].dependencies.next = "0.0.0";
  assert.notDeepEqual(await nodeGate({ packageLock }), []);
  const engineDriftLock = JSON.parse(await readFile(path.join(ROOT, "package-lock.json"), "utf8"));
  engineDriftLock.packages[""].engines.node = "24.14.1";
  assert.match(
    (await nodeGate({ packageLock: engineDriftLock })).join("\n"),
    /package-lock engines are not in sync/,
  );
});

async function listCodeFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listCodeFiles(fullPath));
    } else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

test("documented postcss and sharp mitigations remain unreachable at runtime", async () => {
  const sourceFiles = await listCodeFiles(path.join(ROOT, "src"));
  const nextImageImports = [];
  const postcssImports = [];

  for (const file of sourceFiles) {
    const source = await readFile(file, "utf8");
    if (/(?:from\s*|import\s*\()\s*["']next\/image["']/.test(source)) {
      nextImageImports.push(path.relative(ROOT, file));
    }
    if (/(?:from\s*|import\s*\()\s*["']postcss["']/.test(source)) {
      postcssImports.push(path.relative(ROOT, file));
    }
  }

  assert.deepEqual(nextImageImports, [], "next/image requires a new sharp risk review");
  assert.deepEqual(postcssImports, [], "runtime postcss requires a new input-boundary review");

  const nextConfig = await readFile(path.join(ROOT, "next.config.ts"), "utf8");
  assert.doesNotMatch(nextConfig, /\bimages\s*:/, "Next Image configuration requires a sharp risk review");
});

test("repository and CI use exact Node, npm, and critical dependency versions", async () => {
  const nvmrc = (await import("node:fs/promises")).readFile(path.join(ROOT, ".nvmrc"), "utf8");
  const workflow = (await import("node:fs/promises")).readFile(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const packageJson = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(ROOT, "package.json"), "utf8"));
  const gate = await readFile(path.join(ROOT, "scripts/check-supply-chain.mjs"), "utf8");
  const major = (await nvmrc).trim();

  assert.match(await workflow, new RegExp(`node-version: ['\"]${major}['\"]`));
  assert.equal(packageJson.engines.node, major);
  const npmVersion = packageJson.packageManager?.match(/^npm@(\d+\.\d+\.\d+)$/)?.[1];
  assert.ok(npmVersion, "packageManager must pin an exact npm version");
  assert.equal(packageJson.engines.npm, npmVersion);
  for (const name of ["next", "react", "react-dom"]) {
    assert.match(packageJson.dependencies[name], /^\d+\.\d+\.\d+$/);
  }
  assert.match(gate, /process\.env\.npm_execpath/);
  assert.match(gate, /spawnSync\(process\.execPath/);
});
