import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { guardProdBuild, PRODUCTION_DIR } from "../scripts/guard-prod-build.mjs";
import { checkLintBaseline } from "../scripts/check-lint-baseline.mjs";
import { checkSupabaseBoundaries } from "../scripts/check-supabase-boundaries.mjs";

function withFixture(prefix, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("SAM-67 production guard blocks active production builds on every platform", () => {
  for (const platform of ["linux", "win32"]) {
    const blocked = guardProdBuild({
      cwd: PRODUCTION_DIR,
      platform,
      serviceState: "active",
      env: { FORCE_BUILD: "1", ANALYZE: "true" },
      exists: () => false,
      log: () => {},
      error: () => {},
    });
    assert.equal(blocked.exitCode, 1, platform);
  }
});

test("SAM-67 production guard allows only existing isolated-build authorizations", () => {
  const isolated = guardProdBuild({
    cwd: PRODUCTION_DIR,
    env: { NEWME_ISOLATED_BUILD: "1" },
    serviceState: "active",
    exists: () => false,
    log: () => {},
    error: () => {},
  });
  assert.equal(isolated.exitCode, 0);

  const unknown = guardProdBuild({
    cwd: PRODUCTION_DIR,
    env: {},
    serviceState: "unknown",
    exists: () => false,
    log: () => {},
    error: () => {},
  });
  assert.equal(unknown.exitCode, 1);
});

test("SAM-67 routes npm and POSIX compatibility through the same Node guard", () => {
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const wrapper = fs.readFileSync("scripts/guard-prod-build.sh", "utf8");

  assert.equal(packageJson.scripts.prebuild, "node scripts/guard-prod-build.mjs");
  assert.match(wrapper, /^#!\/bin\/sh/m);
  assert.match(wrapper, /exec node .*guard-prod-build\.mjs/);
});

test("SAM-67 lint ratchet fails closed when Windows leaves stdout undefined", () => {
  withFixture("sam67-lint-", (root) => {
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts", "lint-baseline.json"), JSON.stringify({
      generated_at: "2026-07-28T00:00:00Z",
      entries: [],
    }));
    assert.throws(
      () => checkLintBaseline({
        root,
        run: () => ({ status: 2, stdout: undefined, stderr: "Windows launch failure" }),
        log: () => {},
        error: () => {},
      }),
      /no JSON output.*Windows launch failure/i,
    );
  });
});

test("SAM-67 Supabase boundary gate keeps server-only finalizers valid and rejects browser service roles", () => {
  withFixture("sam67-boundary-", (root) => {
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(root, "src/lib"), { recursive: true });
    fs.mkdirSync(path.join(root, "src/components"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts", "supabase-boundary-allowlist.json"), JSON.stringify({ max_findings: {} }));
    fs.writeFileSync(path.join(root, "src/lib/user-profile-provisioning.ts"), [
      'import "server-only";',
      'const service_role = process.env.SUPABASE_SERVICE_ROLE_KEY;',
      'export const finalize = () => service_role;',
    ].join("\n"));

    const safe = checkSupabaseBoundaries({ root, log: () => {}, error: () => {} });
    assert.equal(safe.exitCode, 0);

    fs.writeFileSync(path.join(root, "src/components/Unsafe.tsx"), [
      '"use client";',
      'const service_role = process.env.SUPABASE_SERVICE_ROLE_KEY;',
      'export const Unsafe = () => service_role;',
    ].join("\n"));
    const unsafe = checkSupabaseBoundaries({ root, log: () => {}, error: () => {} });
    assert.equal(unsafe.exitCode, 1);
    assert.match(unsafe.output, /service-role-in-browser-reachable-code/);
  });
});
