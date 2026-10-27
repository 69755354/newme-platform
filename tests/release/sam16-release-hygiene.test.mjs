import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const [gitignore, tsconfig, unit, preflight, deploy] = await Promise.all([
  readFile(join(repoRoot, ".gitignore"), "utf8"),
  readFile(join(repoRoot, "tsconfig.json"), "utf8").then(JSON.parse),
  readFile(join(repoRoot, "infra", "systemd", "newme-platform.service"), "utf8"),
  readFile(join(repoRoot, "scripts", "verify-release-preflight.sh"), "utf8"),
  readFile(join(repoRoot, "scripts", "deploy-immutable.sh"), "utf8"),
]);

test("incremental TypeScript state is build-local and not tracked", () => {
  assert.equal(tsconfig.compilerOptions.tsBuildInfoFile, ".next/cache/tsconfig.tsbuildinfo");
  assert.match(gitignore, /^tsconfig\.tsbuildinfo$/m);

  const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "tsconfig.tsbuildinfo"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.notEqual(tracked.status, 0, "root tsconfig.tsbuildinfo must not be tracked");
});

test("versioned systemd unit owns the direct app process and full cgroup", () => {
  assert.match(
    unit,
    /^ExecStart=\/usr\/bin\/node \/opt\/newme\/current\/node_modules\/next\/dist\/bin\/next start -p 3001$/m,
  );
  assert.match(unit, /^KillMode=control-group$/m);
  assert.match(unit, /^TimeoutStopSec=30$/m);
  assert.doesNotMatch(unit, /^ExecStart=\/usr\/bin\/npm\b/m);
});

test("release entrypoint remains SHA, CI, migration, and rollback bound", () => {
  assert.match(preflight, /release HEAD must equal origin\/main/);
  assert.match(preflight, /CI_HEAD_SHA.*release_sha/);
  assert.match(preflight, /MIGRATION_STATUS/);
  assert.match(preflight, /ROLLBACK_GIT_SHA/);
  assert.match(deploy, /verify-release-preflight\.sh/);
  assert.match(deploy, /git -C "\$ROOT" archive "\$SHA"/);
  assert.match(deploy, /rollback_release/);
});
