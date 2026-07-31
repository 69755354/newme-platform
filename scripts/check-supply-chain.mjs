import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADVISORY = /(?:GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}|CVE-\d{4}-\d{4,})/i;
const REQUIRED = ["package", "vuln_id", "severity", "risk_reason", "mitigation", "owner", "expires", "audit_ref"];
const XLSX_HASH = "7385d8ea33c4feaa85e0f27430f7631c142d07c0a052f9f5e73b5fddb88acbe8";

function parse(value, label, failures) {
  try { return JSON.parse(value); } catch { failures.push(`${label} is not valid JSON`); return null; }
}

function exceptionKeys(document, failures) {
  if (!document || !Array.isArray(document.accepted)) { failures.push("accepted must be an array"); return new Set(); }
  const today = new Date().toISOString().slice(0, 10);
  const keys = new Set();
  for (const [index, item] of document.accepted.entries()) {
    if (!item || typeof item !== "object") { failures.push(`accepted[${index}] must be an object`); continue; }
    for (const field of REQUIRED) if (typeof item[field] !== "string" || !item[field].trim()) failures.push(`accepted[${index}] missing ${field}`);
    const id = String(item.vuln_id || "").toUpperCase();
    if (!/^(?:GHSA-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}|CVE-\d{4}-\d{4,})$/.test(id)) failures.push(`accepted[${index}] invalid advisory`);
    if (!["high", "critical"].includes(String(item.severity).toLowerCase())) failures.push(`accepted[${index}] invalid severity`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(item.expires)) || String(item.expires) < today) failures.push(`accepted[${index}] expired or invalid`);
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

export function validateSupplyChain({ packageJson, packageLock, nvmrc, nodeVersion, npmVersion, xlsxHash, audit, exceptions, acceptKnown }) {
  const failures = [];
  for (const dep of ["next", "react", "react-dom"]) if (!/^\d+\.\d+\.\d+$/.test(packageJson?.dependencies?.[dep] || "")) failures.push(`${dep} must be exact`);
  if (xlsxHash !== XLSX_HASH) failures.push("xlsx hash mismatch");
  if (!packageLock?.packages?.[""] || JSON.stringify(packageLock.packages[""].dependencies) !== JSON.stringify(packageJson.dependencies)) failures.push("package-lock is not in sync");
  if (JSON.stringify(packageLock?.packages?.[""]?.engines) !== JSON.stringify(packageJson?.engines)) failures.push("package-lock engines are not in sync");
  const locked = packageLock?.packages?.["node_modules/xlsx"];
  if (!locked || locked.version !== "0.20.2" || locked.resolved !== packageJson?.dependencies?.xlsx || !locked.integrity) failures.push("xlsx lock mismatch");
  if (!/^\d+\.\d+\.\d+$/.test(nvmrc) || nodeVersion !== nvmrc) failures.push("Node version mismatch");
  const expectedNpm = packageJson?.packageManager?.match(/^npm@(\d+\.\d+\.\d+)$/)?.[1];
  if (!expectedNpm || packageJson?.engines?.npm !== expectedNpm || npmVersion !== expectedNpm) failures.push("npm version mismatch");
  if (!audit || typeof audit.vulnerabilities !== "object" || !audit.metadata || typeof audit.metadata.vulnerabilities !== "object") { failures.push("audit JSON is incomplete"); return failures; }
  const accepted = exceptionKeys(exceptions, failures);
  const high = Object.entries(audit.vulnerabilities).filter(([, value]) => value && typeof value === "object" && ["high", "critical"].includes(value.severity));
  if (!acceptKnown && high.length) failures.push(`${high.length} unaccepted high/critical vulnerabilities`);
  if (acceptKnown) for (const [name] of high) for (const [pkg, id] of leaves(name, audit.vulnerabilities)) if (!accepted.has(`${pkg}|${id}`)) failures.push(`unaccepted ${name}: ${pkg}/${id}`);
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
  const auditRun = runNpm(["audit", "--json"]);
  const audit = parse(auditRun.stdout || "", "npm audit output", []);
  const xlsx = path.join(ROOT, "node_modules", "xlsx", "package.json");
  const xlsxHash = existsSync(xlsx) ? createHash("sha256").update(readFileSync(xlsx)).digest("hex") : "";
  const packageJson = parse(read("package.json"), "package.json", []);
  const packageLock = parse(read("package-lock.json"), "package-lock.json", []);
  const exceptions = parse(read(".supply-chain-accept.json"), "exception file", []);
  const npmVersion = (runNpm(["--version"]).stdout || "").trim();
  const failures = validateSupplyChain({ packageJson, packageLock, nvmrc: read(".nvmrc").trim(), nodeVersion: process.versions.node, npmVersion, xlsxHash, audit, exceptions, acceptKnown: process.argv.includes("--accept-known") || process.env.ACCEPT_KNOWN === "1" });
  if (auditRun.error || (!auditRun.stdout && auditRun.status !== 0)) failures.push("npm audit did not return auditable data");
  if (failures.length) { for (const failure of failures) console.error(`[FAIL] ${failure}`); process.exitCode = 1; } else console.log("[PASS] supply-chain gate");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
