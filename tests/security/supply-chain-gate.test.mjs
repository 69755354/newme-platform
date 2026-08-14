import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { validateSupplyChain } from "../../scripts/check-supply-chain.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
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
