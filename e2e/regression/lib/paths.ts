import path from "node:path";

const REGRESSION_ROOT = path.resolve(__dirname, "..");

/** Gitignored directory with cached QA sessions, one folder per target origin. */
export function authCacheDir(baseURL: string): string {
  const u = new URL(baseURL);
  return path.join(REGRESSION_ROOT, ".auth-cache", `${u.hostname}-${u.port || (u.protocol === "https:" ? "443" : "80")}`);
}

export function authStatePath(baseURL: string, key: string): string {
  return path.join(authCacheDir(baseURL), `${key}.json`);
}

export function runDirFromEnv(): string {
  const dir = process.env.E2E_RUN_DIR;
  if (!dir) throw new Error("E2E_RUN_DIR is not set (run through playwright.regression.config.ts)");
  return dir;
}
