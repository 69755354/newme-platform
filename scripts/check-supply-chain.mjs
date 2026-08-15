import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADVISORY = /(?:GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}|CVE-\d{4}-\d{4,})/i;
const REQUIRED = ["package", "vuln_id", "severity", "risk_reason", "mitigation", "owner", "expires", "audit_ref"];
const XLSX_HASH = "7385d8ea33c4feaa85e0f27430f7631c142d07c0a052f9f5e73b5fddb88acbe8";
const ALTERNATIVE_LOCKFILES = ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];
const OFFICIAL_NPM_REGISTRY = "https://registry.npmjs.org/";
const EXPECTED_ALLOW_SCRIPTS = {
  "@sentry/cli@2.58.6": false,
  "core-js@3.49.0": false,
  "fsevents@2.3.2": false,
  "unrs-resolver@1.12.2": false,
};

function parse(value, label, failures) {
  try { return JSON.parse(value); } catch { failures.push(`${label} is not valid JSON`); return null; }
}

function exceptionKeys(document, failures) {
  if (!document || !Array.isArray(document.accepted)) { failures.push("accepted must be an array"); return new Set(); }
  const today = new Date().toISOString().slice(0, 10);
  const maximumExpiry = new Date(`${today}T00:00:00.000Z`);
  maximumExpiry.setUTCDate(maximumExpiry.getUTCDate() + 90);
  const keys = new Set();
  for (const [index, item] of document.accepted.entries()) {
    if (!item || typeof item !== "object") { failures.push(`accepted[${index}] must be an object`); continue; }
    for (const field of REQUIRED) if (typeof item[field] !== "string" || !item[field].trim()) failures.push(`accepted[${index}] missing ${field}`);
    const id = String(item.vuln_id || "").toUpperCase();
    if (!/^(?:GHSA-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}|CVE-\d{4}-\d{4,})$/.test(id)) failures.push(`accepted[${index}] invalid advisory`);
    if (!["high", "critical"].includes(String(item.severity).toLowerCase())) failures.push(`accepted[${index}] invalid severity`);
    const expiry = new Date(`${item.expires}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(item.expires))
      || Number.isNaN(expiry.getTime())
      || expiry.toISOString().slice(0, 10) !== item.expires
      || String(item.expires) < today) {
      failures.push(`accepted[${index}] expired or invalid`);
    } else if (expiry > maximumExpiry) {
      failures.push(`accepted[${index}] exceeds the 90-day maximum lifetime`);
    }
    const key = `${item.package}|${id}`;
    if (keys.has(key)) failures.push(`accepted[${index}] duplicate exception`);
    keys.add(key);
  }
  return keys;
}

function leaves(name, vulnerabilities, trail = new Set()) {
  if (trail.has(name)) return [[name, "DEPENDENCY-CYCLE"]];
  const entry = vulnerabilities[name];
  if (!entry || typeof entry !== "object" || !Array.isArray(entry.via) || !entry.via.length) return [[name, "UNKNOWN"]];
  const next = new Set(trail).add(name);
  return entry.via.flatMap((via) => {
    if (typeof via === "string") return leaves(via, vulnerabilities, next);
    if (!via || typeof via !== "object") return [[name, "UNKNOWN"]];
    const packageName = typeof via.name === "string" ? via.name : (typeof via.dependency === "string" ? via.dependency : name);
    const match = typeof via.url === "string" ? via.url.match(ADVISORY) : null;
    return [[packageName, match ? match[0].toUpperCase() : (via.source == null ? "UNKNOWN" : `NPM-${via.source}`)]];
  });
}

export function validateToolchain({ packageJson, packageLock, nvmrc, npmrc, nodeVersion, npmVersion, npmConfig, alternativeLockfiles = [] }) {
  const failures = [];
  if (alternativeLockfiles.length) {
    failures.push(`npm is the only declared package manager; remove alternative lockfile(s): ${alternativeLockfiles.join(", ")}`);
  }
  for (const dep of ["next", "react", "react-dom"]) if (!/^\d+\.\d+\.\d+$/.test(packageJson?.dependencies?.[dep] || "")) failures.push(`${dep} must be exact`);
  if (packageLock?.lockfileVersion !== 3) failures.push("package-lock must use lockfileVersion 3");
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    if (!packageLock?.packages?.[""]
      || JSON.stringify(packageLock.packages[""][field] || {}) !== JSON.stringify(packageJson?.[field] || {})) {
      failures.push(`package-lock ${field} are not in sync`);
    }
  }
  if (JSON.stringify(packageLock?.packages?.[""]?.engines) !== JSON.stringify(packageJson?.engines)) failures.push("package-lock engines are not in sync");
  if (JSON.stringify(packageJson?.allowScripts) !== JSON.stringify(EXPECTED_ALLOW_SCRIPTS)) {
    failures.push("dependency install-script approvals must match the reviewed exact-version policy");
  }
  const activeNpmrc = String(npmrc || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (JSON.stringify(activeNpmrc) !== JSON.stringify([
    `registry=${OFFICIAL_NPM_REGISTRY}`,
    "strict-allow-scripts=true",
  ])) {
    failures.push(".npmrc must pin the official npm registry and fail closed on every unreviewed dependency install script");
  }
  for (const [lockPath, entry] of Object.entries(packageLock?.packages || {})) {
    if (!lockPath) continue;
    if (!entry || typeof entry !== "object" || entry.link === true) {
      failures.push(`package-lock ${lockPath} must be a registry-backed package`);
      continue;
    }
    const resolved = String(entry.resolved || "");
    const integrity = String(entry.integrity || "");
    const isOfficialNpm = resolved.startsWith(OFFICIAL_NPM_REGISTRY);
    const isPinnedXlsx = lockPath === "node_modules/xlsx"
      && resolved === packageJson?.dependencies?.xlsx;
    if (!isOfficialNpm && !isPinnedXlsx) {
      failures.push(`package-lock ${lockPath} resolved origin is not approved`);
    }
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
      failures.push(`package-lock ${lockPath} must carry sha512 integrity`);
    }
  }
  if (
    npmConfig?.strictAllowScripts !== "true"
    || npmConfig?.dangerouslyAllowAllScripts !== "false"
    || npmConfig?.ignoreScripts !== "false"
    || npmConfig?.allowScripts !== ""
    || npmConfig?.omit !== ""
    || npmConfig?.registry !== OFFICIAL_NPM_REGISTRY
  ) {
    failures.push("effective npm install-script configuration is unsafe or overridden");
  }
  if (!/^\d+\.\d+\.\d+$/.test(nvmrc) || nodeVersion !== nvmrc) failures.push("Node version mismatch");
  const expectedNpm = packageJson?.packageManager?.match(/^npm@(\d+\.\d+\.\d+)$/)?.[1];
  if (!expectedNpm || packageJson?.engines?.npm !== expectedNpm || npmVersion !== expectedNpm) failures.push("npm version mismatch");
  return failures;
}

export function validateSupplyChain({ packageJson, packageLock, nvmrc, npmrc, nodeVersion, npmVersion, npmConfig, alternativeLockfiles = [], xlsxHash, audit, exceptions, acceptKnown }) {
  const failures = validateToolchain({ packageJson, packageLock, nvmrc, npmrc, nodeVersion, npmVersion, npmConfig, alternativeLockfiles });
  if (xlsxHash !== XLSX_HASH) failures.push("xlsx hash mismatch");
  const locked = packageLock?.packages?.["node_modules/xlsx"];
  if (!locked || locked.version !== "0.20.2" || locked.resolved !== packageJson?.dependencies?.xlsx || !locked.integrity) failures.push("xlsx lock mismatch");
  if (!audit || audit.auditReportVersion !== 2 || typeof audit.vulnerabilities !== "object" || !audit.metadata || typeof audit.metadata.vulnerabilities !== "object") {
    failures.push("audit JSON is incomplete or has an unsupported report version");
    return failures;
  }
  const severityNames = ["info", "low", "moderate", "high", "critical"];
  const metadataCounts = audit.metadata.vulnerabilities;
  const computedCounts = Object.fromEntries(severityNames.map((severity) => [severity, 0]));
  for (const [name, vulnerability] of Object.entries(audit.vulnerabilities)) {
    if (!vulnerability || typeof vulnerability !== "object"
      || vulnerability.name !== name
      || !severityNames.includes(vulnerability.severity)
      || !Array.isArray(vulnerability.via)) {
      failures.push(`audit vulnerability '${name}' is malformed`);
      continue;
    }
    computedCounts[vulnerability.severity] += 1;
  }
  for (const severity of severityNames) {
    if (!Number.isSafeInteger(metadataCounts[severity]) || metadataCounts[severity] < 0) {
      failures.push(`audit metadata ${severity} count is invalid`);
    } else if (metadataCounts[severity] !== computedCounts[severity]) {
      failures.push(`audit metadata ${severity} count does not match vulnerability details`);
    }
  }
  const metadataTotal = metadataCounts.total;
  const computedTotal = Object.values(computedCounts).reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(metadataTotal) || metadataTotal < 0 || metadataTotal !== computedTotal) {
    failures.push("audit metadata total does not match vulnerability details");
  }
  const accepted = exceptionKeys(exceptions, failures);
  const high = Object.entries(audit.vulnerabilities).filter(([, value]) => value && typeof value === "object" && ["high", "critical"].includes(value.severity));
  const observed = new Set();
  if (!acceptKnown && high.length) failures.push(`${high.length} unaccepted high/critical vulnerabilities`);
  for (const [name] of high) {
    for (const [pkg, id] of leaves(name, audit.vulnerabilities)) {
      const key = `${pkg}|${id}`;
      observed.add(key);
      if (acceptKnown && !accepted.has(key)) failures.push(`unaccepted ${name}: ${pkg}/${id}`);
    }
  }
  for (const key of accepted) if (!observed.has(key)) failures.push(`stale supply-chain exception: ${key}`);
  return failures;
}

function runNpm(args) {
  const npmCli = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].find((candidate) => candidate && existsSync(candidate));
  const options = { cwd: ROOT, encoding: "utf8" };

  return npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], options)
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, options);
}

function main() {
  const read = (file) => readFileSync(path.join(ROOT, file), "utf8");
  const parseFailures = [];
  const auditRun = runNpm(["audit", "--registry=https://registry.npmjs.org", "--json"]);
  const audit = parse(auditRun.stdout || "", "npm audit output", parseFailures);
  const xlsx = path.join(ROOT, "node_modules", "xlsx", "package.json");
  const xlsxHash = existsSync(xlsx) ? createHash("sha256").update(readFileSync(xlsx)).digest("hex") : "";
  const packageJson = parse(read("package.json"), "package.json", parseFailures);
  const packageLock = parse(read("package-lock.json"), "package-lock.json", parseFailures);
  const exceptions = parse(read(".supply-chain-accept.json"), "exception file", parseFailures);
  const npmVersion = (runNpm(["--version"]).stdout || "").trim();
  const npmConfig = {
    strictAllowScripts: (runNpm(["config", "get", "strict-allow-scripts"]).stdout || "").trim(),
    dangerouslyAllowAllScripts: (runNpm(["config", "get", "dangerously-allow-all-scripts"]).stdout || "").trim(),
    ignoreScripts: (runNpm(["config", "get", "ignore-scripts"]).stdout || "").trim(),
    allowScripts: (runNpm(["config", "get", "allow-scripts"]).stdout || "").trim(),
    omit: (runNpm(["config", "get", "omit"]).stdout || "").trim(),
    registry: (runNpm(["config", "get", "registry"]).stdout || "").trim(),
  };
  const failures = [
    ...parseFailures,
    ...validateSupplyChain({ packageJson, packageLock, nvmrc: read(".nvmrc").trim(), npmrc: read(".npmrc"), nodeVersion: process.versions.node, npmVersion, npmConfig, alternativeLockfiles: ALTERNATIVE_LOCKFILES.filter((file) => existsSync(path.join(ROOT, file))), xlsxHash, audit, exceptions, acceptKnown: process.argv.includes("--accept-known") || process.env.ACCEPT_KNOWN === "1" }),
  ];
  if (auditRun.error || (!auditRun.stdout && auditRun.status !== 0)) failures.push("npm audit did not return auditable data");
  if (failures.length) { for (const failure of failures) console.error(`[FAIL] ${failure}`); process.exitCode = 1; } else console.log("[PASS] supply-chain gate");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
