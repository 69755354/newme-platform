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

function withManifest(mutator, callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sam67-definer-"));
  try {
    const tempManifest = path.join(tempDir, "allowlist.json");
    const data = JSON.parse(fs.readFileSync(manifest, "utf8"));
    mutator(data);
    fs.writeFileSync(tempManifest, JSON.stringify(data));
    callback(tempManifest);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("SAM-67 governed SECURITY DEFINER RPC allowlist is internally consistent", () => {
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /12 reviewed authenticated RPCs/);
});

test("SAM-67 gate fails closed when governance fields are missing", async (t) => {
  for (const field of ["owner", "justification", "expiry", "linked_issue"]) {
    await t.test(field, () => {
      withManifest((data) => {
        delete data.entries[0][field];
      }, (tempManifest) => {
        const result = run(["--manifest", tempManifest, "--sql", sql]);
        assert.notEqual(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stderr, new RegExp(`entries\\[0\\]\\.${field}`));
      });
    });
  }
});

test("SAM-67 gate fails closed when an allowlist entry is expired", () => {
  withManifest((data) => {
    data.entries[0].expiry = "2000-01-01";
  }, (tempManifest) => {
    const result = run(["--manifest", tempManifest, "--sql", sql]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /entries\[0\]\.expiry 2000-01-01 is expired/);
  });
});

test("SAM-67 gate fails closed without a valid linked Linear issue", () => {
  withManifest((data) => {
    data.entries[0].linked_issue = "NOT-AN-ISSUE";
  }, (tempManifest) => {
    const result = run(["--manifest", tempManifest, "--sql", sql]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /linked_issue must be a valid SAM-N Linear issue key/);
  });
});

test("SAM-67 gate fails closed when the manifest expands without the live SQL gate", () => {
  withManifest((data) => {
    data.entries.push({
      regprocedure: "unexpected_rpc()",
      owner: "platform-delivery",
      justification: "This fixture represents an unreviewed externally callable privileged function.",
      expiry: "2099-01-01",
      linked_issue: "SAM-67",
      authorization_boundary: "The fixture has no accepted authorization boundary and must be rejected.",
      test_evidence: ["tests/security/security-definer-rpc-allowlist.test.mjs"],
    });
  }, (tempManifest) => {
    const result = run(["--manifest", tempManifest, "--sql", sql]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /manifest and live SQL gate allowlists differ/);
  });
});
