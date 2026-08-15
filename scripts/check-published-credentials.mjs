#!/usr/bin/env node
// ============================================================================
// Gate: no credential value may be published in this repository
// ============================================================================
// Round-4 review A0 recorded one hard-coded password, in
// src/app/api/dev/setup/route.ts. Closing it turned up four more publication
// sites for six identities covering admin, boss, operator and sales:
//
//   src/app/api/auth/dev-login/route.ts     process.env.DEV_PASSWORD || "<literal>"
//   docs/employee-readiness-20260624.md     a table of six logins, five sharing one password
//   docs/context-pack/11-tanya-feedback-raw.md  one login in prose
//   migration-output/company-profile.md     two more logins in a table
//
// Every one of them was added by someone recording something true. None of them
// was noticed again. That is the failure this gate exists for: a redaction that
// nothing enforces is a redaction that lasts until the next handover document.
//
// The first revision of this gate reported OK on a tree that was still
// publishing plaintext passwords for four more identities, in four more files,
// for three independent reasons. Each is now a rule, and each has a fixture:
//
//   .next.backup/**/*.js.map            1634 tracked build artifacts, exempted by
//                                       path prefix. Two carried the password
//                                       above, JSON-escaped so no source rule
//                                       could match. → nothing is exempted now,
//                                       and .map/.json are decoded before judging.
//   OC-MIGRATION-BRIEF.md               saved with its line-number gutter baked
//                                       in ("53|| a@b | value |"), so no row
//                                       started with a pipe, so no row was a
//                                       table row, so its Password column was
//                                       never found. → the gutter is stripped.
//   test-matrix{-runner.mjs,.md,_matrix.py}  password as an object property, as a
//                                       tuple element, and as "email / value"
//                                       prose — three shapes no rule covered.
//
// The lesson is in the arithmetic: 5 sites found by reading, 4 more found only
// after the gate was made to read everything. Scope was the bug, not the regexes.
//
// It reports LOCATIONS and RULES, never values — a gate that printed what it
// found would republish the secret into every CI log that ran it.
//
// Scope is `git ls-files`, so it sees exactly what is published, and it reads
// the working tree, so it cannot answer for git history. History is the reason
// redaction is not remediation: see supabase/preflight/f02-credential-cutover.md.
//
// Usage:
//   node scripts/check-published-credentials.mjs            # gate; exit 1 on findings
//   node scripts/check-published-credentials.mjs --list      # rules and allowlist
//
// The judgements are exported as pure functions so
// tests/security/published-credentials.test.mjs can mutation-test them against
// fixtures rather than against this tree, which by construction is clean.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Cells and values that are an explicit absence rather than a credential.
 *
 * `—` and `-` are how the existing tables spell "not recorded"; the bracketed
 * and interpolated forms are how a template spells "supply your own".
 */
const PLACEHOLDER = /^(|[-—–]|n\/?a|none|unknown|tbd|\?+|\.{3}|\[[^\]]*\]|<[^>]*>|\$\{[^}]*\}|\$[A-Z_]+|\*+)$/i;

/**
 * Column headers, and `| Field | Value |` row labels, that mean "the cell beside
 * this is a credential".
 *
 * Deliberately narrow. A first draft included bare `pass`, `token` and `key`,
 * and flagged every `| Check | PASS |` and `| Key | Value |` table in the
 * repository — 39 rows of noise around 2 real findings. A gate that has to be
 * skimmed is a gate that gets skipped.
 */
const CREDENTIAL_COLUMN = /^\s*\**\s*(password|passwd|credentials?|secret|api[ _-]?key|(access|refresh|service[ _-]role)[ _-]token|口令|密码|凭据|密钥)\s*\**\s*$/i;

/**
 * Prose labels that mean "what follows is a credential".
 *
 * Two alternatives, because the boundary rules differ: an ASCII label needs one
 * so that `set_password:` does not match, and a CJK label must not have one —
 * `今天临时密码：<value>` has no separator before 密码, and requiring one is how
 * the first draft of this gate missed a line that really was publishing a
 * password.
 */
// The `(...)` group is for `**Default password** (all accounts): <value>`, which
// is a label with a parenthetical between it and its colon.
const CREDENTIAL_LABEL = /(?:(?:^|[\s*_·•\-])(?:password|passwd|credential)|口令|密码)\**\s*(?:[（(][^)）]*[)）])?\s*[:：=]\s*(\S.*)$/i;

/**
 * Environment variables whose value is a credential, for the defaulted-fallback
 * rule. `KEY` is included because `SUPABASE_SERVICE_ROLE_KEY` is one.
 */
const CREDENTIAL_ENV = /^[A-Z0-9_]*(PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL|KEY)[A-Z0-9_]*$/;

/**
 * Credentials passed on a command line, which is how the production database
 * password was published: `supabase migration list --linked --password <value>`
 * in a handover document and in a planning transcript. No label, no table, no
 * assignment — just a pasted command that worked.
 *
 * This rule applies to prose and to source, because the same paste appears in
 * both, and it is the reason the environment variables in this repository are
 * passed through rather than interpolated into argv.
 */
const CREDENTIAL_ARGUMENT = /(--(?:password|token|secret|api[_-]?key|access[_-]?key)(?:=|\s+)|PGPASSWORD=|MYSQL_PWD=)(["'`]?)([^\s"'`,)]+)\2/gi;

/**
 * A credential as an object property, dict entry or positional tuple element:
 * `password: 'x'`, `"password": "x"`, `("a@b.test", "x", "admin")`.
 *
 * The `credential-literal` rule only saw declarations (`const PASSWORD = ...`),
 * so all three shapes below published a password past it. The tuple form is
 * matched by the pair rule instead — there is no label to key on inside
 * `("a@b.test", "x", "admin")`, only adjacency to an address.
 */
const CREDENTIAL_PROPERTY =
  /(?:^|[{,(\s])(["']?)(password|passwd|secret|credential|api[_-]?key)\1\s*(?::|=>|=)\s*(["'`])([^"'`]*)\3/gi;

/**
 * An address immediately followed by a value: `admin@newme.ae / x`,
 * `("admin@newme.ae", "x", ...)`. This is how humans write down a login, and it
 * carries no credential word at all, so every label-based rule walks past it.
 *
 * The separator must be spaced (`a@b.test / x`) or a comma (`"a@b.test", "x"`).
 * An unspaced slash is a URL path — `key@o1.ingest.sentry.io/12345` is a DSN, and
 * the first draft of this rule reported its project id as a credential.
 */
const CREDENTIAL_PAIR = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+["']?(?:\s+[/|:]\s+|\s*,\s*)["']?([^\s"'`,;()[\]{}<>]+)/g;

/** A v4-shaped identifier. Identifiers sit beside addresses; secrets do not. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A credential inside a URL: `postgresql://user:password@host`. This is the shape
 * a connection string leaks in, and it appears in prose, in source, in logs and
 * in lockfile registry entries alike, so it is checked on every line of every
 * file. A Sentry DSN (`https://key@host`, no colon) is deliberately not matched.
 */
const CREDENTIAL_URL = /\b[a-z][\w+.-]*:\/\/[^\s:@/]+:([^\s:@/]+)@/gi;

/**
 * A pasted line-number gutter: `53|| a@b.test | value |`.
 *
 * OC-MIGRATION-BRIEF.md is stored this way — every line begins with its own
 * number and a pipe. The table rules require a row to start with a pipe, so the
 * file had no table rows, no header row, and no credential column, and it
 * published two passwords past this gate for a year. Stripping the gutter is
 * safe: a markdown table cannot begin with a bare number followed by a pipe.
 */
const GUTTER = /^\s*\d+\|/;

/** Tracked build output: generated, unreviewed, and derived from source. */
const BUILD_OUTPUT = /(^|\/)(\.next|\.next\.backup[^/]*|\.next\.bak[^/]*|node_modules)\//;

/** True if `file` is generated build output that git should not be carrying. */
export const isBuildOutput = (file) => BUILD_OUTPUT.test(file.split(path.sep).join("/"));

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".sh", ".sql", ".py", ".yml", ".yaml"]);
const TEXT_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst"]);
/** Files whose strings are JSON-escaped, so source rules cannot see into them. */
const DATA_EXTENSIONS = new Set([".map", ".json"]);

/**
 * Known credential-shaped literals that are not credentials, each with the
 * reason it is allowed. Keyed by path, then by the identifier, label, or — where
 * the rule matches a shape with no name in it — the rule name. A new entry has
 * to be argued for in a diff rather than added by drift.
 *
 * Deliberately not keyed by line number: those move, and a rule that stops
 * matching because a file grew is a rule that has stopped working.
 */
export const ALLOWLIST = {
  "tests/security/auth-login-endpoint.test.mjs": {
    SECRET_PASSWORD: "a fixture value for the login route's own tests; it is not a credential for anything that exists",
  },
  "scripts/check-e2e-secrets.mjs": {
    "credential-pair": "the E2E secret gate builds the shape it rejects as its own negative fixture",
  },
  "scripts/check-published-credentials.mjs": {
    __self: "this file names the rules it enforces and must be able to quote its own patterns",
  },
  "tests/security/published-credentials.test.mjs": {
    __self: "the gate's tests must contain fixtures that the gate rejects",
  },
  "tests/security/dev-identity-bootstrap.test.mjs": {
    // Found by this gate against the commit rather than the working tree: the
    // file was still untracked while it was being written, and this gate reads
    // `git ls-files`, so a green local run said nothing about it. That is the
    // right way round — CI reads the commit, which is what is published — but it
    // means a local OK covers only what git already tracks.
    PASSWORD: "the fixture environment these tests configure; it is not a credential for anything that exists",
    DEV_PASSWORD: "the removed `process.env.DEV_PASSWORD || <literal>` shape, quoted so the negative half proves the rule still fires",
  },
  "tests/release/ci-full-stack-gates-contract.test.mjs": {
    // Found by this gate, on its first run after that test was written, which is
    // the behaviour asked for: the fixture is the shape of the site the gate
    // exists for. Keyed to the one identifier rather than to the file, so a
    // second credential-shaped literal there is still a finding.
    DEV_PASSWORD: "a fixture proving the finding shape carries no value; `not-a-real-value` is not a credential for anything that exists",
  },
};

const allowed = (file, name) => {
  const entry = ALLOWLIST[file.split(path.sep).join("/")];
  return Boolean(entry && (entry.__self || (name && entry[name])));
};

/** True if `value` carries no credential material. */
export function isPlaceholder(value) {
  let trimmed = String(value ?? "").trim();
  // In markdown a backticked value is a value: `Password: `123456`` was
  // published in an onboarding guide, and an earlier revision of this list
  // treated any `...` span as a placeholder and walked straight past it. Strip
  // the ticks and judge what is inside.
  const backticked = /^`+([^`]*)`+$/.exec(trimmed);
  if (backticked) trimmed = backticked[1].trim();
  if (PLACEHOLDER.test(trimmed)) return true;
  // A redaction notice may be a sentence rather than a bare `[REDACTED]` cell,
  // and may wrap across lines in a table cell.
  if (/^\[?\s*(redacted|removed|rotated|withheld|masked)/i.test(trimmed)) return true;
  // TypeScript/SQL type positions: `password: string`, `password text not null`.
  if (/^(string|number|boolean|any|unknown|null|undefined|text|varchar|char|uuid|bytea)\b/i.test(trimmed)) return true;
  return false;
}

/**
 * Findings for one markdown/text file: a table column headed "Password" whose
 * cells are not placeholders, or a prose "Password: ..." line.
 *
 * @returns {Array<{line: number, rule: string, detail: string}>}
 */
export function auditText(content) {
  const findings = [];
  const lines = content.split(/\r?\n/).map((line) => line.replace(GUTTER, ""));
  const cellsOf = (line) => line.split("|").slice(1, -1);
  const isDashes = (cell) => /^\s*:?-{2,}:?\s*$/.test(cell);
  // Empty cells are ignored rather than disqualifying. A doubled pipe — from a
  // stripped gutter, or from hand-editing — puts an empty cell in the row, and
  // requiring *every* cell to be dashes then classified the separator as data,
  // which left the header undetected and the whole table unread.
  const isSeparatorRow = (line) => {
    if (!/^\s*\|/.test(line)) return false;
    const cells = cellsOf(line);
    return cells.some(isDashes) && cells.every((cell) => !/\S/.test(cell) || isDashes(cell));
  };
  /** @type {number[]|null} indexes of credential columns in the current table */
  let credentialColumns = null;

  lines.forEach((line, index) => {
    const isTableRow = /^\s*\|/.test(line);
    if (!isTableRow) {
      credentialColumns = null;
    } else {
      const cells = cellsOf(line);
      const isSeparator = isSeparatorRow(line);
      // A header row is the row a separator row follows — the markdown rule, and
      // the reason this is not "the first row I have not classified yet". The
      // looser version treated every unmatched data row as a candidate header, so
      // one cell reading `password` in a route-inventory table declared its whole
      // column a credential and flagged every row below it.
      const isHeader = !isSeparator && isSeparatorRow(lines[index + 1] ?? "");

      if (isHeader) {
        const columns = cells.flatMap((cell, position) => (CREDENTIAL_COLUMN.test(cell) ? [position] : []));
        credentialColumns = columns.length > 0 ? columns : null;
      } else if (!isSeparator) {
        if (credentialColumns !== null) {
          for (const position of credentialColumns) {
            if (!isPlaceholder(cells[position])) {
              findings.push({
                line: index + 1,
                rule: "credential-in-table",
                detail: `column ${position + 1} of a table headed as a credential carries a value`,
              });
            }
          }
        }

        // `| Field | Value |` tables carry the label in the row rather than the
        // header, which is how one of the five sites this gate was written for
        // published a password. Two cells, first one is the label.
        if (cells.length === 2 && CREDENTIAL_COLUMN.test(cells[0]) && !isPlaceholder(cells[1])) {
          findings.push({
            line: index + 1,
            rule: "credential-in-table",
            detail: "a row labelled as a credential carries a value",
          });
        }
      }
    }

    // The command rule is the more specific reading of `--password=<value>`, so
    // a line it claims is not also reported as prose: one site, one finding.
    const command = auditCommandLine(line, index);
    findings.push(...command);

    const label = CREDENTIAL_LABEL.exec(line);
    if (label && !isTableRow && command.length === 0) {
      // Prose only, and only the first token: the published lines were
      // `Password: <value> (change on first login)` and
      // `临时密码：<value>（首次登录后修改）`, so judging the whole remainder —
      // which contains whitespace and therefore "is a sentence, not a value" —
      // walked past both of them.
      const token = label[1].trim().split(/[\s（()，,、]/)[0];
      if (looksLikeValue(token)) {
        findings.push({ line: index + 1, rule: "credential-in-prose", detail: "a credential label is followed by a value" });
      }
    }

    // In a table the header decides which column is a credential, and adjacency
    // does not: `| role | name | email | user id |` puts an identifier next to
    // every address. Running the pair rule here reported six such rows in
    // RLS_MATRIX_TEST_REPORT.md as published credentials.
    if (!isTableRow) findings.push(...auditPairs(line, index));
  });

  return findings;
}

/**
 * True if `token` carries credential material rather than prose or a type.
 *
 * Shared by the prose and pair rules, which have the same problem: the value sits
 * in a sentence, so "has no whitespace" is the only structural signal available.
 */
function looksLikeValue(token) {
  return (
    !isPlaceholder(token) &&
    token.length >= 4 &&
    /[A-Za-z0-9]/.test(token) && // pure prose, CJK included, is not a value
    !/^[a-z_]+\??$/.test(token) && // `password: required`, `password: string`
    !/^[A-Z][a-z]+$/.test(token) // `Password: Unchanged`
  );
}

/**
 * Findings for one line of any kind: an address followed by a value, and a
 * credential embedded in a URL.
 *
 * @returns {Array<{line: number, rule: string, detail: string}>}
 */
export function auditPairs(line, index = 0) {
  const findings = [];

  for (const match of line.matchAll(CREDENTIAL_PAIR)) {
    const token = match[1].replace(/[)\],.;:!?]+$/, "");
    // Everything beside an address that is demonstrably not a secret. This rule
    // has no credential word to lean on, so adjacency alone must not accuse:
    //   a path or URL      `ops@newme.ae / see docs/runbook.md`
    //   a second address   a contact list
    //   an identifier      `| admin@newme.ae | <user uuid> |`
    //   a constant or call `consumeRateLimit("a@b.test", OPTIONS, now)`
    // `Faheem@2026` is a value and not an address: the address test is for a
    // dotted domain, not for the `@`.
    if (/[/\\]/.test(token)) continue;
    if (/@[\w-]+(?:\.[\w-]+)+$/.test(token)) continue;
    if (UUID.test(token)) continue;
    if (/^[A-Z][A-Z0-9_]*$/.test(token)) continue;
    if (looksLikeValue(token)) {
      findings.push({ line: index + 1, rule: "credential-pair", detail: "an address is followed by a value" });
    }
  }

  for (const match of line.matchAll(CREDENTIAL_URL)) {
    const password = match[1];
    // A URL-embedded password is percent-encoded, so regex metacharacters mean
    // this is a pattern that validates URLs rather than a URL — the Sentry DSN
    // validator in infra/observability/ is the case that proved it. The length
    // floor matches every other rule and clears `postgres://u:p@h/db` fixtures.
    if (password.length < 4 || /[[\](){}?*+^$\\|]/.test(password)) continue;
    if (!isPlaceholder(password)) {
      findings.push({ line: index + 1, rule: "credential-in-url", detail: "a URL carries a password before its host" });
    }
  }

  return findings;
}

/**
 * Findings for one line of either kind: a credential handed to a command as an
 * argument.
 *
 * @returns {Array<{line: number, rule: string, detail: string}>}
 */
export function auditCommandLine(line, index = 0) {
  const findings = [];
  for (const match of line.matchAll(CREDENTIAL_ARGUMENT)) {
    const [, flag, , value] = match;
    if (isPlaceholder(value)) continue;
    findings.push({
      line: index + 1,
      rule: "credential-in-command",
      detail: `${flag.trim()} carries a value on a command line`,
    });
  }
  return findings;
}

/**
 * Findings for one source file: a credential environment variable with a string
 * default, or a credential-named constant assigned a literal.
 *
 * The first rule is the one that mattered: `process.env.DEV_PASSWORD || "..."`
 * reads as configuration and behaves as a hard-coded password.
 *
 * @returns {Array<{line: number, rule: string, detail: string}>}
 */
export function auditSource(content, { isAllowed = () => false } = {}) {
  const findings = [];
  content.split(/\r?\n/).forEach((line, index) => {
    findings.push(...auditCommandLine(line, index));
    findings.push(...auditPairs(line, index));

    for (const match of line.matchAll(CREDENTIAL_PROPERTY)) {
      const [, , name, , value] = match;
      // `password: "Password"`, `password: "密码"`, `password: "Mot de passe"`:
      // src/lib/i18n/translations.ts is a dictionary of UI labels, and every
      // `password:` in it is the word, in three languages. A label is short and
      // carries no digit and no symbol; a password that looks like one is missed
      // here and still caught by the declaration, table and prose rules.
      const looksLikeLabel = value.length <= 20 && !/[\d\p{P}\p{S}]/u.test(value);
      if (value.length >= 4 && !looksLikeLabel && !isPlaceholder(value) && !isAllowed(name)) {
        findings.push({
          line: index + 1,
          rule: "credential-property",
          detail: `a property named ${name.toLowerCase()} is assigned a literal value`,
        });
      }
    }

    const fallback = /process\.env\.([A-Z0-9_]+)\s*(?:\|\||\?\?)\s*(["'`])([^"'`]*)\2/.exec(line);
    if (fallback && CREDENTIAL_ENV.test(fallback[1]) && !isPlaceholder(fallback[3]) && !isAllowed(fallback[1])) {
      findings.push({
        line: index + 1,
        rule: "defaulted-credential",
        detail: `process.env.${fallback[1]} falls back to a literal instead of refusing`,
      });
    }

    const assignment = /(?:const|let|var|readonly)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(["'`])([^"'`]*)\2(\s*\.\s*repeat\s*\()?/.exec(line);
    if (assignment) {
      const [, name, , value, repeated] = assignment;
      const credentialName = /(password|passwd|secret|credential)/i.test(name);
      // `"e".repeat(32)` is a fixture generator, not a credential, and a literal
      // too short to be one is not one either.
      const couldBeACredential = !repeated && value.length >= 4;
      if (credentialName && couldBeACredential && !isPlaceholder(value) && !isAllowed(name)) {
        findings.push({
          line: index + 1,
          rule: "credential-literal",
          detail: `${name} is assigned a literal value`,
        });
      }
    }
  });
  return findings;
}

/**
 * Findings for one file whose strings are JSON-escaped — a sourcemap's
 * `sourcesContent`, a lockfile, a fixture.
 *
 * Escapes are decoded per real line and the real line number is kept, so a
 * finding points at a place that exists in the file. A minified sourcemap is one
 * line, so its findings are reported on line 1, which is the truth about it.
 *
 * This is the rule that was missing: `const DEV_PASSWORD = \"value\"` inside a
 * sourcemap is the same publication as the source it was built from, and every
 * source pattern failed on the backslashes.
 *
 * @returns {Array<{line: number, rule: string, detail: string}>}
 */
export function auditData(content, options = {}) {
  const findings = [];
  content.split(/\r?\n/).forEach((line, index) => {
    for (const finding of auditSource(unescapeJsonStrings(line), options)) {
      findings.push({ ...finding, line: index + 1, detail: `${finding.detail}, inside JSON-escaped content` });
    }
  });
  return findings;
}

/** Decodes JSON string escapes so escaped source reads as source. */
export function unescapeJsonStrings(content) {
  const SIMPLE = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", '"': '"', "'": "'", "\\": "\\", "/": "/" };
  return content.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (match, escape) =>
    escape[0] === "u" ? String.fromCodePoint(Number.parseInt(escape.slice(1), 16)) : (SIMPLE[escape] ?? match),
  );
}

/**
 * Files this gate reads: everything git publishes. Nothing is exempted.
 *
 * The previous revision skipped build output and lockfiles on the argument that
 * "a generated file that contained a real credential would have got it from a
 * source file this gate does read". That argument is sound and the conclusion was
 * still wrong: the source had been redacted and the 1634 tracked build artifacts
 * had not, so the only remaining copies in the tree were in the exempt directory.
 * Generated output is not a derivative of the current source. It is a snapshot of
 * an older one.
 */
export function publishedFiles(root) {
  const listed = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return listed.split("\0").filter(Boolean);
}

/**
 * Which rule set judges a file. Unknown extensions get the text rules, which are
 * the conservative ones, and an extensionless file with a shebang is a script.
 */
export function classify(file, content) {
  const extension = path.extname(file).toLowerCase();
  if (DATA_EXTENSIONS.has(extension)) return "data";
  if (SOURCE_EXTENSIONS.has(extension)) return "source";
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  if (/^#!/.test(content)) return "source";
  return "text";
}

function main() {
  const root = path.resolve(import.meta.dirname, "..");

  if (process.argv.includes("--list")) {
    console.log(
      "rules: credential-in-table, credential-in-prose, credential-in-command, credential-pair, credential-in-url, " +
        "defaulted-credential, credential-literal, credential-property, tracked-build-output",
    );
    for (const [file, entries] of Object.entries(ALLOWLIST)) {
      for (const [name, reason] of Object.entries(entries)) console.log(`allowed: ${file} :: ${name} — ${reason}`);
    }
    return 0;
  }

  const findings = [];
  let read = 0;
  let binary = 0;
  for (const file of publishedFiles(root)) {
    // Structural, and independent of content: tracked build output is generated,
    // unreviewed, and — as .next.backup proved — outlives the redaction of the
    // source it was built from.
    if (isBuildOutput(file)) {
      findings.push({
        file,
        line: 1,
        rule: "tracked-build-output",
        detail: "generated build output is tracked; it preserves whatever the source said when it was built",
      });
      continue;
    }

    let buffer;
    try {
      buffer = readFileSync(path.join(root, file));
    } catch {
      continue; // deleted between listing and reading
    }
    // A NUL in the first block means the rest will not decode as lines. Counted
    // rather than silently dropped, so `read + binary` accounts for every
    // tracked file and a growing binary count is visible.
    if (buffer.subarray(0, 8192).includes(0)) {
      binary += 1;
      continue;
    }
    const content = buffer.toString("utf8");
    read += 1;

    const isAllowed = (name) => allowed(file, name);
    const kind = classify(file, content);
    const found =
      kind === "text" ? auditText(content) : kind === "data" ? auditData(content, { isAllowed }) : auditSource(content, { isAllowed });
    for (const finding of found) {
      // The text rules are allowlisted per file rather than per identifier:
      // there is no name to key on in a table cell.
      if (kind === "text" && allowed(file, null)) continue;
      // And the nameless source rules — pair, URL — are allowlisted by rule.
      if (allowed(file, finding.rule)) continue;
      findings.push({ file, ...finding });
    }
  }

  if (findings.length > 0) {
    console.error(
      `FAIL: ${findings.length} published credential site(s) in ${read} tracked text file(s) (${binary} binary skipped). ` +
        "Values are deliberately not printed.",
    );
    for (const finding of findings) console.error(`  ${finding.file}:${finding.line} [${finding.rule}] ${finding.detail}`);
    console.error("");
    console.error("Redact the value in the working tree, and record the rotation in");
    console.error("supabase/preflight/f02-credential-cutover.md §7 — removing it here does not");
    console.error("remove it from git history, so the credential stays compromised until rotated.");
    return 1;
  }

  console.log(`OK: no published credential site in ${read} tracked text file(s) (${binary} binary skipped).`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exit(main());
}
