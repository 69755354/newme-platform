import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const exactVersionPattern = /^\d+\.\d+\.\d+$/;

function readRequired(root, relativePath, readFile) {
  try {
    return readFile(path.join(root, relativePath), "utf8");
  } catch (error) {
    throw new Error(`Missing or unreadable ${relativePath}: ${error.message}`);
  }
}

function requireExactVersion(value, label) {
  if (typeof value !== "string" || !exactVersionPattern.test(value)) {
    throw new Error(`${label} must be one exact X.Y.Z version`);
  }
  return value;
}

export function checkToolchain({
  root = process.cwd(),
  actualNode = process.versions.node,
  actualNpm,
  readFile = readFileSync,
  run = spawnSync,
  platform = process.platform,
} = {}) {
  const packageJson = JSON.parse(readRequired(root, "package.json", readFile));
  const expectedNode = requireExactVersion(packageJson.engines?.node, "package.json engines.node");
  const expectedNpm = requireExactVersion(packageJson.engines?.npm, "package.json engines.npm");

  if (packageJson.packageManager !== `npm@${expectedNpm}`) {
    throw new Error(`package.json packageManager must equal npm@${expectedNpm}`);
  }

  const nvmVersion = readRequired(root, ".nvmrc", readFile).trim();
  if (nvmVersion !== expectedNode) {
    throw new Error(`.nvmrc ${nvmVersion || "<empty>"} does not equal Node ${expectedNode}`);
  }

  const workflow = readRequired(root, ".github/workflows/ci.yml", readFile);
  const workflowVersions = [...workflow.matchAll(/^\s*node-version:\s*['"]?([^'"\s#]+)['"]?\s*$/gm)]
    .map((match) => match[1]);
  if (workflowVersions.length !== 1 || workflowVersions[0] !== expectedNode) {
    throw new Error(
      `CI must contain exactly one node-version pinned to ${expectedNode}; found ${JSON.stringify(workflowVersions)}`,
    );
  }

  requireExactVersion(actualNode, "runtime Node");
  if (actualNode !== expectedNode) {
    throw new Error(`Runtime Node ${actualNode} does not equal pinned Node ${expectedNode}`);
  }

  let npmVersion = actualNpm;
  if (npmVersion === undefined) {
    const npmCommand = platform === "win32" ? "npm.cmd" : "npm";
    const result = run(npmCommand, ["--version"], { encoding: "utf8" });
    if (result.status !== 0 || typeof result.stdout !== "string") {
      const detail = typeof result.stderr === "string" ? result.stderr.trim() : "no stderr";
      throw new Error(`Unable to determine runtime npm version: ${detail}`);
    }
    npmVersion = result.stdout.trim();
  }

  requireExactVersion(npmVersion, "runtime npm");
  if (npmVersion !== expectedNpm) {
    throw new Error(`Runtime npm ${npmVersion} does not equal pinned npm ${expectedNpm}`);
  }

  return { node: expectedNode, npm: expectedNpm };
}

const isCli = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  try {
    const versions = checkToolchain();
    console.log(`Toolchain gate passed: Node ${versions.node}, npm ${versions.npm}`);
  } catch (error) {
    console.error(`Toolchain gate failed: ${error.message}`);
    process.exitCode = 1;
  }
}
