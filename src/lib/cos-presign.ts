import "server-only";

import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { realpathSync, statSync } from "node:fs";

export function resolveCosPresignScriptPath(): string {
  const releaseRoot = realpathSync(process.cwd());
  const candidate = realpathSync(resolve(releaseRoot, "scripts", "cos-presign.py"));
  const candidateRelative = relative(releaseRoot, candidate);
  if (
    !candidateRelative
    || candidateRelative === ".."
    || candidateRelative.startsWith(`..${sep}`)
    || isAbsolute(candidateRelative)
    || !statSync(candidate).isFile()
  ) {
    throw new Error("cos_presign_script_outside_release");
  }
  return candidate;
}

export async function runCosPresign(args: string[]): Promise<unknown> {
  const executable = process.env.COS_PYTHON_EXECUTABLE
    ?? (process.platform === "win32" ? "python" : "python3");
  const script = resolveCosPresignScriptPath();
  const stdout = await new Promise<string>((resolveOutput, reject) => {
    execFile(
      executable,
      [script, ...args],
      { env: { ...process.env }, timeout: 8_000, encoding: "utf-8" },
      (error, result) => error ? reject(error) : resolveOutput(result),
    );
  });
  return JSON.parse(stdout) as unknown;
}
