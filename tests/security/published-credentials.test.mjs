import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

// Round-4 A0 · the gate that keeps credentials out of this repository.
//
// scripts/check-published-credentials.mjs reports OK against this tree, which by
// itself proves nothing: a gate that matches nothing also reports OK. So every
// test below reconstructs the *shape* of a site that really was published here
// and requires the gate to reject it, and the negative half requires the shapes
// that flooded the first draft — `| Check | PASS |`, `| Key | Value |`, a route
// inventory with a cell reading `password` — to stay clean.
//
// The fixtures are shapes, not values: no test in this file contains a password
// that ever existed.
import {
  ALLOWLIST,
  auditCommandLine,
  auditData,
  auditPairs,
  auditSource,
  auditText,
  classify,
  isBuildOutput,
  isPlaceholder,
  publishedFiles,
  unescapeJsonStrings,
} from "../../scripts/check-published-credentials.mjs";

const rules = (findings) => findings.map((finding) => finding.rule);

// ---------------------------------------------------------------------------
// The five shapes that were actually in the tree
// ---------------------------------------------------------------------------

test("a table column headed Password with values is rejected", () => {
  // docs/employee-readiness-20260624.md: six identities, five sharing one value.
  const findings = auditText(
    [
      "| Email | Name | Role | Password | Status |",
      "|-------|------|------|----------|--------|",
      "| someone@example.test | A | admin | not-a-real-value-1 | OK |",
      "| another@example.test | B | boss | not-a-real-value-2 | OK |",
    ].join("\n"),
  );
  assert.deepEqual(rules(findings), ["credential-in-table", "credential-in-table"]);
  assert.deepEqual(findings.map((finding) => finding.line), [3, 4]);
});

test("a Field/Value row labelled Password is rejected", () => {
  // docs/context-pack/flight-recorder-phase0.md published one that way, inside a
  // table whose own header says nothing about credentials.
  const findings = auditText(
    ["| Field | Value |", "|---|---|", "| Role | sales |", "| Password | not-a-real-value |"].join("\n"),
  );
  assert.deepEqual(rules(findings), ["credential-in-table"]);
  assert.equal(findings[0].line, 4);
});

test("a credential in prose is rejected", () => {
  // docs/context-pack/11-tanya-feedback-raw.md and the "今天临时密码：" line of
  // the readiness report.
  for (const line of ["- Password: not-a-real-value", "今天临时密码：not-a-real-value", "password = not-a-real-value"]) {
    assert.deepEqual(rules(auditText(line)), ["credential-in-prose"], line);
  }
});

test("the four shapes the prose rule kept missing are rejected", () => {
  // Each of these is a line that really was in this tree and that an earlier
  // revision of the gate reported OK on. They are listed separately from the
  // test above because each one is a different defect in the rule, not a
  // different way of writing the same line.
  const missed = [
    // No word boundary before a CJK label: `今天临时密码：` has none.
    "今天临时密码：not-a-real-value",
    // A backticked value is a value, not a placeholder.
    "- Password: `not-a-real-value`",
    // A value followed by a parenthetical is still a value.
    "- Password: `not-a-real-value` (change on first login)",
    "- 临时密码：`not-a-real-value`（见下方“第一次登录”）",
    // A label with a parenthetical between it and its colon.
    "**Default password** (all accounts): `not-a-real-value`",
    "**初始密码**（所有账号统一）：`not-a-real-value`",
  ];
  for (const line of missed) {
    assert.deepEqual(rules(auditText(line)), ["credential-in-prose"], line);
  }
});

test("a credential passed as a command-line argument is rejected", () => {
  // crm-v3/ops/HANDOFF-20260701.md and a planning transcript published the
  // production database password this way: no label, no table, just a command
  // that worked. This is also why nothing in this repository interpolates a
  // secret into argv.
  const commands = [
    "supabase migration list --linked --password not-a-real-value",
    "psql --password=not-a-real-value",
    "PGPASSWORD=not-a-real-value psql -h host",
    "gh auth login --token not-a-real-value",
  ];
  for (const command of commands) {
    assert.deepEqual(rules(auditCommandLine(command)), ["credential-in-command"], command);
    // Reachable from both audits, because the same paste appears in prose and in
    // shell scripts.
    assert.deepEqual(rules(auditText(command)), ["credential-in-command"], command);
    assert.deepEqual(rules(auditSource(command)), ["credential-in-command"], command);
  }

  // The forms that are documentation rather than a leak.
  for (const command of [
    "supabase migration list --linked --password <your-db-password>",
    "supabase migration list --linked --password $DB_PASSWORD",
    "supabase migration list --linked --password ${DB_PASSWORD}",
    "supabase migration list --linked --password [REDACTED-ROTATE-ME]",
    "psql --password",
  ]) {
    assert.deepEqual(auditCommandLine(command), [], command);
  }
});

test("an environment variable with a literal fallback is rejected", () => {
  // src/app/api/auth/dev-login/route.ts: the variable looked like configuration
  // and the fallback made it a hard-coded password in every unset environment.
  const findings = auditSource('  const DEV_PASSWORD = process.env.DEV_PASSWORD || "not-a-real-value";');
  assert.deepEqual(rules(findings), ["defaulted-credential"]);
  assert.match(findings[0].detail, /falls back to a literal instead of refusing/);

  // `??` is the same defect spelled differently, and so is a service key.
  assert.deepEqual(rules(auditSource('x = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "not-a-real-value"')), ["defaulted-credential"]);
});

test("a credential-named constant assigned a literal is rejected", () => {
  // src/app/api/dev/setup/route.ts, the site the review named.
  assert.deepEqual(rules(auditSource('  const DEV_PASSWORD = "not-a-real-value";')), ["credential-literal"]);
  assert.deepEqual(rules(auditSource("let adminSecret = 'not-a-real-value'")), ["credential-literal"]);
});

// ---------------------------------------------------------------------------
// The four more shapes found only after the gate was made to read everything
// ---------------------------------------------------------------------------

test("a table saved with its line-number gutter is still read as a table", () => {
  // OC-MIGRATION-BRIEF.md is stored with every line prefixed by its own number:
  // `51|| Email | Password |`. No row started with a pipe, so the file had no
  // table rows, no header, and no credential column — and it published two
  // passwords past this gate.
  const gutter = [
    "49|## CRM User Accounts",
    "51|| Email | Password | Role | verified |",
    "52||-------|----------|------|----------|",
    "53|| someone@example.test | not-a-real-value | Boss | ✅ |",
    "54|| another@example.test | — | Operator | ✅ |",
  ].join("\n");
  const findings = auditText(gutter);
  assert.deepEqual(rules(findings), ["credential-in-table"]);
  assert.equal(findings[0].line, 4);

  // The mutation control: the predicate this replaced, applied to the same
  // fixture. If this ever stops returning [], the fixture has stopped
  // discriminating and the test above proves nothing.
  const previous = (content) => {
    const lines = content.split("\n");
    const cellsOf = (line) => line.split("|").slice(1, -1);
    const isSeparatorRow = (line) =>
      /^\s*\|/.test(line) && cellsOf(line).length > 0 && cellsOf(line).every((cell) => /^\s*:?-{2,}:?\s*$/.test(cell));
    return lines.filter((line, index) => /^\s*\|/.test(line) && isSeparatorRow(lines[index + 1] ?? ""));
  };
  assert.deepEqual(previous(gutter), [], "the old predicate must miss this fixture");
  // And a doubled leading pipe alone — no gutter — is caught for the same reason.
  assert.deepEqual(
    rules(auditText(["|| Email | Password |", "||---|---|", "|| someone@example.test | not-a-real-value |"].join("\n"))),
    ["credential-in-table"],
  );
});

test("a credential inside JSON-escaped content is rejected", () => {
  // Two tracked .next.backup sourcemaps carried the dev-setup password in their
  // `sourcesContent`, where every quote is backslash-escaped. No source rule can
  // match through the escapes, and the whole directory was exempt from the scan
  // besides — two independent reasons the same value stayed published after the
  // source was redacted.
  const escaped = String.raw`{"sourcesContent":["const DEV_PASSWORD = \"not-a-real-value\";\nexport {};\n"]}`;
  assert.deepEqual(rules(auditData(escaped)), ["credential-literal"]);
  assert.match(auditData(escaped)[0].detail, /inside JSON-escaped content/);
  // A minified sourcemap is one line, so the finding is reported on line 1 —
  // which is where it is.
  assert.equal(auditData(escaped)[0].line, 1);

  // The mutation control: the same bytes judged as source, which is what the
  // previous revision would have done had it read the file at all.
  assert.deepEqual(auditSource(escaped), []);
  assert.equal(unescapeJsonStrings(String.raw`\"x\"`), '"x"');
  assert.equal(unescapeJsonStrings(String.raw`a\nb`), "a\nb");
  assert.equal(unescapeJsonStrings(String.raw`A`), "A");
  // Routing: .map and .json decode, .ts does not, an unknown extension gets the
  // conservative text rules, and a shebang makes an extensionless file a script.
  assert.equal(classify("chunk.js.map", ""), "data");
  assert.equal(classify("package-lock.json", ""), "data");
  assert.equal(classify("src/route.ts", ""), "source");
  assert.equal(classify("notes.md", ""), "text");
  assert.equal(classify("logs/pm2-error.log", ""), "text");
  assert.equal(classify("scripts/deploy", "#!/usr/bin/env bash\n"), "source");
});

test("a credential as an object property, a dict entry or a tuple element is rejected", () => {
  // test-matrix-runner.mjs and test_matrix.py published four identities this way.
  // The declaration rule only saw `const PASSWORD = ...`.
  for (const line of [
    "  admin: { email: 'a@example.test', password: 'not-a-real-value' },",
    '  data = json.dumps({"password": "not-a-real-value"})',
    "  { apiKey: `not-a-real-value` }",
    "  secret = 'not-a-real-value'",
  ]) {
    assert.ok(rules(auditSource(line)).includes("credential-property"), line);
  }

  // A UI dictionary is not a credential store: every `password:` in
  // src/lib/i18n/translations.ts is the word, in three languages.
  for (const line of ['  password: "Password",', '  password: "密码",', '  password: "Mot de passe",', '  password: "كلمة المرور",']) {
    assert.deepEqual(auditSource(line), [], line);
  }
  // And an environment read, or a call, is the fix rather than the defect.
  assert.deepEqual(auditSource('  ("a@example.test", credential("NEWME_TEST_ADMIN_PASSWORD"), "admin"),'), []);
  assert.deepEqual(auditSource("  password: process.env.DEV_PASSWORD,"), []);
});

test("an address followed by a value is rejected, and an address followed by anything else is not", () => {
  // test-matrix.md wrote logins as prose pairs and test_matrix.py as tuples.
  // Neither contains a credential word, so every label-based rule walked past.
  for (const line of [
    "- admin (admin@example.test / not-a-real-value)",
    '  ("admin@example.test", "not-a-real-value", "admin"),',
    "admin@example.test | not-a-real-value",
  ]) {
    assert.deepEqual(rules(auditPairs(line)), ["credential-pair"], line);
  }

  // What sits beside an address in this repository and is not a secret.
  for (const line of [
    "| admin | SAM | admin@example.test | 3f2504e0-4f89-11d3-9a0c-0305e82c3301 |", // an identifier
    '  consumeRateLimit("a@example.test", OPTIONS, now);', // a constant
    "  ('3f2504e0-4f89-11d3-9a0c-0305e82c3301', 'a@example.test', now(), now()),", // a call
    "  https://not-a-project-key@o1.ingest.sentry.io/12345", // a DSN path
    "- ops@example.test / see docs/runbook.md", // a reference
    "- ops@example.test / tanya@example.test", // a second address
    "- ops@example.test: unchanged", // prose
  ]) {
    assert.deepEqual(auditPairs(line), [], line);
  }
  // In a table the header decides, not adjacency: six rows of a role/name/email/id
  // matrix were reported as credentials before this exclusion.
  assert.deepEqual(auditText("| admin | SAM | admin@example.test | 3f2504e0-4f89-11d3-9a0c-0305e82c3301 |"), []);
});

test("a credential embedded in a URL is rejected, and a URL validator is not", () => {
  for (const line of [
    "postgresql://postgres:not-a-real-value@db.example.test:5432/postgres",
    "  const dsn = 'redis://user:not-a-real-value@cache.example.test:6379'",
  ]) {
    assert.deepEqual(rules(auditPairs(line)), ["credential-in-url"], line);
  }
  for (const line of [
    // The Sentry DSN validator in infra/observability: a pattern, not a URL.
    "local dsn_pattern='^https://([0-9a-f]{32})(:[0-9a-f]{32})?@([a-z0-9-]+[.]ingest[.]sentry[.]io)/([0-9]+)$'",
    "postgres://u:p@h/db", // a one-letter fixture, below every rule's length floor
    "postgresql://postgres:${DB_PASSWORD}@db.example.test/postgres",
    "https://not-a-project-key@o1.ingest.sentry.io/12345", // a DSN has no password
  ]) {
    assert.deepEqual(auditPairs(line), [], line);
  }
});

test("tracked build output is itself a finding", () => {
  // 1634 files under .next.backup/ were tracked because .gitignore listed
  // `.next.backup.*`, which does not match the directory `.next.backup/`. Two of
  // them outlived the redaction of the source they were built from, so the
  // structural fact — generated output is tracked — is reported without reading
  // a single byte.
  for (const file of [
    ".next.backup/server/chunks/x.js.map",
    ".next.backup.1780/server/chunks/x.js",
    ".next/static/chunks/x.js",
    "node_modules/pkg/index.js",
    "crm-v3/.next/static/x.js",
  ]) {
    assert.equal(isBuildOutput(file), true, file);
  }
  for (const file of [
    "src/app/page.tsx",
    "scripts/check-lint-baseline.mjs", // names the pattern, is not the output
    "docs/next-steps.md",
    "tests/release/g0-lite-finalizer.test.mjs",
  ]) {
    assert.equal(isBuildOutput(file), false, file);
  }
});

// ---------------------------------------------------------------------------
// The shapes that must stay clean
// ---------------------------------------------------------------------------

test("redactions and absences are not findings", () => {
  const findings = auditText(
    [
      "| Email | Password | Role |",
      "|---|---|---|",
      "| someone@example.test | [REDACTED — round-4 A0] | admin |",
      "| another@example.test | — | sales |",
      "| third@example.test |  | sales |",
      "| fourth@example.test | <your-password> | sales |",
      "| fifth@example.test | ${DEV_PASSWORD} | sales |",
      "| sixth@example.test | REDACTED, see the preflight | sales |",
    ].join("\n"),
  );
  assert.deepEqual(findings, []);

  for (const value of ["", "—", "-", "n/a", "none", "[REDACTED]", "<set this>", "${X}", "$DEV_PASSWORD", "string", "text"]) {
    assert.equal(isPlaceholder(value), true, value);
  }
  assert.equal(isPlaceholder("not-a-real-value"), false);
});

test("the tables that flooded the first draft stay clean", () => {
  // Bare `pass`, `token` and `key` in the header word list turned every status
  // and key/value table in the repository into a finding.
  const clean = [
    ["| Check | Result |", "|---|---|", "| build | PASS |"],
    ["| Gate | Status |", "|---|---|", "| P0 | 0 |"],
    ["| Key | Value |", "|---|---|", "| build id | 1234 |"],
    ["| 模块 | PASS | FAIL |", "|---|---|---|", "| Leads | 7 | 0 |"],
    // A route inventory: one cell reads `password`, which must not turn its
    // column into a credential column for every row below it.
    [
      "| Route | Method | Resource | Status |",
      "|---|---|---|---|",
      "| /api/users/[id]/password | PATCH | password | covered |",
      "| /api/contracts | POST | contract | covered |",
    ],
  ];
  for (const table of clean) assert.deepEqual(auditText(table.join("\n")), [], table[0]);
});

test("type positions and fixture generators are not credentials", () => {
  assert.deepEqual(auditText("- password: string"), []);
  assert.deepEqual(auditSource("  password: string;"), []);
  assert.deepEqual(auditSource("  password text not null"), []);
  assert.deepEqual(auditSource('  const privateSecret = "e".repeat(32);'), []);
  // Reading a credential from the environment without a default is the fix, not
  // the defect.
  assert.deepEqual(auditSource("  const password = process.env.DEV_PASSWORD;"), []);
});

// ---------------------------------------------------------------------------
// The gate is wired to something
// ---------------------------------------------------------------------------

test("the gate reads everything git publishes, with nothing exempted", () => {
  const files = publishedFiles(process.cwd());
  assert.ok(files.length > 100, `only ${files.length} published files`);

  // This assertion used to run the other way. The previous revision skipped
  // `.next/`, `.next.backup/`, `node_modules/`, `.hermes-harness/` and the
  // lockfiles, on the argument that generated output is a derivative of source
  // the gate already reads. The argument was sound and the conclusion was wrong:
  // the source had been redacted and the 1634 tracked build artifacts had not,
  // so the only remaining copies of the password in the tree were the ones
  // inside the exemption. Generated output is a snapshot of an older source.
  //
  // Nothing is exempt now, so the scope is exactly `git ls-files`.
  const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean);
  assert.deepEqual(files, tracked);

  // And the files this item was about are in scope.
  for (const file of [
    "docs/employee-readiness-20260624.md",
    "docs/context-pack/flight-recorder-phase0.md",
    "docs/context-pack/11-tanya-feedback-raw.md",
    "migration-output/company-profile.md",
    "src/app/api/auth/dev-login/route.ts",
    "src/app/api/dev/setup/route.ts",
    // Batch 0: the four sites the first revision could not see.
    "OC-MIGRATION-BRIEF.md",
    "test-matrix.md",
    "test-matrix-runner.mjs",
    "test_matrix.py",
    // Tracked production logs, 5.5MB of them, never scanned before either.
    "logs/pm2-error.log",
  ]) {
    assert.ok(files.includes(file), `${file} is not covered by the gate`);
  }
});

test("every allowlist entry names a file git still tracks, with a reason", () => {
  // An exemption that outlives its file is how a gate quietly stops covering
  // something: the path goes away, the entry stays, and whatever is written at
  // that path next inherits the exemption without anyone arguing for it.
  const tracked = new Set(publishedFiles(process.cwd()));
  for (const [file, entries] of Object.entries(ALLOWLIST)) {
    assert.ok(tracked.has(file), `${file} is allowlisted but git does not track it — drop the entry`);
    for (const [name, reason] of Object.entries(entries)) {
      assert.equal(typeof reason, "string", `${file} :: ${name} has no reason`);
      assert.ok(reason.length > 30, `${file} :: ${name} needs a reason, not a label`);
    }
  }
});

test("no build output is tracked, so the exemption cannot come back by accident", () => {
  // The gate reports tracked build output as a finding, which makes this
  // redundant on a green tree — and that is the point: if `.gitignore` regresses,
  // this names the cause instead of leaving 1634 findings to be read.
  const tracked = publishedFiles(process.cwd()).filter(isBuildOutput);
  assert.deepEqual(tracked, [], `${tracked.length} build artifacts are tracked`);

  // `.next.backup.*` never matched the directory `.next.backup/`. That single
  // missing slash is why they were tracked at all.
  const ignore = readFileSync(new URL("../../.gitignore", import.meta.url), "utf8");
  assert.match(ignore, /^\.next\.backup\/$/m, ".gitignore must ignore the directory, not only its timestamped siblings");
  assert.match(ignore, /^\.next\/$/m);
});
