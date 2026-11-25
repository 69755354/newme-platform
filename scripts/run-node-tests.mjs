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
    console.error("Git Bash is required for the repository test suite");
    process.exit(1);
  }

  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  env[pathKey] = [gitBin, env[pathKey] || ""].filter(Boolean).join(path.delimiter);
  return env;
}

export function planBatches(allTests, readFile = (file) => fs.readFileSync(file, "utf8")) {
  const loaderHookTests = allTests.filter((file) => readFile(file).includes("Module._load"));
  const ordinaryTests = allTests.filter((file) => !loaderHookTests.includes(file));
  // Tests that replace the process-wide CommonJS loader must never share a test
  // process. Node's file isolation has differed across runner/platform versions,
  // so enforce the boundary explicitly instead of relying on its default.
  return {
    ordinary: ordinaryTests.length ? [ordinaryTests] : [],
    loader: loaderHookTests.map((file) => [file]),
  };
}

// Always runs every batch (ordinary + each loader-hook file) and reports a
// per-batch failure summary; the exit code is non-zero if anything failed.
export function runAll(plan, run, log = console.error) {
  const failures = [];
  const groups = [
    ["ordinary", plan.ordinary],
    ["loader", plan.loader],
  ];
  for (const [name, batches] of groups) {
    for (const files of batches) {
      const result = run(files);
      let reason = null;
      if (result.error) reason = result.error.message;
      else if (result.signal) reason = `terminated by ${result.signal}`;
      else if (result.status !== 0) reason = `exit ${result.status ?? 1}`;
      if (reason) failures.push({ name, files, reason });
    }
  }
  if (failures.length) {
    log("Repository test failures by batch:");
    for (const f of failures) {
      log(`  [${f.name}] ${f.files.length === 1 ? f.files[0] : `${f.files.length} files`}: ${f.reason}`);
    }
  }
  return { failures, exitCode: failures.length ? 1 : 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const plan = planBatches(fs.globSync("tests/**/*.test.mjs").sort());
  const { exitCode } = runAll(plan, (files) =>
    spawnSync(
      process.execPath,
      ["--test", "--test-concurrency=1", "--test-isolation=process", ...files],
      { env: testEnvironment(), stdio: "inherit" },
    ),
  );
  process.exit(exitCode);
}
