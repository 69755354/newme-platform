/**
 * Negative regression for scripts/check-migration-history.mjs.
 *
 * The gate exists because the previous round of this branch renamed one applied
 * migration and rewrote another, both of which production records as already
 * applied. A gate against that class of mistake is only worth having if it is
 * known to go red — so every case below is a mutation that MUST fail, plus one
 * clean case that must pass, so the failures are not just "this script always
 * exits 1".
 *
 * The script resolves its own root from its own location, so each case builds a
 * throwaway repository (real `git init`, real commit) and copies the script into
 * it. Nothing here touches supabase/migrations in this checkout.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "check-migration-history.mjs");

const APPLIED = {
  "20260101000000_first.sql": "select 1;\n",
  "20260102000000_second.sql": "select 2;\n",
};

const hash = (text) => createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");

/**
 * A fixture repository whose applied history is committed and whose manifest
 * matches that commit. Returns the paths a case needs to mutate.
 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newme-history-gate-"));
  const migrations = path.join(root, "supabase", "migrations");
  fs.mkdirSync(migrations, { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(SCRIPT, path.join(root, "scripts", "check-migration-history.mjs"));

  for (const [name, body] of Object.entries(APPLIED)) {
    fs.writeFileSync(path.join(migrations, name), body);
  }

  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "--quiet");
  git("config", "user.email", "gate@example.invalid");
  git("config", "user.name", "history gate fixture");
  git("config", "commit.gpgsign", "false");
  git("add", "--all");
  git("-c", "core.autocrlf=false", "commit", "--quiet", "--message", "applied history");
  const base = git("rev-parse", "HEAD").trim();

  const manifest = path.join(root, "supabase", "migration-history-baseline.sha256");
  writeManifest(manifest, base, APPLIED);

  return { root, migrations, manifest, base };
}

function writeManifest(file, baseCommit, entries) {
  const lines = [`# BASE_COMMIT ${baseCommit}`];
  for (const [name, body] of Object.entries(entries)) lines.push(`${hash(body)}  ${name}`);
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

function run(root) {
  try {
    const stdout = execFileSync(process.execPath, ["scripts/check-migration-history.mjs"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output: stdout };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

test("a clean history with a forward-only new migration passes", () => {
  const { root, migrations } = fixture();
  fs.writeFileSync(path.join(migrations, "20260103000000_new.sql"), "select 3;\n");
  fs.writeFileSync(path.join(migrations, "rollback_new.sql"), "select 4;\n");
  // Both hand-run shapes. `recontract_` is the return half added by round-4 B9:
  // it must be accepted as a companion and NOT counted as a new migration, or the
  // forward-only rule would demand a 14-digit timestamp from a file whose whole
  // purpose is that the CLI never applies it.
  fs.writeFileSync(path.join(migrations, "recontract_new.sql"), "select 5;\n");
  const { code, output } = run(root);
  assert.equal(code, 0, output);
  assert.match(output, /2 listed, 2 verified unchanged/);
  assert.match(output, /new on this branch\s*: 1/);
  assert.match(output, /hand-run companions : 2 \(recontract_new\.sql, rollback_new\.sql\)/);
  assert.match(output, /verified against/);
});

test("editing an applied migration fails as MODIFIED", () => {
  const { root, migrations } = fixture();
  fs.appendFileSync(path.join(migrations, "20260101000000_first.sql"), "-- a harmless comment\n");
  const { code, output } = run(root);
  assert.equal(code, 1);
  assert.match(output, /20260101000000_first\.sql was MODIFIED/);
  assert.match(output, /new forward-only migration/);
});

test("renaming an applied migration is reported as a rename, naming both files", () => {
  const { root, migrations } = fixture();
  fs.renameSync(
    path.join(migrations, "20260101000000_first.sql"),
    path.join(migrations, "20260104000000_first.sql"),
  );
  const { code, output } = run(root);
  assert.equal(code, 1);
  assert.match(output, /20260101000000_first\.sql was RENAMED to 20260104000000_first\.sql/);
});

test("deleting an applied migration fails as DELETED", () => {
  const { root, migrations } = fixture();
  fs.rmSync(path.join(migrations, "20260102000000_second.sql"));
  const { code, output } = run(root);
  assert.equal(code, 1);
  assert.match(output, /20260102000000_second\.sql was DELETED/);
});

test("a new migration that sorts into applied history is refused", () => {
  const { root, migrations } = fixture();
  fs.writeFileSync(path.join(migrations, "20251231000000_backdated.sql"), "select 5;\n");
  const { code, output } = run(root);
  assert.equal(code, 1);
  assert.match(output, /20251231000000_backdated\.sql sorts at or before the last applied migration/);
});

test("a new migration the Supabase CLI would never apply is refused", () => {
  const { root, migrations } = fixture();
  fs.writeFileSync(path.join(migrations, "1780601210_epoch_named.sql"), "select 6;\n");
  const { code, output } = run(root);
  assert.equal(code, 1);
  assert.match(output, /does not match \^\[0-9\]\{14\}/);
  assert.match(output, /is not a precedent/);
});

test("a new migration reusing an applied timestamp is refused", () => {
  const { root, migrations } = fixture();
  // Sorts after the last applied stamp, so only the collision check can catch it.
  fs.writeFileSync(path.join(migrations, "20260103000000_a.sql"), "select 7;\n");
  fs.writeFileSync(path.join(migrations, "20260103000000_b.sql"), "select 8;\n");
  const { code, output } = run(root);
  assert.equal(code, 1);
  assert.match(output, /reuses the timestamp of/);
});

test("editing the manifest to match an edited migration does not launder it", () => {
  // The circularity the git cross-check exists to close: without it, anyone
  // rewriting applied history could rewrite the manifest in the same commit.
  const { root, migrations, manifest, base } = fixture();
  const edited = "select 1; -- rewritten\n";
  fs.writeFileSync(path.join(migrations, "20260101000000_first.sql"), edited);
  writeManifest(manifest, base, { ...APPLIED, "20260101000000_first.sql": edited });
  const { code, output } = run(root);
  assert.equal(code, 1);
  assert.match(output, /manifest hash for 20260101000000_first\.sql does not match its content at/);
});

test("dropping a migration from the manifest does not make it mutable", () => {
  const { root, migrations, manifest, base } = fixture();
  const edited = "select 1; -- rewritten\n";
  fs.writeFileSync(path.join(migrations, "20260101000000_first.sql"), edited);
  writeManifest(manifest, base, { "20260102000000_second.sql": APPLIED["20260102000000_second.sql"] });
  const { code, output } = run(root);
  assert.equal(code, 1);
  assert.match(output, /20260101000000_first\.sql was applied as of the base commit but is missing from the manifest/);
});

test("a manifest with no BASE_COMMIT header fails instead of skipping the cross-check", () => {
  const { root, manifest } = fixture();
  const withoutHeader = fs
    .readFileSync(manifest, "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("# BASE_COMMIT"))
    .join("\n");
  fs.writeFileSync(manifest, withoutHeader);
  const { code, output } = run(root);
  assert.equal(code, 1);
  assert.match(output, /no '# BASE_COMMIT <40-hex>' header/);
});

test("a shallow clone that lacks the base commit fails rather than warning", () => {
  const { root, manifest } = fixture();
  const text = fs
    .readFileSync(manifest, "utf8")
    .replace(/^# BASE_COMMIT [0-9a-f]{40}$/m, `# BASE_COMMIT ${"0".repeat(39)}1`);
  fs.writeFileSync(manifest, text);
  const { code, output } = run(root);
  assert.equal(code, 1);
  assert.match(output, /is not present in this clone/);
  assert.match(output, /fetch-depth: 0/);
});

test("--list-new refuses to emit a set while the history is corrupted", () => {
  const { root, migrations } = fixture();
  fs.writeFileSync(path.join(migrations, "20260103000000_new.sql"), "select 3;\n");
  fs.appendFileSync(path.join(migrations, "20260101000000_first.sql"), "-- edited\n");
  let result;
  try {
    const stdout = execFileSync(process.execPath, ["scripts/check-migration-history.mjs", "--list-new"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    result = { code: 0, stdout, stderr: "" };
  } catch (error) {
    result = { code: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stdout, /20260103000000_new\.sql/);
  assert.match(result.stderr, /refusing to list the new set/);
});

test("this checkout's own migration history passes the gate", () => {
  // Not a fixture: the gate must be green on the branch that ships it, and the
  // eight new L0 migrations must all sort after applied history.
  const { code, output } = run(REPO_ROOT);
  assert.equal(code, 0, output);
  assert.match(output, /manifest vs git\s*: verified against/);
});
