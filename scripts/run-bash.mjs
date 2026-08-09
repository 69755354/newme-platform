import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node scripts/run-bash.mjs <script> [args...]");
  process.exit(64);
}

const env = { ...process.env };
let bash = "bash";
if (process.platform === "win32") {
  const programFiles = env.ProgramFiles || "C:\\Program Files";
  const gitBin = path.join(programFiles, "Git", "bin");
  bash = path.join(gitBin, "bash.exe");
  if (!fs.existsSync(bash)) {
    console.error(`Git Bash is required: ${bash}`);
    process.exit(1);
  }
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  env[pathKey] = [gitBin, env[pathKey] || ""].filter(Boolean).join(path.delimiter);
}

const result = spawnSync(bash, args, { env, stdio: "inherit" });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
if (result.signal) {
  console.error(`Bash command terminated by ${result.signal}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
