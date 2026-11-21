import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// systemd (newme-drive-sync.service), cron and the Hermes wrappers start these by the /opt/newme/current symlink with an
// absolute path. Node resolves the symlink for import.meta.url but not for argv[1], so the old guard never matched and the
// script exited 0 without doing anything.
const STARTED_BY_SYMLINK = [
  "drive-to-os-sync.mjs", "meta-reconcile.mjs", "synthetic-journey.mjs", "meta-leads-pull.mjs",
  "whatsapp-capi-send.mjs", "meta-capi-retry.mjs", "meta-crm-events-send.mjs", "os-drive-nas-sync.mjs",
];

test("drive-to-os-sync really runs when started through a symlinked release directory by absolute path", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
  try {
    const link = path.join(tmp, "current");
    fs.symlinkSync(root, link);
    const r = spawnSync(process.execPath, [path.join(link, "scripts/drive-to-os-sync.mjs"), "--bogus-flag"], {
      cwd: "/", encoding: "utf8", env: { PATH: process.env.PATH, DRIVE_SYNC_DATA_DIR: path.join(tmp, "data") },
    });
    // the usage error (exit 64) proves main ran; the old guard exited 0 with no output
    assert.equal(r.status, 64);
    assert.match(r.stdout + r.stderr, /usage: drive-to-os-sync\.mjs/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

for (const name of STARTED_BY_SYMLINK) {
  test(`${name} compares real paths in its main-module guard`, () => {
    const text = fs.readFileSync(path.join(root, "scripts", name), "utf8");
    assert.match(text, /realpathOf\(process\.argv\[1\]\) === realpathOf\(fileURLToPath\(import\.meta\.url\)\)/);
    assert.doesNotMatch(text, /import\.meta\.url === pathToFileURL\(/);
    assert.doesNotMatch(text, /fileURLToPath\(import\.meta\.url\) === path\.resolve\(/);
    assert.match(text, /if \(isMainModule\(\)\)/);
  });
}
