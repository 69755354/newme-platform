import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function testEnvironment() {
  const env = { ...process.env };
  if (process.platform !== "win32") return env;

  const programFiles = env.ProgramFiles || "C:\\Program Files";
  const gitBin = path.join(programFiles, "Git", "bin");
  const gitBash = path.join(gitBin, "bash.exe");
  if (!fs.existsSync(gitBash)) {
    console.error(`Git Bash is required for the repository test suite: ${gitBash}`);
    process.exit(1);
  }

  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  env[pathKey] = [gitBin, env[pathKey] || ""].filter(Boolean).join(path.delimiter);
  return env;
}

const result = spawnSync(
  process.execPath,
  ["--test", "tests/**/*.test.mjs"],
  { env: testEnvironment(), stdio: "inherit" },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
if (result.signal) {
  console.error(`Repository tests terminated by ${result.signal}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
