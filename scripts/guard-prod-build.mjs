#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PRODUCTION_DIR = "/home/ubuntu/newme-platform";
const SERVICE_NAME = "newme-platform.service";

function currentServiceState(platform) {
  if (platform === "win32") return "unknown";
  const result = spawnSync("systemctl", ["is-active", "--quiet", SERVICE_NAME], { stdio: "ignore" });
  if (result.error || result.status === null) return "unknown";
  return result.status === 0 ? "active" : "inactive";
}

export function guardProdBuild({
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
  exists = fs.existsSync,
  serviceState,
  log = console.log,
  error = console.error,
} = {}) {
  if (env.NEWME_ISOLATED_BUILD === "1") {
    log("Isolated build (NEWME_ISOLATED_BUILD=1)");
    return { exitCode: 0, reason: "isolated-env" };
  }
  if (exists(path.join(cwd, ".hermes", "deploy-in-progress"))) {
    log("Deploy lock present — authorized build");
    return { exitCode: 0, reason: "deploy-lock" };
  }
  if (cwd.startsWith("/tmp/newme-build-")) {
    log(`Isolated build directory: ${cwd}`);
    return { exitCode: 0, reason: "isolated-directory" };
  }
  if (cwd !== PRODUCTION_DIR) return { exitCode: 0, reason: "non-production" };

  const state = serviceState ?? currentServiceState(platform);
  if (state === "active") {
    error("PRODUCTION BUILD BLOCKED: the production service is running; use the authorized deploy entry point.");
    return { exitCode: 1, reason: "production-service-active" };
  }
  if (state !== "inactive") {
    error("PRODUCTION BUILD BLOCKED: unable to verify production service state.");
    return { exitCode: 1, reason: "production-service-unknown" };
  }

  log("Production directory with service inactive — disaster-recovery build allowed.");
  return { exitCode: 0, reason: "production-service-inactive" };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = guardProdBuild().exitCode;
}
