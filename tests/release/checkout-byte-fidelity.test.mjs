// ============================================================================
// Round-4 C4-7: a checkout may not rewrite the release
// ============================================================================
// The failing behaviour, measured on 166101e2ad6 before `.gitattributes` existed,
// in a real `git worktree` on a host with the Windows default core.autocrlf=true:
//
//   126 of 126 supabase/migrations/*.sql, 29 of 29 scripts/*.sh, 27 of 27
//   scripts/*.mjs and 5 of 5 infra/systemd/*.sh came out CRLF;
//   `git status` was empty — the checkout reported nothing wrong;
//   tests/release: 259 tests, 250 pass, 9 fail across 6 files;
//   scripts/verify-remote-migration-history.mjs refused with
//   local_content_line_endings for 120 of 120 files.
//
// The same worktree at the same commit with `.gitattributes` in place and
// core.autocrlf still forced to true: 0 CRLF, 259 pass, 0 fail. An LF control
// worktree at the same commit failed nothing, so the nine failures are
// attributable to line endings and to nothing else.
//
// None of those nine were about production. They are assertions whose regexes
// carry `\n` or `$`, matched against a script this release ships — a rewritten
// file is a false accusation, and re-running cannot clear it. The two wrong ways
// to make it green are to loosen every such regex and to stop running the tests
// on Windows; C4-7 forbids the second explicitly, so the fix is that the checkout
// hands over the committed bytes, and the last test here is what keeps it honest.
//
// The gate's own CRLF refusal stays where it is. `.gitattributes` governs a git
// checkout; a tree that reached the host as an archive, a copy or an rsync has no
// attributes applied to it, and for that tree the refusal is the only thing
// standing between a rewritten file and a byte-equivalence claim. Removing it
// would trade a false red for a false green.
import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  auditHistory,
  readLocalContent,
  readLocalMigrations,
} from "../../scripts/verify-remote-migration-history.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const git = (args) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const gitZ = (args) => git(args).split("\0").filter(Boolean);

/**
 * The families whose bytes this release makes claims about: migration content the
 * remote-history gate fingerprints against what production recorded, replay
 * expectations compared line by line, shell the production host executes, and the
 * release declarations everything else is measured against.
 */
const BYTE_SENSITIVE = ["supabase", "scripts", "infra", "tests", ".github"];

/**
 * The four blobs committed with mixed line endings before the rule existed. They
 * are pinned here rather than tolerated by a pattern: a fifth one appearing is a
 * question for a reviewer, not something this test should absorb.
 */
const MIXED_EOL_EXEMPTIONS = [
  "build.log",
  "docs/meta-ads-auth-instructions.txt",
  "src/app/api/leads/[id]/quality/route.ts",
  "tests/integration/api-validation-static.test.mjs",
];

/** The six files whose tests a CRLF checkout failed. Deleting one would make this fix vacuous. */
const CRLF_SENSITIVE_TESTS = [
  "tests/release/control-plane-bootstrap-contract.test.mjs",
  "tests/release/database-phase-coupling.test.mjs",
  "tests/release/deploy-release-claim-validation.test.mjs",
  "tests/release/g0-lite-deploy-contract.test.mjs",
  "tests/release/production-rollback-controller.test.mjs",
  "tests/release/replay-concurrency-gate-contract.test.mjs",
];

/**
 * Every skip in the test tree, by file and count. All three are legacy cases
 * superseded by a Node gate contract and named as such; none is conditional on a
 * platform. The list is exact so that a new skip has to be added here, where the
 * reason has to be written down.
 */
const DECLARED_SKIPS = new Map([["tests/security/supply-chain-gate.test.mjs", 3]]);

const SKIP_CALL = /\b(?:test|it|describe|suite)\s*\.\s*(?:skip|todo)\b|(?<![\w$."'])(?:skip|todo)\s*:/g;
const PLATFORM = /\bwin32\b|process\.platform/;

/** The object id git would record for these exact bytes, so byte identity is checkable without git. */
const blobId = (bytes) =>
  crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

/**
 * How git classifies the line endings of every tracked blob: `i/lf`, `i/crlf`,
 * `i/mixed`, `i/none` for a blob with no line ending at all, and `i/-text` for one
 * git detected as binary. This is git's own answer, not a scan of the bytes, so
 * "binary" below means what git will act on.
 */
const indexEol = () =>
  git(["ls-files", "--eol"])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [indexEolClass, worktreeEol, attr, ...rest] = line.split(/\s+/);
      return { indexEol: indexEolClass, worktreeEol, attr, file: rest.join(" ").replace(/^\t/, "") };
    });

test("the repository declares one line-ending rule for every text file", () => {
  const attributes = readFileSync(path.join(ROOT, ".gitattributes"), "utf8");
  const lines = attributes
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  assert.ok(
    lines.some((line) => /^\*\s+text=auto\s+eol=lf$/.test(line)),
    "`.gitattributes` must carry `* text=auto eol=lf`: without eol=lf a checkout under core.autocrlf=true rewrites the release",
  );
  // The exemptions are `-text`, never `eol=crlf`: the point is to leave those
  // bytes alone, and a rule that converts them would report them modified for
  // ever in every working tree.
  assert.equal(
    lines.filter((line) => /eol=crlf/.test(line)).length,
    0,
    "no path in this repository may be checked out with CRLF",
  );
  for (const exempt of MIXED_EOL_EXEMPTIONS) {
    const pattern = exempt.replace(/[[\]]/g, (bracket) => `\\${bracket}`);
    assert.ok(
      lines.includes(`${pattern} -text`),
      `${exempt} has mixed line endings in the index and must be declared \`-text\``,
    );
  }
});

test("every byte-sensitive tracked file resolves to eol=lf", () => {
  const files = gitZ(["ls-files", "-z", "--", ...BYTE_SENSITIVE]);
  // 386 at the time of writing. The floor is a guard against the families being
  // renamed out from under this test, which would leave it passing over nothing.
  assert.ok(files.length > 300, `expected the byte-sensitive families to be populated, got ${files.length}`);

  const resolved = execFileSync("git", ["check-attr", "-z", "--stdin", "text", "eol"], {
    cwd: ROOT,
    input: `${files.join("\0")}\0`,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  })
    .split("\0")
    .filter((field, index, all) => index + 1 < all.length || field !== "");

  const attributes = new Map();
  for (let index = 0; index + 2 < resolved.length + 1; index += 3) {
    const [file, name, value] = resolved.slice(index, index + 3);
    if (!file) continue;
    if (!attributes.has(file)) attributes.set(file, {});
    attributes.get(file)[name] = value;
  }

  // Two kinds of file are legitimately not converted, and both are safe for the
  // same reason: git will not touch their bytes either. Binary is taken from the
  // index classification rather than an extension list, so this cannot be widened
  // by inventing a suffix. Everything else has to be `text=auto` with `eol=lf`.
  const binary = new Set(indexEol().filter((row) => row.indexEol === "i/-text").map((row) => row.file));
  const exempt = new Set([...binary, ...MIXED_EOL_EXEMPTIONS]);

  const offenders = [];
  const untouchable = [];
  for (const file of files) {
    const attribute = attributes.get(file) ?? {};
    if (exempt.has(file)) {
      // For these the claim is the opposite one: the checkout must be unable to
      // convert them at all.
      if (attribute.text !== "unset") untouchable.push(`${file} (text=${attribute.text})`);
      continue;
    }
    // `text=auto` plus `eol=lf` is what makes convert-to-working-tree a no-op.
    // Anything else — unspecified, unset, crlf — is a file the checkout is free
    // to rewrite, and every claim this release makes about it is then about a
    // file production never saw.
    if (attribute.eol !== "lf" || (attribute.text !== "auto" && attribute.text !== "set")) {
      offenders.push(`${file} (text=${attribute.text}, eol=${attribute.eol})`);
    }
  }
  assert.deepEqual(offenders, [], `byte-sensitive files a checkout may rewrite:\n  ${offenders.join("\n  ")}`);
  assert.deepEqual(untouchable, [], `exempt files that are still convertible:\n  ${untouchable.join("\n  ")}`);
  // The exemption is narrow, and it has to stay narrow or the assertion above
  // becomes an assertion about nothing.
  assert.ok(
    files.filter((file) => exempt.has(file)).length < 10,
    "too many byte-sensitive files are exempt from the line-ending rule",
  );

  // Negative control: the instrument has to be able to say no. build.log is
  // deliberately `-text`, so an assertion that "every file is text=auto" being
  // true everywhere would mean check-attr was not being read at all.
  const control = git(["check-attr", "text", "--", "build.log"]);
  assert.match(control, /text: unset/);
});

test("no tracked blob carries CRLF except the four declared exemptions", () => {
  const rows = indexEol();
  assert.ok(rows.length > 900, `expected the whole index, got ${rows.length} rows`);

  const carriesCr = rows.filter((row) => row.indexEol === "i/crlf" || row.indexEol === "i/mixed");
  assert.deepEqual(
    carriesCr.map((row) => row.file).sort(),
    [...MIXED_EOL_EXEMPTIONS].sort(),
    "a blob with CRLF in the index was committed: `* text=auto eol=lf` normalises on write, so this means the rule was bypassed",
  );
  for (const row of carriesCr) {
    assert.equal(
      row.attr,
      "attr/-text",
      `${row.file} has CR in the index and must be \`-text\`, or every working tree reports it modified for ever`,
    );
  }
});

test("a checkout under core.autocrlf=true writes the committed bytes, not converted ones", () => {
  const files = gitZ(["ls-files", "-z", "--", ...BYTE_SENSITIVE]);
  const staged = new Map(
    git(["ls-files", "--stage", "--", ...BYTE_SENSITIVE])
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [meta, file] = line.split("\t");
        return [file, meta.split(/\s+/)[1]];
      }),
  );

  const scratch = mkdtempSync(path.join(os.tmpdir(), "newme-checkout-fidelity-"));
  try {
    // The hostile setting is forced rather than inherited, so this measures the
    // same thing on the Windows box, on CI and in a pinned verification worktree.
    execFileSync("git", ["-c", "core.autocrlf=true", "checkout-index", "-z", "--stdin", `--prefix=${scratch.replace(/\\/g, "/")}/`], {
      cwd: ROOT,
      input: `${files.join("\0")}\0`,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });

    const rewritten = [];
    for (const file of files) {
      const bytes = readFileSync(path.join(scratch, file));
      if (blobId(bytes) !== staged.get(file)) rewritten.push(file);
    }
    assert.deepEqual(
      rewritten.slice(0, 10),
      [],
      `${rewritten.length} of ${files.length} file(s) came out of the checkout with different bytes than were committed`,
    );

    // Negative control: the same comparison must fail for a file that really was
    // rewritten, or "no file differs" would only mean the check is blind.
    const sample = files.find((file) => file.startsWith("supabase/migrations/"));
    const asCommitted = readFileSync(path.join(scratch, sample));
    const asRewritten = Buffer.from(asCommitted.toString("utf8").replace(/\n/g, "\r\n"), "utf8");
    assert.notEqual(blobId(asRewritten), staged.get(sample));
    assert.equal(blobId(asCommitted), staged.get(sample));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the content gate still refuses a rewritten tree", () => {
  // `.gitattributes` is not applied to a tree that arrived as an archive or a
  // copy, so the refusal is the only defence left for that tree. C4-7 asks for
  // the false red to go away; it does not ask for the measurement to.
  const scratch = mkdtempSync(path.join(os.tmpdir(), "newme-crlf-refusal-"));
  try {
    const dir = path.join(scratch, "migrations");
    mkdirSync(dir);
    const name = "20260101000000_rewritten.sql";
    writeFileSync(path.join(dir, name), "select 1;\r\nselect 2;\r\n");
    const entries = readLocalMigrations(dir);
    const content = readLocalContent(dir, entries);
    assert.equal(content.get("20260101000000").crlf, true);

    const remote = entries.map((entry) => ({
      version: entry.version,
      name: entry.name,
      statements: ["select 1", "select 2"],
    }));
    const refused = auditHistory({ remote, local: entries, localContent: content });
    assert.ok(
      refused.findings.some((finding) => finding.kind === "local_content_line_endings"),
      "a CRLF working file must still be refused by cause instead of compared",
    );

    // And the same tree with LF is not refused for that reason — otherwise the
    // refusal would be unconditional and would say nothing about line endings.
    writeFileSync(path.join(dir, name), "select 1;\nselect 2;\n");
    const lfContent = readLocalContent(dir, readLocalMigrations(dir));
    assert.equal(lfContent.get("20260101000000").crlf, false);
    const accepted = auditHistory({ remote, local: entries, localContent: lfContent });
    assert.equal(
      accepted.findings.some((finding) => finding.kind === "local_content_line_endings"),
      false,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("no test was deleted or skipped to make the line-ending problem go away", () => {
  const testFiles = gitZ(["ls-files", "-z", "--", "tests/**/*.test.mjs"]);
  assert.ok(testFiles.length > 50, `expected the test tree, got ${testFiles.length} files`);

  for (const file of CRLF_SENSITIVE_TESTS) {
    assert.ok(testFiles.includes(file), `${file} failed under a CRLF checkout and must still be present`);
    const body = readFileSync(path.join(ROOT, file), "utf8");
    assert.ok(/^test\(/m.test(body), `${file} must still register tests`);
  }

  const skips = new Map();
  const platformGated = [];
  for (const file of testFiles) {
    const body = readFileSync(path.join(ROOT, file), "utf8");
    const lines = body.split(/\r?\n/);
    SKIP_CALL.lastIndex = 0;
    const found = [...body.matchAll(SKIP_CALL)];
    if (found.length > 0) skips.set(file, found.length);

    // The operating system may choose a path or an interpreter — six files do
    // exactly that, in their header, so that a POSIX path reaches Git Bash. What
    // it may not do is decide whether a test runs, and an early `return` inside a
    // test body suppresses coverage just as effectively as `.skip` while matching
    // no skip pattern at all. So the rule is positional and needs no pattern: the
    // host platform may be consulted while the file is setting itself up, and not
    // once it has started registering tests. Prose is not code, so comments are
    // stripped first — this file's own explanation of the rule would trip it.
    const firstRegistration = lines.findIndex((line) => /^(?:test|describe|it)\s*\(/.test(line));
    if (firstRegistration < 0) continue;
    lines.forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
      if (index > firstRegistration && PLATFORM.test(code)) platformGated.push(`${file}:${index + 1}`);
    });
  }

  assert.deepEqual(
    platformGated,
    [],
    `a test consults the host platform after registration begins, which can only narrow what runs:\n  ${platformGated.join("\n  ")}`,
  );
  assert.deepEqual(
    [...skips.entries()].sort(),
    [...DECLARED_SKIPS.entries()].sort(),
    "the set of skipped tests changed: a skip has to be declared here with its reason",
  );
});
