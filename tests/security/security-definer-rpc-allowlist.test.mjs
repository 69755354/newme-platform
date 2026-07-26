import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const gate = path.join(root, "scripts/check-security-definer-rpc-allowlist.mjs");
const manifest = path.join(
  root,
  "supabase/security/authenticated-security-definer-rpc-allowlist.json",
);
const sql = path.join(
  root,
  "supabase/security/check-authenticated-security-definer-rpc-allowlist.sql",
);

function run(args = []) {
  return spawnSync(process.execPath, [gate, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

test("SAM-61 reviewed SECURITY DEFINER RPC allowlist is internally consistent", () => {
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /9 reviewed authenticated RPCs/);
});

test("SAM-61 gate fails closed when the manifest expands without the live SQL gate", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sam61-definer-"));
  const tempManifest = path.join(tempDir, "allowlist.json");
  const data = JSON.parse(fs.readFileSync(manifest, "utf8"));
  data.entries.push({
    regprocedure: "unexpected_rpc()",
    purpose: "This fixture represents an unreviewed externally callable privileged function.",
    authorization_boundary: "The fixture has no accepted authorization boundary and must be rejected.",
    test_evidence: ["tests/security/security-definer-rpc-allowlist.test.mjs"],
  });
  fs.writeFileSync(tempManifest, JSON.stringify(data));

  const result = run(["--manifest", tempManifest, "--sql", sql]);
  fs.rmSync(tempDir, { recursive: true, force: true });

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /manifest and live SQL gate allowlists differ/);
});
