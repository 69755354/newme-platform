import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateToolchain } from "./check-supply-chain.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALTERNATIVE_LOCKFILES = ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];

function readJson(file, failures) {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, file), "utf8"));
  } catch {
    failures.push(`${file} is not valid JSON`);
    return null;
  }
}

function npmOutput(args) {
  const bundledCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const run = existsSync(bundledCli)
    ? spawnSync(process.execPath, [bundledCli, ...args], { cwd: ROOT, encoding: "utf8" })
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, { cwd: ROOT, encoding: "utf8" });
  return run.error || run.status !== 0 ? "" : (run.stdout || "").trim();
}

const failures = [];
const packageJson = readJson("package.json", failures);
const packageLock = readJson("package-lock.json", failures);
failures.push(...validateToolchain({
  packageJson,
  packageLock,
  nvmrc: readFileSync(path.join(ROOT, ".nvmrc"), "utf8").trim(),
  npmrc: readFileSync(path.join(ROOT, ".npmrc"), "utf8"),
  nodeVersion: process.versions.node,
  npmVersion: npmOutput(["--version"]),
  npmConfig: {
    strictAllowScripts: npmOutput(["config", "get", "strict-allow-scripts"]),
    dangerouslyAllowAllScripts: npmOutput(["config", "get", "dangerously-allow-all-scripts"]),
    ignoreScripts: npmOutput(["config", "get", "ignore-scripts"]),
    allowScripts: npmOutput(["config", "get", "allow-scripts"]),
    omit: npmOutput(["config", "get", "omit"]),
    registry: npmOutput(["config", "get", "registry"]),
  },
  alternativeLockfiles: ALTERNATIVE_LOCKFILES.filter((file) => existsSync(path.join(ROOT, file))),
}));

if (failures.length) {
  for (const failure of failures) console.error(`[FAIL] ${failure}`);
  process.exitCode = 1;
} else {
  console.log("[PASS] pre-install Node/npm/lock toolchain gate");
}
