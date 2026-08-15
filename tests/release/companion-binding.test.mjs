// ============================================================================
// The hand-run companions are bound to the release — round-4 review C4-5
// ============================================================================
// rollback_*.sql and recontract_*.sql are the SQL an operator executes against
// production by hand to take this release back out, or to put it back in. They are
// the one class of release SQL that every other gate structurally cannot reach:
//
//   * the Supabase CLI never applies them (the name does not match ^[0-9]{14}_), so
//     they never reach supabase_migrations.schema_migrations;
//   * scripts/check-migration-history.mjs therefore excludes them from the applied
//     history manifest on purpose — they are not history — and its only companion
//     check was `if (!COMPANION_NAME.test(name)) fail(...)` over a list built by
//     that same regex, i.e. a tautology;
//   * scripts/verify-remote-migration-history.mjs compares recorded statements
//     against files, and there is no recorded row to compare against;
//   * scripts/replay-migrations.sh executes only the companions that cover a
//     migration new on this branch, so a companion covering nothing in this
//     release is executed by no job at all.
//
// Measured on PG 17.10 before the rule these tests pin existed: appending
// `grant select on public.contracts to anon` or `grant execute on function
// public.create_contract(jsonb) to authenticated` to
// rollback_money_direct_write_contract_phase.sql left MODE=branch at rc=0 with all
// post-rollback assertions passing; the same line inside rollback_p0_10.sql was
// never executed. So the binding cannot be "run it and assert" — it has to be the
// declared content of every companion on disk, checked before any of them runs.
//
// What is pinned here: the rule's behaviour under mutation, the set equality in
// both directions, the single COMPANION_NAME literal shared by two programs, and
// the three places that must actually run the check (CI, the replay harness, the
// deploy wrapper — the wrapper's gate name is held equal to REQUIRED_GATES by
// tests/release/control-plane-bootstrap-contract.test.mjs).
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

import {
  COMPANION_NAME,
  auditCompanions,
  auditManifest,
  readBaseline,
  readManifest,
  readTreeFiles,
} from "../../scripts/check-release-manifest.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");
const GATE = path.join(ROOT, "scripts", "check-release-manifest.mjs");

const manifest = readManifest();
const { files, hashes } = readTreeFiles(MIGRATIONS_DIR);
const onDisk = files.filter((file) => COMPANION_NAME.test(file));

const copy = () => JSON.parse(JSON.stringify(manifest));
const audit = (mutate) => {
  const mutated = copy();
  mutate(mutated);
  return auditCompanions({ manifest: mutated, files, hashes });
};
const refuses = (mutate, pattern) => {
  const problems = audit(mutate);
  assert.ok(
    problems.some((problem) => pattern.test(problem)),
    `expected a problem matching ${pattern}, got:\n${problems.join("\n") || "(none)"}`,
  );
};

// ---------------------------------------------------------------------------
// 1 · the committed state
// ---------------------------------------------------------------------------

test("the committed manifest declares exactly the companions in the tree", () => {
  assert.deepEqual(auditCompanions({ manifest, files, hashes }), []);
  assert.ok(onDisk.length > 0, "this release has no hand-run companions, so nothing here is meaningful");
  assert.deepEqual(
    manifest.companions.map((entry) => entry.file),
    onDisk,
    "the declared set must be the on-disk set, in filename order",
  );
  for (const entry of manifest.companions) {
    assert.equal(entry.sha256, hashes.get(entry.file), `${entry.file}`);
    assert.match(entry.kind, /^(rollback|recontract)$/);
    assert.ok(entry.file.startsWith(`${entry.kind}_`));
  }
});

test("the companions no job executes are declared too, and they are the reason the rule exists", () => {
  // A companion is executed by scripts/replay-migrations.sh only if it names a
  // migration that is new on this branch. Derived rather than listed: a release
  // that adds or removes a migration changes which companions run, and a hard-coded
  // pair here would stop being about this release.
  const pending = new Set(
    [...manifest.required_for_app, ...manifest.deferred_contract].map((entry) => entry.file),
  );
  const covers = (file) => {
    const source = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    return [...source.matchAll(/^--\s*(?:ROLLS_BACK|RECONTRACTS):\s*(\S+)/gm)]
      .map((match) => match[1])
      .filter((name) => pending.has(name));
  };
  const neverExecuted = onDisk.filter((file) => covers(file).length === 0);
  assert.ok(
    neverExecuted.length > 0,
    "expected at least one companion that no replay mode executes; if that is no longer true, say so here rather than deleting the test",
  );
  const declared = new Set(manifest.companions.map((entry) => entry.file));
  for (const file of neverExecuted) {
    assert.ok(declared.has(file), `${file} is executed by no gate and declared by none either`);
  }
});

// ---------------------------------------------------------------------------
// 2 · the rule under mutation
// ---------------------------------------------------------------------------

test("a companion added to the tree and left undeclared is refused", () => {
  // The failure mode the rule exists for: the reviewer sees a new rollback script
  // in the diff, every gate is green, and no artifact says what it contains.
  const problems = auditCompanions({
    manifest,
    files: [...files, "rollback_c45_undeclared.sql"].sort(),
    hashes: new Map([...hashes, ["rollback_c45_undeclared.sql", "a".repeat(64)]]),
  });
  assert.ok(
    problems.some((problem) =>
      /rollback_c45_undeclared\.sql is a hand-run companion in supabase\/migrations\/ but the manifest does not name it/.test(problem),
    ),
    problems.join("\n"),
  );
});

test("a declared companion that is not in the tree is refused", () => {
  refuses(
    (mutated) => mutated.companions.push({ file: "rollback_gone.sql", kind: "rollback", sha256: "b".repeat(64) }),
    /companions lists rollback_gone\.sql, which is not present in supabase\/migrations\//,
  );
});

test("editing a companion without restamping is refused, and named", () => {
  // This is the exact mutation that was measured invisible: a privilege escalation
  // appended to a rollback script. The bytes change, so the hash changes.
  const victim = manifest.companions.at(-1).file;
  refuses(
    (mutated) => {
      mutated.companions.at(-1).sha256 = "c".repeat(64);
    },
    new RegExp(`${escapeRegExp(victim)} has changed since the manifest was stamped`),
  );
});

test("the whole key missing, or not an array, is refused rather than skipped", () => {
  for (const mutate of [
    (mutated) => delete mutated.companions,
    (mutated) => {
      mutated.companions = {};
    },
    (mutated) => {
      mutated.companions = "rollback_l0_20260811.sql";
    },
  ]) {
    refuses(mutate, /companions must be an array naming every hand-run/);
  }
});

test("a malformed entry is refused: filename, kind, hash, duplicate, order", () => {
  refuses(
    (mutated) => mutated.companions.push({ file: "20260819000000_not_a_companion.sql", kind: "rollback", sha256: "d".repeat(64) }),
    /is not a hand-run companion filename/,
  );
  // companions[0] is the recontract entry: letters sort before "rollback_".
  assert.equal(manifest.companions[0].kind, "recontract");
  refuses(
    (mutated) => {
      mutated.companions[0].kind = "rollback";
    },
    /is declared kind "rollback", but its filename says "recontract"/,
  );
  refuses(
    (mutated) => {
      mutated.companions[0].sha256 = "not-a-hash";
    },
    /has no sha256/,
  );
  refuses(
    (mutated) => {
      mutated.companions.push({ ...mutated.companions[0] });
    },
    /is listed twice/,
  );
  refuses(
    (mutated) => {
      mutated.companions.reverse();
    },
    /companions is not listed in filename order/,
  );
});

test("a companion smuggled into a phase array is refused as a companion, not as a bad name", () => {
  // A companion listed under required_for_app would be applied by the phase tool
  // AND recorded in supabase_migrations.schema_migrations, which is how a hand-run
  // rollback becomes a permanent part of the history it undoes. The message has to
  // say that, because "not a CLI-applicable filename" reads like a typo.
  const mutated = copy();
  const victim = manifest.companions.at(-1);
  mutated.required_for_app.push({ version: "20260899000000", file: victim.file, sha256: victim.sha256 });
  const problems = auditManifest({ manifest: mutated, files, hashes, baseline: readBaseline() });
  assert.ok(
    problems.some((problem) =>
      new RegExp(
        `required_for_app lists the hand-run companion ${escapeRegExp(victim.file)}; companions are declared under "companions"`,
      ).test(problem),
    ),
    problems.join("\n"),
  );
  // And the committed manifest, through the same function, is clean.
  assert.deepEqual(auditManifest({ manifest, files, hashes, baseline: readBaseline() }), []);
});

// ---------------------------------------------------------------------------
// 3 · one pattern, two programs
// ---------------------------------------------------------------------------

test("both programs decide what a companion is with the same literal", () => {
  // scripts/check-migration-history.mjs is a top-level program with no exports, so
  // the pattern is written twice. Held equal here as source text: if the two ever
  // disagreed, one program would classify a file as history and the other as a
  // hand-run script, and the file would be checked by neither.
  const line = (file) => {
    const found = readFileSync(path.join(ROOT, file), "utf8")
      .split(/\r?\n/)
      .filter((text) => /COMPANION_NAME = /.test(text));
    assert.equal(found.length, 1, `${file} defines COMPANION_NAME ${found.length} time(s)`);
    return found[0].replace(/^(?:export )?const /, "").trim();
  };
  assert.equal(line("scripts/check-release-manifest.mjs"), line("scripts/check-migration-history.mjs"));
  assert.equal(COMPANION_NAME.source, /^(rollback|recontract)_.*\.sql$/.source);
});

test("the applied-history gate still excludes companions, and says why", () => {
  // Not a defect to fix: a companion in the applied-history manifest would be a
  // claim that production ran it. The defect was that nothing else covered them.
  const source = readFileSync(path.join(ROOT, "scripts/check-migration-history.mjs"), "utf8");
  assert.match(source, /!COMPANION_NAME\.test\(/);
});

// ---------------------------------------------------------------------------
// 4 · behaviour: the CLI on a real tree
// ---------------------------------------------------------------------------

test("--verify-companions refuses a mutated tree and passes the committed one", () => {
  const clean = spawnSync(process.execPath, [GATE, "--verify-companions"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, new RegExp(`release companions: ${onDisk.length} hand-run file\\(s\\) match the manifest`));
  for (const file of onDisk) assert.ok(clean.stdout.includes(`companion OK`) && clean.stdout.includes(file), file);

  // A copy of the migrations directory with one companion escalated, exactly as the
  // reproduction did it. The tree is a temporary directory: no repository file is
  // written by this test.
  const dir = mkdtempSync(path.join(tmpdir(), "c45-companions-"));
  try {
    for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql"))) {
      copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(dir, file));
    }
    const victim = "rollback_money_direct_write_contract_phase.sql";
    writeFileSync(
      path.join(dir, victim),
      `${readFileSync(path.join(dir, victim), "utf8")}\ngrant execute on function public.create_contract(jsonb) to authenticated;\n`,
    );
    const escalated = spawnSync(process.execPath, [GATE, "--verify-companions", "--migrations-dir", dir], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(escalated.status, 1);
    assert.match(escalated.stdout, new RegExp(`companion BAD\\s+rollback\\s+${escapeRegExp(victim)}`));
    assert.match(escalated.stderr, /has changed since the manifest was stamped/);
    assert.match(escalated.stderr, /refusing: 1 problem\(s\)/);

    // And an undeclared companion in the same tree, which is the other direction.
    writeFileSync(path.join(dir, "rollback_c45_smuggled.sql"), "-- ROLLS_BACK: nothing\nselect 1;\n");
    const smuggled = spawnSync(process.execPath, [GATE, "--verify-companions", "--migrations-dir", dir], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(smuggled.status, 1);
    assert.match(smuggled.stderr, /rollback_c45_smuggled\.sql is a hand-run companion .* but the manifest does not name it/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--stamp can reach a companion hash, and refuses rather than skipping if it cannot", () => {
  // The stamp rewrites one hash at a time with a pattern anchored on the "file" key
  // it is restamping, so it can never reclassify or add an entry. A companion entry
  // carries "kind" between "file" and "sha256", and the pattern had to be widened
  // for it. Reconstructed here against the real manifest text rather than asserted
  // against the source of the regex, and both halves matter:
  //   * with the tolerance, every companion entry is reachable;
  //   * without it, none of them are — so the widening is load-bearing, and its
  //     absence would have been a stamp that refuses on every companion.
  const text = readFileSync(path.join(ROOT, "infra/release/release-manifest.json"), "utf8");
  const pattern = (file, withKind) =>
    new RegExp(
      `("file"\\s*:\\s*"${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*,\\s*${
        withKind ? `(?:"kind"\\s*:\\s*"[a-z]+"\\s*,\\s*)?` : ""
      }"sha256"\\s*:\\s*")[0-9a-f]{64}(")`,
    );
  for (const entry of manifest.companions) {
    assert.match(text, pattern(entry.file, true), `--stamp cannot reach ${entry.file}`);
    assert.doesNotMatch(text, pattern(entry.file, false), `${entry.file} no longer needs the widened pattern`);
  }
  // The phase entries have no "kind", so the widening must not have made the
  // pattern greedy enough to jump from one entry's filename to another's hash.
  for (const entry of manifest.required_for_app) {
    assert.match(text, pattern(entry.file, true));
    assert.match(text, pattern(entry.file, false));
  }
  // Fail closed: unreachable hash → exit 1 and say so, never "restamped 0 file(s)".
  const source = readFileSync(GATE, "utf8");
  assert.match(source, /--stamp could not find the sha256 for \$\{file\}; fix the manifest by hand/);
  assert.match(source, /function stampableEntries\(manifest\)/);
  assert.match(source, /Array\.isArray\(manifest\.companions\)/);
});

// ---------------------------------------------------------------------------
// 5 · the three places that must run it
// ---------------------------------------------------------------------------

test("CI, the replay harness and the deploy wrapper all run the companion check", () => {
  const ci = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /npm run check:release-companions/);
  const scripts = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts;
  assert.equal(scripts["check:release-companions"], "node scripts/check-release-manifest.mjs --verify-companions");
  // Not informational: a step whose result is discarded is not evidence (F-05).
  const step = ci.indexOf("npm run check:release-companions");
  assert.doesNotMatch(ci.slice(step - 400, step), /continue-on-error:\s*true/);

  // The replay harness checks the content of every companion in the tree before it
  // executes any of them — which is the only form that covers the ones it never
  // executes at all.
  const replay = readFileSync(path.join(ROOT, "scripts/replay-migrations.sh"), "utf8");
  assert.match(replay, /--verify-companions/);
  const check = replay.indexOf("--verify-companions");
  const run = replay.indexOf("BRANCH_ROLLBACKS[@]}\"; do");
  assert.ok(check > 0 && run > 0 && check < run, "the harness executes a companion before verifying its content");

  // And the deploy wrapper, from the candidate SHA's own worktree.
  const wrapper = readFileSync(path.join(ROOT, "infra/systemd/newme-deploy.sh"), "utf8");
  assert.match(wrapper, /\(cd "\$WORKTREE" && "\$NODE_BIN" scripts\/check-release-manifest\.mjs --verify-companions\)/);
  assert.match(wrapper, /^gate=release-companions-verified$/m);
});
