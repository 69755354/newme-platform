/**
 * Fail-closed comparison of a release's migration directory against the history
 * the target database actually recorded.
 *
 * scripts/check-migration-history.mjs proves that applied migrations in THIS
 * REPOSITORY are byte-identical to the base commit and that new ones are
 * forward-only. It cannot know what production ran. The defect that rejected the
 * reviewed revision of this branch — an applied migration renamed, another
 * rewritten — is exactly the class of defect that is invisible from inside the
 * repository once the rewrite has been committed. This script closes that by
 * asking the database.
 *
 * What it reads: supabase_migrations.schema_migrations, inside a READ ONLY
 * transaction. Three columns: version, name and statements. No business table,
 * no auth identity, no row contents.
 *
 * `statements` is read because round-3 finding P1-11 is that reading only
 * version and name proves nothing about content: a version can be recorded with
 * the right name and the wrong SQL, and production has rows recorded with no
 * statements at all. The statements themselves are NEVER printed and never
 * written anywhere — only their count and a SHA-256 fingerprint, which is what
 * the fixture stores and compares.
 *
 * Round-4 finding C4 is that this was still only half a comparison: the recorded
 * fingerprints were compared to an earlier capture of the same database, which
 * proves production has not changed since, not that production ran this release.
 * So the release's own migration files are now parsed into statements the way the
 * CLI records them (scripts/split-sql-statements.mjs) and fingerprinted with the
 * same function, and every recorded row this release also contains has to
 * reproduce from that file. Rows that cannot — production applied most of its
 * history through CLI versions this release does not pin, and seven rows have no
 * statements recorded at all — stay explicit, per-row exceptions with a reason and
 * evidence. They are never counted as byte equivalence.
 *
 * What it never does: print the connection string, accept it as a command-line
 * argument (arguments are world-readable in /proc), print any statement text, or
 * write anything.
 *
 * Usage:
 *   node scripts/verify-remote-migration-history.mjs \
 *     --url-file /etc/newme/migration-db.url \
 *     [--migrations-dir <dir>] [--modules-dir <dir>] \
 *     [--require-applied <ids>] [--require-no-pending] \
 *     [--history-fixture supabase/migration-history-reconciliation.json]
 *
 * --require-applied <ids>  comma-separated migration ids (full filename stem or
 *                          bare 14-digit version) that MUST be recorded as
 *                          applied. This is the deploy's `applied_verified`
 *                          claim, re-measured.
 * --require-no-pending     refuse if the release contains any migration the
 *                          database has not applied. This is the deploy's
 *                          `not_required` claim, re-measured.
 * --history-fixture <file> the recorded production history and the explicit
 *                          mapping of differences an operator has reconciled.
 *                          It can only ever EXPLAIN a difference this gate found;
 *                          it cannot silence one it did not find, cannot explain
 *                          a claim failure, and any difference it does not name
 *                          is still a refusal. See
 *                          supabase/preflight/migration-history-reconciliation.md.
 * --release-manifest <f>   infra/release/release-manifest.json of the release.
 *                          Read only to bound the post-capture delta of round-4
 *                          C5; without it no such delta is allowed.
 * --modules-dir <dir>      where to resolve `pg` from, for hosts where the
 *                          release being deployed has no node_modules yet.
 *
 * Exit: 0 only when every check passes. Any problem, any unanswered question and
 * any error exits 1 with the reasons on stderr.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { splitSqlStatements } from "./split-sql-statements.mjs";

const CLI_MIGRATION = /^([0-9]{14})_(.+)\.sql$/;

/**
 * The set of files the Supabase CLI would actually apply, in the order it would
 * apply them. Anything else in the directory (rollback_*.sql, README) is inert
 * and deliberately not compared.
 */
export function readLocalMigrations(dir) {
  return fs
    .readdirSync(dir)
    .filter((entry) => CLI_MIGRATION.test(entry))
    .sort()
    .map((file) => {
      const [, version, name] = file.match(CLI_MIGRATION);
      return { version, name, file };
    });
}

/** Accept `20260811100300_f02_x` or `20260811100300`; return the version. */
function normalizeId(id) {
  const trimmed = id.trim();
  const match = /^([0-9]{14})(?:_.*)?$/.exec(trimmed);
  return match ? match[1] : null;
}

/**
 * The encoding version of statementsFingerprint(). A capture has to declare it,
 * so a baseline taken under the previous encoding is refused rather than compared
 * — the digests are not comparable across encodings and a mismatch there would
 * read as content drift in production, which would be a false accusation.
 */
export const FINGERPRINT_FORMAT = "statements-v2-length-delimited";

/**
 * A stable fingerprint of a migration's statements, computed identically here, in
 * scripts/capture-remote-migration-history.mjs, and by the server in
 * HISTORY_QUERY below.
 *
 * Length-delimited, because round-4 finding C4 is that the previous encoding —
 * the element count followed by the elements joined with a space — collides.
 * ["a","b c"] and ["a b","c"] have the same count and the same joined text, so a
 * statement boundary could move without the fingerprint changing, and a boundary
 * moving is exactly the drift this gate exists to catch. Here every element is
 * preceded by its own byte length, so no element's bytes can be read as part of
 * its neighbour's:
 *
 *   <count> LF  ( <octet length> LF <utf-8 bytes> ) *
 *
 * This exists so that content can be compared without content being handled: the
 * fingerprint is what the fixture stores, what this gate compares, and the only
 * thing about a statement that is ever allowed to leave the database.
 */
export function statementsFingerprint(statements) {
  const list = Array.isArray(statements) ? statements : [];
  const hash = crypto.createHash("sha256");
  hash.update(`${list.length}\n`);
  for (const statement of list) {
    const bytes = Buffer.from(typeof statement === "string" ? statement : String(statement ?? ""), "utf8");
    hash.update(`${bytes.length}\n`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

/**
 * How much of a recorded migration's content this run could measure.
 *
 * Two row shapes reach here. The gate's own query asks the server for the count
 * and the fingerprint so that statement text never crosses the wire at all; a
 * caller (or a test) may instead pass `statements` and have the fingerprint
 * computed here. A row that carries neither measures as zero statements, which is
 * a difference — never a pass.
 */
function rowContent(row) {
  if (Array.isArray(row?.statements)) {
    return { count: row.statements.length, fingerprint: statementsFingerprint(row.statements) };
  }
  const count = Number(row?.statement_count);
  return {
    count: Number.isInteger(count) && count > 0 ? count : 0,
    fingerprint: typeof row?.statements_sha256 === "string" ? row.statements_sha256 : null,
  };
}

/**
 * A fingerprint of a whole captured baseline, over exactly the four fields the
 * capture emits. scripts/capture-remote-migration-history.mjs writes it into the
 * capture block; this gate recomputes it, so a baseline row edited by hand after
 * the capture is a refusal rather than a silent redefinition of "production".
 */
export function rowsFingerprint(rows) {
  const canonical = (Array.isArray(rows) ? rows : []).map((row) => [
    String(row?.version ?? ""),
    String(row?.name ?? ""),
    Number(row?.statement_count ?? 0),
    String(row?.statements_sha256 ?? ""),
  ]);
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * The difference classes an operator is allowed to reconcile, and the fields an
 * acceptance must restate to match one. An acceptance is only ever an
 * explanation of a difference this gate measured for itself: it has to name the
 * observation, so an acceptance written against a difference that has since
 * changed shape stops matching and the difference is reported again.
 */
const RECONCILABLE = {
  non_cli_version: ["version"],
  remote_only: ["version", "remote_name"],
  name_mismatch: ["version", "remote_name", "local_name"],
  local_absent_remote_before_newest: ["version", "file"],
  no_statements: ["version", "remote_name"],
  // Round-4 C5's other half. Production applied most of its history over months,
  // through CLI versions this release does not pin, so a recorded array whose
  // boundaries differ from this release's parse of the same file is expected for
  // old rows and has to be explainable. It is still one acceptance per row, still
  // has to restate both counts, and — unlike the rows above — the difference is
  // about content, so the acceptance is a statement that content equivalence was
  // NOT demonstrated for that version. It cannot be written for a version this
  // release is claiming to have just applied: see `delta` in auditHistory().
  content_not_locally_reproducible: ["version", "remote_name", "remote_count", "local_count"],
};

/**
 * The statements each local migration file splits into, as a count and the same
 * fingerprint the server computes for the recorded array.
 *
 * This is the local half of the comparison round-4 C4 asked for. It reads the
 * files, so it is separate from readLocalMigrations() — that one answers "what
 * would the CLI apply", which several callers ask without wanting to open
 * anything.
 *
 * A file that cannot be read is recorded as an error rather than skipped: it is
 * the case where content equivalence is unprovable, and unprovable is a refusal.
 *
 * `crlf` is recorded because the fingerprint is over bytes, and it has to be:
 * normalising line endings would claim equality between a file and a differently
 * encoded array the CLI actually recorded. Every migration blob in this repository
 * is LF, so a CRLF working file means the checkout rewrote it — `core.autocrlf` on
 * Windows — and the comparison is then measuring a file production never applied.
 * auditHistory() reports that as its own refusal rather than as a hundred
 * unexplained content differences.
 */
export function readLocalContent(dir, entries) {
  const byVersion = new Map();
  for (const entry of entries) {
    try {
      const sql = fs.readFileSync(path.join(dir, entry.file), "utf8");
      const statements = splitSqlStatements(sql);
      byVersion.set(entry.version, {
        file: entry.file,
        count: statements.length,
        fingerprint: statementsFingerprint(statements),
        crlf: sql.includes("\r\n"),
        error: null,
      });
    } catch (error) {
      byVersion.set(entry.version, {
        file: entry.file,
        count: 0,
        fingerprint: null,
        crlf: false,
        error: error.code ?? error.name,
      });
    }
  }
  return byVersion;
}

/** Structural comparison of two histories: versions, names, claims, order. */
function structuralFindings({ remote, local, requireApplied, requireNoPending }) {
  const findings = [];
  const add = (kind, version, message, observed = {}) =>
    findings.push({ kind, version, message, observed: { version, ...observed } });

  if (!Array.isArray(remote) || remote.length === 0) {
    add(
      "no_history",
      null,
      "the database reports zero applied migrations; either this is not the production database or its migration history has been erased",
    );
    return { findings, remoteByVersion: new Map(), remoteAll: new Map(), pending: [] };
  }

  const localByVersion = new Map(local.map((entry) => [entry.version, entry]));
  // Two maps on purpose. The structural checks below only make sense for rows the
  // CLI could have written; the content checks apply to every row production
  // recorded, including one it could not have written, because "what ran under
  // this version" is a question about all of them.
  const remoteAll = new Map();
  const remoteByVersion = new Map();
  for (const row of remote) {
    const version = typeof row.version === "string" ? row.version : String(row.version ?? "");
    if (remoteAll.has(version)) {
      add("duplicate_version", version, `the database records version ${version} twice`);
      continue;
    }
    remoteAll.set(version, row);
    if (!/^[0-9]{14}$/.test(version)) {
      add(
        "non_cli_version",
        version,
        `the database records an applied version ${JSON.stringify(version)} that is not a 14-digit CLI stamp`,
      );
      continue;
    }
    remoteByVersion.set(version, row);
  }

  // 1 · Every version production applied must still be in the release, under the
  //     same name. A missing one was deleted; a differently-named one was
  //     renamed. Both mean the directory no longer describes what ran.
  for (const [version, row] of remoteByVersion) {
    const localEntry = localByVersion.get(version);
    const recorded = typeof row.name === "string" ? row.name.trim() : "";
    if (!localEntry) {
      add(
        "remote_only",
        version,
        `the database applied ${version} (recorded name: ${recorded !== "" ? recorded : "<none>"}) but this release contains no such migration: applied history was deleted or renamed`,
        { remote_name: recorded },
      );
      continue;
    }
    if (recorded !== "" && recorded !== localEntry.name) {
      add(
        "name_mismatch",
        version,
        `the database applied ${version} as ${JSON.stringify(recorded)} but this release calls it ${JSON.stringify(localEntry.name)}: applied history was renamed`,
        { remote_name: recorded, local_name: localEntry.name },
      );
    }
  }

  // 2 · The claim the deploy made about migrations, re-measured. Never
  //     reconcilable: a false claim is not a historical difference.
  for (const id of requireApplied) {
    const version = normalizeId(id);
    if (!version) {
      add("claim_unparseable", null, `${JSON.stringify(id)} is not a migration id this gate can check`);
      continue;
    }
    if (!localByVersion.has(version)) {
      add("claim_not_in_release", version, `${id} was claimed applied but this release contains no migration ${version}`);
    }
    if (!remoteByVersion.has(version)) {
      add("claim_not_applied", version, `${id} was claimed applied but the database has no record of ${version}`);
    }
  }

  // 3 · What the release carries that the database has not run.
  const newestRemote = [...remoteByVersion.keys()].sort().at(-1);
  const pending = local.filter((entry) => !remoteByVersion.has(entry.version));
  for (const entry of pending) {
    if (entry.version <= newestRemote) {
      // Forward-only against the database, not merely against the repository:
      // the CLI orders by filename, so an unapplied migration that sorts before
      // applied history will never be picked up and its absence is permanent.
      add(
        "local_absent_remote_before_newest",
        entry.version,
        `${entry.file} is not applied and sorts at or before the newest applied version ${newestRemote}: it can never be applied in order`,
        { file: entry.file },
      );
    }
  }
  if (requireNoPending && pending.length > 0) {
    add(
      "claim_no_pending",
      null,
      `the release was declared to need no migrations, but ${pending.length} migration(s) in it are not applied: ${pending
        .map((entry) => entry.file)
        .join(", ")}`,
    );
  }

  return { findings, remoteByVersion, remoteAll, pending };
}

/**
 * The whole judgement, as a pure function over two lists, so it is testable
 * without a database. Returns a list of problems; empty means OK.
 *
 * This is the version/name/claim half. It is kept as its own export because the
 * deploy gate's structural checks and the content reconciliation fail for
 * different reasons and are read by different people.
 */
export function compareHistories({
  remote,
  local,
  requireApplied = [],
  requireNoPending = false,
}) {
  return structuralFindings({ remote, local, requireApplied, requireNoPending }).findings.map(
    (finding) => finding.message,
  );
}

/**
 * The full audit: structure, recorded content, and the explicit reconciliation of
 * differences an operator has documented.
 *
 * Fail-closed in every direction that matters:
 *   * `statementsRead: false` (the column is not there to read) is itself a
 *     refusal, because content equivalence then cannot be measured at all
 *   * a row recorded with no statements is a difference, not a pass — production
 *     has such rows and they are exactly the ones whose content is unprovable
 *   * `localContent: null` is a refusal too: without the release's own parse there
 *     is nothing to compare recorded content against, and comparing production to
 *     an older reading of production is not that comparison
 *   * every recorded row that this release also contains must reproduce from this
 *     release's file, or be an explicit exception
 *   * a reconciliation that records no capture is a refusal by itself, so "the
 *     baseline agrees" and "there is no baseline" cannot reach the same outcome
 *   * with a captured fixture, every remote row must match it by name, statement
 *     count and fingerprint, and the fixture may not contain rows production does
 *     not have — except the claimed, manifested, content-verified delta this
 *     release applied after the capture, which is round-4 C5
 *   * an acceptance can only downgrade a difference this function measured, must
 *     restate what was observed, must carry a reason and evidence, and requires a
 *     capture to exist; an acceptance matching nothing is a refusal of its own, so
 *     the mapping cannot outlive the difference it explains
 */
export function auditHistory({
  remote,
  local,
  requireApplied = [],
  requireNoPending = false,
  statementsRead = true,
  reconciliation = null,
  localContent = null,
  manifestVersions = null,
}) {
  const { findings, remoteAll } = structuralFindings({
    remote,
    local,
    requireApplied,
    requireNoPending,
  });
  const add = (kind, version, message, observed = {}) =>
    findings.push({ kind, version, message, observed: { version, ...observed } });

  const localByVersion = new Map(local.map((entry) => [entry.version, entry]));
  const claimedVersions = new Set(requireApplied.map((id) => normalizeId(id)).filter(Boolean));
  // Versions whose recorded content this run reproduced from the release's own
  // files. Not "versions with no complaint": only a measured match gets in here,
  // and only these are eligible for the post-capture delta below.
  const reproduced = new Set();

  // 4 · Content, in two directions. version+name proves only that a stamp exists
  //     under a name; the recorded array proves what ran; and the release's own
  //     parse of the same file is what ties the two to this tree. Round-4 C4:
  //     comparing production to an earlier capture of production is a statement
  //     about production's stability, not about this release.
  if (!statementsRead) {
    add(
      "statements_unreadable",
      null,
      "supabase_migrations.schema_migrations has no readable statements column: the content of the applied history cannot be measured, so byte equivalence cannot be claimed",
    );
  } else {
    if (localContent === null) {
      add(
        "local_content_unparsed",
        null,
        "the release's own migration files were not parsed into statements, so the recorded history could not be compared with anything in this release",
      );
    }
    // Checked before any per-row comparison, because a rewritten checkout makes
    // every one of them meaningless. Every migration blob in this repository is
    // LF, so a CRLF working file is a checkout artefact (core.autocrlf on Windows)
    // and the bytes being fingerprinted are not the bytes the CLI applied. One
    // refusal that names the cause, and no per-row comparison after it: a hundred
    // content differences produced by the checkout would read as production drift.
    const rewritten =
      localContent === null ? [] : [...localContent.values()].filter((row) => row.crlf === true);
    if (rewritten.length > 0) {
      add(
        "local_content_line_endings",
        null,
        `${rewritten.length} of ${localContent.size} migration file(s) in this checkout use CRLF line endings while every committed blob is LF (${rewritten[0].file} is one): the content comparison would be measuring a rewritten file, not the release. Check out with core.autocrlf=false.`,
      );
    }
    const contentComparable = localContent !== null && rewritten.length === 0;
    for (const [version, row] of remoteAll) {
      const remoteName = typeof row.name === "string" ? row.name.trim() : "";
      const { count, fingerprint } = rowContent(row);
      if (count === 0) {
        add(
          "no_statements",
          version,
          `the database records ${version} with no statements: what ran under that version cannot be verified from the history`,
          { remote_name: remoteName },
        );
        // Deliberately no content comparison for this row. A row with nothing
        // recorded cannot be shown equal to a file, and the exception above is
        // the honest outcome — not a byte-equivalence claim, which is exactly
        // what round-4 C4 refused to accept.
        continue;
      }
      if (!contentComparable) continue;
      // A version the release does not contain is already reported as remote_only;
      // there is no local file to parse and nothing further to say about it.
      if (!localByVersion.has(version)) continue;
      const localRow = localContent.get(version);
      if (!localRow || localRow.error !== null) {
        add(
          "local_content_unreadable",
          version,
          `${version} is in this release but its file could not be read (${localRow?.error ?? "missing"}), so what ran cannot be compared with it`,
        );
        continue;
      }
      if (localRow.count === 0) {
        add(
          "local_no_statements",
          version,
          `${localRow.file} parses into no statements at all, so it cannot be the source of the ${count} statement(s) recorded for ${version}`,
        );
        continue;
      }
      if (fingerprint === null) {
        add(
          "content_unmeasured",
          version,
          `${version} could not be fingerprinted in this run, so what ran cannot be compared with ${localRow.file}`,
        );
        continue;
      }
      if (localRow.count !== count || localRow.fingerprint !== fingerprint) {
        add(
          "content_not_locally_reproducible",
          version,
          `the database recorded ${count} statement(s) for ${version} but ${localRow.file} in this release parses into ${localRow.count}` +
            `${localRow.count === count ? " with different content" : ""}: what ran under that version is not what this release carries`,
          { remote_name: remoteName, remote_count: String(count), local_count: String(localRow.count) },
        );
        continue;
      }
      reproduced.add(version);
    }
  }

  const fixtureRows = Array.isArray(reconciliation?.rows) ? reconciliation.rows : [];
  const accepted = Array.isArray(reconciliation?.accepted) ? reconciliation.accepted : [];
  const hasCapture = Boolean(reconciliation?.capture);
  const deltas = [];

  // 5 · The recorded baseline. A reconciliation that was asked for at all has to
  //     be a captured one: round-4 C4's second half is that an uncaptured, empty
  //     fixture passed through here without being noticed, which made "the
  //     baseline agrees" and "there is no baseline" the same outcome.
  if (reconciliation !== null && !hasCapture) {
    add(
      "reconciliation_without_capture",
      null,
      "a reconciliation file was supplied but records no capture: production's recorded history has never been read, so nothing in this run compares it to anything",
    );
  }
  if (hasCapture) {
    if (typeof reconciliation.capture.rows_sha256 !== "string") {
      add(
        "fixture_without_digest",
        null,
        "the reconciliation's capture records no rows_sha256, so the baseline cannot be shown to be the one that was captured",
      );
    } else if (reconciliation.capture.rows_sha256 !== rowsFingerprint(fixtureRows)) {
      add(
        "fixture_tampered",
        null,
        "the reconciliation's rows do not match the digest recorded at capture time: the baseline was edited after it was captured",
      );
    }
    if (reconciliation.capture.statements_measured !== true) {
      add(
        "capture_without_content",
        null,
        "the capture records that statements were not measurable when it was taken, so the baseline carries no content to compare",
      );
    }
    if (String(reconciliation.capture.fingerprint_format ?? "") !== FINGERPRINT_FORMAT) {
      // Not a mismatch to report per row: digests from another encoding are not
      // comparable at all, and reporting them as drift would accuse production of
      // a change it did not make.
      add(
        "capture_format_stale",
        null,
        `the capture was taken with fingerprint format ${JSON.stringify(String(reconciliation.capture.fingerprint_format ?? "<none>"))} but this gate computes ${JSON.stringify(FINGERPRINT_FORMAT)}: the baseline must be captured again`,
      );
    }
    const byVersion = new Map();
    for (const row of fixtureRows) {
      const version = String(row?.version ?? "");
      if (byVersion.has(version)) {
        add("fixture_duplicate_row", version, `the reconciliation records ${version} twice`);
        continue;
      }
      byVersion.set(version, row);
    }
    // The newest version the capture saw. Everything after it is, by definition,
    // something production applied since — which for a release that just ran its
    // own migrations is the expected outcome, not drift.
    const newestCaptured = [...byVersion.keys()].sort().at(-1) ?? null;
    for (const [version, row] of remoteAll) {
      const recorded = byVersion.get(version);
      if (!recorded) {
        // Round-4 C5: a row added after the capture was reported as stale-baseline
        // drift even when it was the exact migration this release was deploying,
        // which deadlocked the canonical path — the deploy could not apply a
        // migration without invalidating the baseline that let it deploy. It is
        // allowed through only when every one of these holds, so the allowance is
        // the claimed delta and nothing else:
        //   * it sorts after everything the capture saw, so it cannot rewrite
        //     history the baseline covers
        //   * this release contains it, and the release manifest declares it
        //   * the deploy claimed it applied, by version, on the command line
        //   * and its recorded content was reproduced from this release's own file
        // The last one is what makes this safe: the baseline is bypassed for this
        // row because something stronger than the baseline is available for it.
        const allowed =
          newestCaptured !== null &&
          version > newestCaptured &&
          localByVersion.has(version) &&
          manifestVersions !== null &&
          manifestVersions.has(version) &&
          claimedVersions.has(version) &&
          reproduced.has(version);
        if (allowed) {
          deltas.push({ version, file: localByVersion.get(version).file });
          continue;
        }
        add(
          "fixture_row_unrecorded",
          version,
          `the database applied ${version} but the captured baseline does not contain it, and it is not this release's claimed, manifested, content-verified delta after ${newestCaptured ?? "<no captured row>"}: recapture the baseline or explain the row`,
        );
        continue;
      }
      const remoteName = typeof row.name === "string" ? row.name.trim() : "";
      const { count, fingerprint } = rowContent(row);
      if (String(recorded.name ?? "").trim() !== remoteName) {
        add(
          "fixture_name_drift",
          version,
          `${version} is recorded in the baseline as ${JSON.stringify(String(recorded.name ?? ""))} but the database now reports ${JSON.stringify(remoteName)}`,
        );
      }
      if (!statementsRead) {
        // Already reported once, above, as the reason nothing here is provable.
      } else if (Number(recorded.statement_count) !== count) {
        add(
          "fixture_content_drift",
          version,
          `${version} is recorded with ${recorded.statement_count} statement(s) but the database now reports ${count}`,
        );
      } else if (fingerprint === null) {
        add(
          "fixture_content_unmeasured",
          version,
          `${version} could not be fingerprinted in this run, so it cannot be compared with the captured baseline`,
        );
      } else if (String(recorded.statements_sha256 ?? "") !== fingerprint) {
        add(
          "fixture_content_drift",
          version,
          `${version} has a different statement fingerprint than the captured baseline: the recorded content of an applied migration changed`,
        );
      }
    }
    for (const version of byVersion.keys()) {
      if (!remoteAll.has(version)) {
        add(
          "fixture_row_missing_remotely",
          version,
          `the captured baseline contains ${version} but the database no longer records it: applied history was removed from production`,
        );
      }
    }
  }

  // 6 · Apply the acceptances. Each one has to find its difference.
  const reconciled = [];
  const problems = [];
  const claimed = new Set();
  for (const [index, entry] of accepted.entries()) {
    const where = `accepted[${index}]`;
    const kind = String(entry?.kind ?? "");
    const fields = RECONCILABLE[kind];
    if (!fields) {
      problems.push(
        `${where} claims to reconcile ${JSON.stringify(kind)}, which is not a difference this gate lets anyone accept`,
      );
      continue;
    }
    if (!hasCapture) {
      problems.push(
        `${where} accepts a difference but the reconciliation records no capture: an acceptance without read-only evidence is not a reconciliation`,
      );
      continue;
    }
    if (kind === "content_not_locally_reproducible" && claimedVersions.has(String(entry?.version ?? ""))) {
      // An old row whose boundaries this release cannot reproduce is history. The
      // same difference on a version the deploy is claiming to have just applied
      // is the deploy applying something other than what it shipped, and that is
      // a claim failure — the one category acceptances have never been able to
      // reach.
      problems.push(
        `${where} accepts unreproducible content for ${JSON.stringify(String(entry?.version ?? ""))}, but this deploy claims to have applied that version: a claimed migration's content cannot be excused`,
      );
      continue;
    }
    const why = String(entry?.why ?? "").trim();
    const evidence = String(entry?.evidence ?? "").trim();
    if (why.length < 40 || evidence === "") {
      problems.push(`${where} must state why the difference is expected and cite the evidence for it`);
      continue;
    }
    const match = findings.find(
      (finding) =>
        finding.kind === kind &&
        !claimed.has(finding) &&
        fields.every(
          (field) => String(entry?.[field] ?? "") === String(finding.observed?.[field] ?? ""),
        ),
    );
    if (!match) {
      // Stale, or written for a difference that has since changed shape. Either
      // way it is not describing production, and silence would be a lie.
      problems.push(
        `${where} accepts a ${kind} for ${JSON.stringify(String(entry?.version ?? ""))} that this run did not observe: the reconciliation no longer describes production`,
      );
      continue;
    }
    claimed.add(match);
    reconciled.push({ kind, version: match.version, why, evidence, message: match.message });
  }

  for (const finding of findings) {
    if (!claimed.has(finding)) problems.push(finding.message);
  }
  return { problems, reconciled, findings, deltas, reproduced: [...reproduced] };
}

/** Read the reconciliation file, refusing anything that is not the shape above. */
export function readReconciliation(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error("the reconciliation file is a symlink");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("the reconciliation file must contain a JSON object");
  }
  for (const key of ["rows", "accepted"]) {
    if (parsed[key] !== undefined && !Array.isArray(parsed[key])) {
      throw new Error(`the reconciliation file's ${key} must be an array`);
    }
  }
  if (parsed.capture !== undefined && parsed.capture !== null && typeof parsed.capture !== "object") {
    throw new Error("the reconciliation file's capture must be an object or null");
  }
  return parsed;
}

/**
 * The versions the release manifest declares, across both phases. Used only to
 * bound round-4 C5's post-capture allowance: a row production applied after the
 * capture has to be one this release declared it would apply. A missing or
 * unreadable manifest yields null, which allows nothing.
 */
export function readManifestVersions(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const versions = new Set();
    for (const phase of ["required_for_app", "deferred_contract"]) {
      for (const entry of Array.isArray(parsed?.[phase]) ? parsed[phase] : []) {
        if (typeof entry?.version === "string") versions.add(entry.version);
      }
    }
    return versions.size > 0 ? versions : null;
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const options = {
    urlFile: null,
    migrationsDir: null,
    modulesDir: null,
    requireApplied: [],
    requireNoPending: false,
    historyFixture: null,
    releaseManifest: null,
  };
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
      case "--migrations-dir":
        options.migrationsDir = next();
        break;
      case "--modules-dir":
        options.modulesDir = next();
        break;
      case "--require-applied":
        options.requireApplied = next()
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        break;
      case "--require-no-pending":
        options.requireNoPending = true;
        break;
      case "--history-fixture":
        options.historyFixture = next();
        break;
      case "--release-manifest":
        options.releaseManifest = next();
        break;
      default:
        // Refused rather than ignored, and refused by shape: a connection string
        // on the command line is a credential in /proc and in the shell history
        // of whoever ran it.
        throw new Error(
          arg.startsWith("--url=") || /postgres(ql)?:\/\//.test(arg)
            ? "the connection string must be read from a file, never passed as an argument"
            : `unknown argument: ${arg}`,
        );
    }
  }
  return options;
}

/** Read the URL without letting it reach stdout, stderr, argv or an env var. */
export function readUrlFile(file) {
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

export function loadPg(modulesDir) {
  const here = fileURLToPath(import.meta.url);
  const candidates = [];
  if (modulesDir) candidates.push(path.join(modulesDir, "__resolve__.cjs"));
  candidates.push(here);
  const failures = [];
  for (const from of candidates) {
    try {
      return createRequire(from)("pg");
    } catch (error) {
      failures.push(`${from}: ${error.code ?? error.name}`);
    }
  }
  throw new Error(`the pg client could not be resolved (${failures.join("; ")})`);
}

/**
 * The server-side half of statementsFingerprint(), as an expression over
 * `m.statements`, and the one query this gate and the capture script run.
 *
 * The expression is exported because it has three callers — this gate, the
 * capture, and the read-after-write check in scripts/db-phase-push.mjs — and a
 * second copy of it would be a second encoding. Round-4 C4 is the record of what a
 * second encoding costs; the phase tool did carry one, computing a digest that
 * could not be compared with the one this gate asks production for. Any query
 * interpolating it must alias the history table as `m`.
 *
 * The fingerprint is computed by the server, in the same bytes as
 * statementsFingerprint(), so that no statement text is transferred, printed,
 * logged or written by either script — only a count and a hash.
 *
 * Detail, in the order it bites: `array_length` is null for an empty array, hence
 * the coalesce, and a row with no statements measures as 0 and is reported as a
 * difference by auditHistory(). A null element unnests as null and would null the
 * whole concatenation, so it is coalesced to the empty string, matching the JS
 * side's `?? ""`. Lengths are octets of the UTF-8 encoding rather than
 * `octet_length(text)`, so the digest does not change with the server encoding.
 * `with ordinality` and the ordered aggregate keep array order, which is statement
 * order and therefore part of what is being fingerprinted.
 *
 * The two implementations are held against each other by measurement, not by
 * reading: scripts/statements-fingerprint-parity.mjs records adversarial arrays
 * (moved boundaries, empty arrays, a null column, null and empty elements,
 * embedded quotes and newlines, multi-byte text) plus every migration file in this
 * release into a real PostgreSQL of production's major version, and requires the
 * server's digest to equal statementsFingerprint()'s for every one. Its --self-test
 * pass recomputes the JS side through the superseded encoding and requires every
 * row to be reported as a difference, so a harness that measures nothing cannot
 * pass. The `migration-replay` job of .github/workflows/ci.yml runs both.
 */
export const STATEMENTS_FINGERPRINT_SQL = `encode(sha256(
         convert_to(coalesce(array_length(m.statements, 1), 0)::text || E'\\n', 'UTF8') ||
         coalesce((select string_agg(
                            convert_to(octet_length(convert_to(coalesce(s.statement, ''), 'UTF8'))::text || E'\\n', 'UTF8')
                              || convert_to(coalesce(s.statement, ''), 'UTF8'),
                            ''::bytea order by s.ord)
                     from unnest(m.statements) with ordinality as s(statement, ord)),
                  ''::bytea)
       ), 'hex')`;

export const HISTORY_QUERY = `select m.version,
       m.name,
       coalesce(array_length(m.statements, 1), 0) as statement_count,
       ${STATEMENTS_FINGERPRINT_SQL} as statements_sha256
  from supabase_migrations.schema_migrations m
 order by m.version`;

/** The same list without the content columns, for a server that has none. */
const HISTORY_QUERY_NO_STATEMENTS =
  "select version, name from supabase_migrations.schema_migrations order by version";

export async function fetchRemoteHistory(url, modulesDir) {
  const { Client } = loadPg(modulesDir);
  const client = new Client({
    connectionString: url,
    application_name: "newme-verify-remote-migration-history",
    statement_timeout: 15000,
    connectionTimeoutMillis: 15000,
  });
  try {
    await client.connect();
  } catch (error) {
    // Deliberately not error.message: a pg connection error can quote the URL.
    throw new Error(`could not connect to the migration database (${error.code ?? error.name})`);
  }
  try {
    // READ ONLY is not decoration: it is the guarantee that this gate cannot
    // mutate the database it is inspecting, enforced by the server.
    await client.query("begin read only");
    let statementsRead = true;
    let result;
    try {
      result = await client.query(HISTORY_QUERY);
    } catch (error) {
      if (error.code !== "42703" && error.code !== "42883") throw error;
      // No statements column, or no sha256(). Measure what is measurable and let
      // auditHistory() refuse: this is the case where content equivalence is not
      // provable, which is not the same as provably fine.
      await client.query("rollback");
      await client.query("begin read only");
      result = await client.query(HISTORY_QUERY_NO_STATEMENTS);
      statementsRead = false;
    }
    await client.query("commit");
    return { rows: result.rows, statementsRead };
  } catch (error) {
    if (error.code === "42P01") {
      throw new Error("the database has no supabase_migrations.schema_migrations table");
    }
    throw new Error(`the migration history query failed (${error.code ?? error.name})`);
  } finally {
    await client.end().catch(() => {});
  }
}

async function main(argv) {
  const options = parseArgs(argv);
  if (!options.urlFile) throw new Error("--url-file is required");

  const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const migrationsDir = options.migrationsDir ?? path.join(repoRoot, "supabase", "migrations");
  const local = readLocalMigrations(migrationsDir);
  if (local.length === 0) throw new Error(`no CLI-applicable migrations found in ${migrationsDir}`);
  const localContent = readLocalContent(migrationsDir, local);

  const reconciliation = options.historyFixture ? readReconciliation(options.historyFixture) : null;
  // Beside the migrations being deployed rather than beside this script: the
  // deploy runs the gate from the candidate worktree with --migrations-dir, and
  // the manifest that declares those migrations is the one in that same tree.
  const manifestFile =
    options.releaseManifest ??
    path.join(path.dirname(path.dirname(migrationsDir)), "infra", "release", "release-manifest.json");
  const manifestVersions = readManifestVersions(manifestFile);

  const { rows: remote, statementsRead } = await fetchRemoteHistory(
    readUrlFile(options.urlFile),
    options.modulesDir,
  );
  const { problems, reconciled, deltas, reproduced } = auditHistory({
    remote,
    local,
    requireApplied: options.requireApplied,
    requireNoPending: options.requireNoPending,
    statementsRead,
    reconciliation,
    localContent,
    manifestVersions,
  });

  const applied = remote.length;
  const pending = local.length - local.filter((entry) => remote.some((row) => String(row.version) === entry.version)).length;
  console.log(`remote applied      : ${applied}`);
  console.log(`release migrations  : ${local.length}`);
  console.log(`not yet applied     : ${pending}`);
  console.log(`content measured    : ${statementsRead ? "yes (count + sha256, server-side)" : "NO"}`);
  console.log(`content reproduced  : ${reproduced.length} of ${applied} recorded row(s), from this release's own files`);
  const rewritten = [...localContent.values()].filter((row) => row.crlf === true).length;
  console.log(
    `local line endings  : ${rewritten === 0 ? "LF, as committed" : `CRLF in ${rewritten} file(s) — this checkout rewrote them, content cannot be compared`}`,
  );
  console.log(`release manifest    : ${manifestVersions ? `${manifestVersions.size} declared version(s)` : "not read (no post-capture delta can be allowed)"}`);
  if (options.requireApplied.length > 0) {
    console.log(`claimed applied     : ${options.requireApplied.length}`);
  }
  if (options.requireNoPending) {
    console.log("claim               : this release needs no migrations");
  }
  if (reconciliation) {
    console.log(`reconciliation      : ${options.historyFixture}`);
    console.log(`  captured baseline : ${(reconciliation.rows ?? []).length} row(s)`);
    console.log(`  capture recorded  : ${reconciliation.capture ? "yes" : "no"}`);
    console.log(`  accepted          : ${(reconciliation.accepted ?? []).length} entr(y|ies)`);
  }
  for (const entry of deltas) {
    // Named, not silent, and named as a bypass of the baseline: an operator
    // reading this log must be able to see which rows were admitted on their
    // content rather than on the capture.
    console.log(`post-capture delta  : ${entry.version} ${entry.file} — claimed, manifested, content reproduced from this release`);
  }
  for (const entry of reconciled) {
    // Named, not silent: a reconciled difference still appears in the deploy log.
    console.log(`reconciled          : ${entry.kind} ${entry.version} — ${entry.why} [${entry.evidence}]`);
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`remote migration history: ${problem}`);
    console.error(`refusing: ${problems.length} problem(s)`);
    return 1;
  }
  console.log("OK");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`remote migration history: ${error.message}`);
      process.exit(1);
    },
  );
}
