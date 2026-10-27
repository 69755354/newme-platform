/**
 * Capture a redacted, read-only baseline of the migration history a database has
 * recorded, for supabase/migration-history-reconciliation.json.
 *
 * Round-3 finding P1-11: comparing only version and name proves nothing about
 * what actually ran, and production has rows recorded with no statements at all.
 * A reconciliation therefore needs a recorded baseline. This script produces it
 * without ever handling migration SQL: the count and the SHA-256 fingerprint are
 * computed by the server (the same HISTORY_QUERY the gate runs), so the statement
 * text is never transferred, printed, logged or written.
 *
 * What leaves the database, per row: version, name, statement_count,
 * statements_sha256. Nothing else. No business row, no auth identity, no
 * statement text, no connection string.
 *
 * It is read-only twice over: a READ ONLY transaction, and no SQL other than that
 * one select.
 *
 * Usage:
 *   node scripts/capture-remote-migration-history.mjs \
 *     --url-file /etc/newme/migration-db.url \
 *     [--modules-dir <dir>] [--out supabase/migration-history-reconciliation.json]
 *
 * Without --out the JSON goes to stdout. With --out, an existing file's
 * `accepted` list is carried over unchanged — a re-capture must not silently
 * discard, or silently keep endorsing, an operator's reconciliation: the gate
 * re-matches every acceptance against the new baseline and refuses the ones that
 * no longer describe it.
 *
 * The output is inert on its own. It becomes a gate input only when someone
 * passes --history-fixture to scripts/verify-remote-migration-history.mjs, and
 * even then it can only explain a difference that gate measured for itself. See
 * supabase/preflight/migration-history-reconciliation.md.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchRemoteHistory, rowsFingerprint, FINGERPRINT_FORMAT } from "./verify-remote-migration-history.mjs";

function parseArgs(argv) {
  const options = { urlFile: null, modulesDir: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--url-file":
        options.urlFile = next();
        break;
      case "--modules-dir":
        options.modulesDir = next();
        break;
      case "--out":
        options.out = next();
        break;
      default:
        throw new Error(
          arg.startsWith("--url=") || /postgres(ql)?:\/\//.test(arg)
            ? "the connection string must be read from a file, never passed as an argument"
            : `unknown argument: ${arg}`,
        );
    }
  }
  return options;
}

/** Duplicated deliberately: this script must not import the URL reader's caller. */
function readUrlFile(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error("the connection URL file is a symlink");
  if (!stat.isFile()) throw new Error("the connection URL file is not a regular file");
  if (process.getuid && (stat.mode & 0o077) !== 0) {
    throw new Error("the connection URL file is group- or world-accessible");
  }
  const value = fs.readFileSync(file, "utf8").split(/\r?\n/)[0].trim();
  if (!/^postgres(ql)?:\/\//.test(value)) {
    throw new Error("the connection URL file does not contain a postgres:// URL");
  }
  return value;
}

const COMMENT = [
  "Redacted, read-only baseline of the migration history a database recorded.",
  "Produced by scripts/capture-remote-migration-history.mjs; consumed by",
  "scripts/verify-remote-migration-history.mjs --history-fixture. Rows carry a",
  "statement count and a server-computed SHA-256 fingerprint only: no statement",
  "text, no business data, no identities. Procedure and rules:",
  "supabase/preflight/migration-history-reconciliation.md.",
];

export function buildFixture({ rows, statementsRead, urlFile, capturedAt, accepted = [] }) {
  const captured = rows.map((row) => ({
    version: String(row.version),
    name: typeof row.name === "string" ? row.name : "",
    statement_count: Number(row.statement_count ?? 0),
    statements_sha256: typeof row.statements_sha256 === "string" ? row.statements_sha256 : null,
  }));
  return {
    _comment: COMMENT,
    capture: {
      captured_at: capturedAt,
      generator: "scripts/capture-remote-migration-history.mjs",
      url_file: urlFile,
      // Recorded so the gate can refuse a baseline whose content was not
      // measurable, instead of treating "no statements column" as agreement.
      statements_measured: statementsRead,
      // And so it can refuse one taken under a different statement encoding.
      // Digests from two encodings are not comparable, and a gate that compared
      // them anyway would report content drift in production that never happened.
      fingerprint_format: FINGERPRINT_FORMAT,
      row_count: captured.length,
      rows_sha256: rowsFingerprint(captured),
    },
    rows: captured,
    accepted,
  };
}

async function main(argv) {
  const options = parseArgs(argv);
  if (!options.urlFile) throw new Error("--url-file is required");

  let accepted = [];
  if (options.out && fs.existsSync(options.out)) {
    const existing = JSON.parse(fs.readFileSync(options.out, "utf8"));
    accepted = Array.isArray(existing?.accepted) ? existing.accepted : [];
  }

  const { rows, statementsRead } = await fetchRemoteHistory(
    readUrlFile(options.urlFile),
    options.modulesDir,
  );
  const fixture = buildFixture({
    rows,
    statementsRead,
    urlFile: options.urlFile,
    capturedAt: new Date().toISOString(),
    accepted,
  });
  const json = `${JSON.stringify(fixture, null, 2)}\n`;

  if (options.out) {
    fs.writeFileSync(options.out, json);
    console.error(`captured ${fixture.rows.length} row(s) into ${options.out}`);
    console.error(`content measured    : ${statementsRead ? "yes" : "NO"}`);
    console.error(`carried over        : ${accepted.length} acceptance(s), unchanged`);
  } else {
    process.stdout.write(json);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`capture migration history: ${error.message}`);
      process.exit(1);
    },
  );
}
