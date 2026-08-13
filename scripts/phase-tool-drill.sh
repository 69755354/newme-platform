#!/usr/bin/env bash
# ============================================================================
# Two-phase applier drill — the executable test of scripts/db-phase-push.mjs
# ============================================================================
# Round-4 review C7 asks for a phase tool that is *tested*, not merely present:
# "provide and test an exact-hash phase tool that records correct migration
# history. Do not temporarily remove files or rewrite history." This drill is that
# test. It runs the whole documented procedure against throwaway databases and
# asserts the refusals as hard as the successes:
#
#   1  expand --plan against a database with no migration history      REFUSED
#   2  contract phase before the expand phase                          REFUSED
#   3  expand --apply                                                  APPLIED
#      · every expand migration recorded, each read back and content-compared
#      · every posture predicate for state 2 measured true
#      · each file's own begin/commit skipped (executed = statements - 2)
#   4  expand --apply again                                            NO-OP
#   5  contract --plan                                                 ALLOWED
#   6  contract --apply                                                APPLIED
#      · release mode strict, verified by the manifest's own predicates
#   7  expand --apply after the window closed                          REFUSED
#   8  contract --verify-only at state 4                               PASSES
#   9  interruption: a migration that fails mid-phase, in a second database
#      · the failing migration records nothing
#      · the files applied before it stay applied
#      · an object created EARLIER IN THE SAME FILE is gone, which is what
#        proves the file's own `commit;` did not escape the tool's transaction
#  10  cross-tool: every row applied above, read back through
#      scripts/verify-remote-migration-history.mjs — the module that must later
#      reproduce production's recorded content from these same files — using its
#      query, its digest expression and its local half rather than this tool's
#      · plus a negative control: one recorded array is perturbed by moving a
#        statement boundary without changing the count, the check is required to
#        fail on it, and required to pass again once it is reverted
#  11  release ↔ database-phase coupling (round-4 C8): the gate that must refuse an
#      application-only rollback out of the contract phase, measured against a real
#      catalog in all three modes rather than a stubbed one
#      · state 4 (strict): this release may switch and may complete; the
#        pre-mechanism release — a real directory with no manifest — may not, and
#        the refusal names the companion
#      · state 5 (compat, companion run): the same switch is now allowed and
#        completion is what refuses, while the contract phase is still recorded —
#        C8's "history can say applied while mode is compat", both halves at once
#      · state 6 (re-contract run): the refusal returns, so it is a property of the
#        database and not a one-shot event
#      · state 1 (a third, untouched database): `absent` refuses this release and
#        allows the undeclared one, with a negative control in which a present but
#        failing mode function must NOT be reported as absence
#      · a group-readable URL file is refused — on a Windows checkout that
#        assertion passes vacuously, so this drill is where it means something
#
# Step 9 breaks one named migration the way a real database breaks one: it leaves a
# stale `public.assert_installment_schedule(jsonb, numeric, text)` behind that
# returns text, so that migration's `create or replace ... returns integer` fails
# with 42P13 part-way into a file that has already altered three tables. Which file
# that is, and therefore how many apply before it, is read out of the manifest —
# see BREAK_FILE below. No file in the repository is edited, moved or restored by
# this drill — that is the point of C7's "do not temporarily remove files".
#
# Requires: psql and node on PATH, the `pg` module resolvable, and an EMPTY
# database named in PGDATABASE. It also creates ${PGDATABASE}_interrupt and
# ${PGDATABASE}_absent. Nothing here touches production: the only databases it
# talks to are those three.
#
#   PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGDATABASE=phase \
#     bash scripts/phase-tool-drill.sh
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPLAY_DIR="$ROOT/supabase/replay"

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:?PGDATABASE must name an empty throwaway database}"
export PGHOST PGPORT PGUSER PGDATABASE

INTERRUPT_DB="${PGDATABASE}_interrupt"
ABSENT_DB="${PGDATABASE}_absent"
# Read from the manifest rather than restated here. A release that adds a
# migration or a posture predicate must not also have to edit a number in this
# drill: a count that has to be maintained is a count that stops being evidence.
manifest_count() {
  ROOT="$ROOT" node -e '
const manifest = require(process.env.ROOT + "/infra/release/release-manifest.json");
const paths = { expand: () => manifest.required_for_app.length,
                contract: () => manifest.deferred_contract.length,
                posture: () => manifest.posture.required_for_app.predicates.length };
process.stdout.write(String(paths[process.argv[1]]()));
' "$1"
}
EXPAND_COUNT="$(manifest_count expand)"
CONTRACT_COUNT="$(manifest_count contract)"
POSTURE_COUNT="$(manifest_count posture)"
TOTAL_COUNT=$((EXPAND_COUNT + CONTRACT_COUNT))
# The version step 11 has to find recorded while the mode is back at compat — that
# combination is the finding it measures — read from the manifest for the same
# reason the counts are.
CONTRACT_VERSION="$(ROOT="$ROOT" node -e '
const manifest = require(process.env.ROOT + "/infra/release/release-manifest.json");
process.stdout.write(String(manifest.deferred_contract[0].version));
')"

# Step 9 breaks a named FILE, not a position. The stale shim it stages collides
# with the `create or replace function public.assert_installment_schedule` inside
# this one, so the position it happens to occupy — and the newest version recorded
# before it — are read out of the manifest for the same reason the counts above
# are. A release that inserts a migration on either side of it must not also have
# to edit a number down there.
BREAK_FILE="20260817000000_l0_round4_money_and_business_integrity.sql"
manifest_before() {
  ROOT="$ROOT" node -e '
const manifest = require(process.env.ROOT + "/infra/release/release-manifest.json");
const list = manifest.required_for_app;
const at = list.findIndex((m) => m.file === process.argv[1]);
if (at < 1) {
  process.stderr.write(process.argv[1] + " is not a non-first entry of required_for_app\n");
  process.exit(1);
}
process.stdout.write(process.argv[2] === "version" ? list[at - 1].version : String(at));
' "$BREAK_FILE" "$1"
}
BREAK_PRIOR_COUNT="$(manifest_before count)"
BREAK_PRIOR_VERSION="$(manifest_before version)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "phase drill FAILED: $*" >&2; exit 1; }
note() { echo "-- $*"; }

command -v psql >/dev/null 2>&1 || fail "psql not found on PATH"
command -v node >/dev/null 2>&1 || fail "node not found on PATH"
node -e 'require.resolve("pg")' >/dev/null 2>&1 || fail "the pg module is not resolvable"

PSQL=(psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1)

# The same refusal every replay mode makes: this drill applies migrations, so it
# may only ever point at a database that holds nothing.
guard_empty() {
  local db="$1"
  local existing
  existing="$("${PSQL[@]}" -d "$db" -c "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'")"
  [ "$existing" = "0" ] || fail "$db already has $existing table(s) in public; refusing to use it"
}

prepare_db() {
  local db="$1"
  guard_empty "$db"
  "${PSQL[@]}" -d "$db" -f "$REPLAY_DIR/00_platform_bootstrap.sql" >/dev/null \
    || fail "the platform bootstrap did not apply to $db"
  "${PSQL[@]}" -d "$db" -f "$REPLAY_DIR/01_floor_schema.sql" >/dev/null \
    || fail "01_floor_schema.sql did not apply to $db"
  note "$db: floor applied"
}

# The connection URL reaches the tool only through a 0600 file, because the tool
# refuses a URL on the command line and this drill must exercise it the way an
# operator runs it. Trust auth in the harness means the file holds no secret.
url_file() {
  # Two statements, not one: bash expands every word of a `local a=… b=…$a…`
  # command before assigning any of them, so the single-line form read `$db` while
  # `db` was still unset and survived only because every caller so far happened to
  # have a `db` local of its own in scope. Under `set -u` the first caller that did
  # not — the cross-tool step below — aborted the drill.
  local db="$1"
  local file="$WORK/$db.url"
  printf 'postgresql://%s@%s:%s/%s\n' "$PGUSER" "$PGHOST" "$PGPORT" "$db" >"$file"
  chmod 600 "$file"
  echo "$file"
}

STEP=0
# run_phase <expect ok|refuse> <db> <phase> [extra args...]
run_phase() {
  local expect="$1" db="$2" phase="$3"
  shift 3
  STEP=$((STEP + 1))
  local log="$WORK/step-$STEP.log" rc=0
  node "$ROOT/scripts/db-phase-push.mjs" --phase "$phase" --url-file "$(url_file "$db")" "$@" >"$log" 2>&1 || rc=$?
  LAST_LOG="$log"
  if [ "$expect" = ok ] && [ "$rc" -ne 0 ]; then
    sed 's/^/    /' "$log" >&2
    fail "step $STEP ($phase $*) exited $rc; it was expected to succeed"
  fi
  if [ "$expect" = refuse ] && [ "$rc" -eq 0 ]; then
    sed 's/^/    /' "$log" >&2
    fail "step $STEP ($phase $*) succeeded; it was expected to refuse"
  fi
  note "step $STEP: $phase $* -> exit $rc (as expected)"
}

expect_log() {
  grep -qE "$1" "$LAST_LOG" || {
    sed 's/^/    /' "$LAST_LOG" >&2
    fail "step $STEP did not report /$1/"
  }
}

count_log() {
  local pattern="$1" want="$2" got
  got="$(grep -cE "$pattern" "$LAST_LOG" || true)"
  [ "$got" = "$want" ] || {
    sed 's/^/    /' "$LAST_LOG" >&2
    fail "step $STEP reported $got line(s) matching /$pattern/, expected $want"
  }
}

# ---------------------------------------------------------------------------
echo "== phase tool drill: $PGDATABASE (+ $INTERRUPT_DB, $ABSENT_DB) =="
node "$ROOT/scripts/check-release-manifest.mjs" >/dev/null || fail "the release manifest does not describe this tree"
note "release manifest: OK"

prepare_db "$PGDATABASE"

# 1 · no migration history at all: production has one, so this is fail-closed.
run_phase refuse "$PGDATABASE" required_for_app --plan
expect_log "refusing: the database has no supabase_migrations.schema_migrations"

# 2 · the contract phase may not go first.
run_phase refuse "$PGDATABASE" deferred_contract --apply --init-history
expect_log "the contract phase may not be applied while $EXPAND_COUNT required_for_app migration"

# 3 · the expand phase.
run_phase ok "$PGDATABASE" required_for_app --apply
count_log "^applied             : " "$EXPAND_COUNT"
count_log "^history verified    : " "$EXPAND_COUNT"
count_log "^posture OK          : " "$POSTURE_COUNT"
expect_log "posture OK          : release-mode-row-is-compat"
expect_log "posture OK          : gate-function-is-security-invoker"
# Every migration but one wraps itself in begin/commit, and the tool must skip
# exactly those two statements — otherwise the file's commit would end the tool's
# transaction and the history row would land outside it.
skipped_two="$(grep -cE '^applied .*[0-9]+ statements, [0-9]+ executed' "$LAST_LOG" || true)"
[ "$skipped_two" = "$EXPAND_COUNT" ] || fail "step $STEP did not report executed counts for all $EXPAND_COUNT migrations"
node -e '
const fs = require("fs");
const lines = fs.readFileSync(process.argv[1], "utf8").split(/\r?\n/).filter((l) => l.startsWith("applied "));
let bad = [];
for (const line of lines) {
  const m = /\((\d+) bytes, (\d+) statements, (\d+) executed/.exec(line);
  if (!m) { bad.push(line); continue; }
  const [, , statements, executed] = m.map(Number);
  const skipped = statements - executed;
  if (skipped !== 2 && skipped !== 0) bad.push(`${line} (skipped ${skipped})`);
}
if (bad.length) { console.error(bad.join("\n")); process.exit(1); }
console.log("-- transaction control skipped for every migration that declares it");
' "$LAST_LOG" || fail "step $STEP: a migration was applied with an unexpected number of skipped statements"

# 4 · idempotence.
run_phase ok "$PGDATABASE" required_for_app --apply
expect_log "^to apply            : 0$"
count_log "^applied             : " 0

# 5 · the contract phase is now allowed, and --plan writes nothing.
run_phase ok "$PGDATABASE" deferred_contract --plan
expect_log "plan only           : nothing was written"
recorded="$("${PSQL[@]}" -c "select count(*) from supabase_migrations.schema_migrations")"
[ "$recorded" = "$EXPAND_COUNT" ] || fail "--plan changed the recorded history ($recorded rows)"

# 6 · the contract phase.
run_phase ok "$PGDATABASE" deferred_contract --apply
count_log "^applied             : " "$CONTRACT_COUNT"
expect_log "posture OK          : release-mode-row-is-strict"
mode="$("${PSQL[@]}" -c "select direct_write_mode from public.money_release_mode where id = 'only'")"
[ "$mode" = "strict" ] || fail "the contract phase left the release mode at '$mode'"

# 7 · the expand phase after the window closed.
run_phase refuse "$PGDATABASE" required_for_app --apply
expect_log "the database already records the contract phase"

# 8 · verification of the phase as it stands.
run_phase ok "$PGDATABASE" deferred_contract --verify-only
expect_log "^OK$"

# ---------------------------------------------------------------------------
# 9 · interruption. A stale function with the same signature and a different
#     return type makes $BREAK_FILE fail at its
#     `create or replace function public.assert_installment_schedule` — after the
#     same file has already added three check constraints and a column.
note "creating $INTERRUPT_DB for the interruption test"
"${PSQL[@]}" -d postgres -c "create database $INTERRUPT_DB" >/dev/null
prepare_db "$INTERRUPT_DB"
"${PSQL[@]}" -d "$INTERRUPT_DB" -c "
  create function public.assert_installment_schedule(p_schedule jsonb, p_total numeric, p_subject text default 'contract')
  returns text language sql immutable as \$\$ select 'stale'::text \$\$" >/dev/null \
  || fail "could not stage the interruption"

run_phase refuse "$INTERRUPT_DB" required_for_app --apply --init-history
expect_log "refusing: ${BREAK_FILE//./\\.} failed at statement"
expect_log "no history row was written"
count_log "^applied             : " "$BREAK_PRIOR_COUNT"

interrupted="$("${PSQL[@]}" -d "$INTERRUPT_DB" -c "select count(*) from supabase_migrations.schema_migrations")"
[ "$interrupted" = "$BREAK_PRIOR_COUNT" ] || fail "the interrupted phase recorded $interrupted migrations, expected $BREAK_PRIOR_COUNT"
newest="$("${PSQL[@]}" -d "$INTERRUPT_DB" -c "select max(version) from supabase_migrations.schema_migrations")"
[ "$newest" = "$BREAK_PRIOR_VERSION" ] || fail "the interrupted phase recorded up to $newest, expected $BREAK_PRIOR_VERSION"
# The proof that the whole file rolled back: a column added by a statement BEFORE
# the failing one is absent. With the file's own `commit;` sent instead of
# skipped, this column would survive and the release would be half-applied with
# no record of it.
#
# It has to be a column that ONLY the broken file creates. payments.request_key
# cannot serve: 20260813100000_payment_request_key_idempotency.sql adds it earlier
# in the same phase, so it is legitimately present after that file commits and its
# survival proves nothing either way. payments.credited_to is added by the broken
# file alone (`grep -rl credited_to supabase/migrations` returns one path) and is
# not in the production floor.
rolled_back="$("${PSQL[@]}" -d "$INTERRUPT_DB" -c "select count(*) = 0 from information_schema.columns where table_schema = 'public' and table_name = 'payments' and column_name = 'credited_to'")"
[ "$rolled_back" = "t" ] || fail "payments.credited_to survived a rolled-back migration: the file's own transaction control escaped the tool's transaction"
# The same proof from a second object, added by the same file earlier still: a
# check constraint, which unlike a column cannot be explained away by an
# `if not exists` guard. Also created by no other migration.
constraint_gone="$("${PSQL[@]}" -d "$INTERRUPT_DB" -c "select count(*) = 0 from pg_constraint where conname = 'payments_amount_positive'")"
[ "$constraint_gone" = "t" ] || fail "payments_amount_positive survived a rolled-back migration"
note "interruption: $BREAK_PRIOR_COUNT applied through $BREAK_PRIOR_VERSION, $BREAK_FILE rolled back whole, nothing recorded for it"

# ---------------------------------------------------------------------------
# 10 · cross-tool reproducibility. Steps 3 and 6 checked the recorded rows with
#      this tool's own reading of the files, which cannot catch the two tools
#      disagreeing — and they did disagree: until Round-4 C4's closure this
#      applier split with a private splitter that kept the terminating `;` and
#      hashed with the superseded space-joined digest, while
#      scripts/verify-remote-migration-history.mjs is the thing that must later
#      reproduce these rows from these same files. Every version applied here is
#      claimed by --require-applied, so a row it cannot reproduce is not one
#      finding, it is a refusal of the whole predeploy gate — a deploy block no
#      amount of retrying clears. This step reads the history back through THAT
#      module: its query, its digest expression, its local half.
#
#      Only the gate's content comparison is exercised, not the gate's own run:
#      this database holds the 18 release migrations and none of production's
#      recorded baseline, so a full gate run here would report the baseline as
#      unapplied and the exit code would mean nothing about content.
cross_tool_check() {
  ROOT="$ROOT" node --input-type=module -e '
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const root = process.env.ROOT;
const base = pathToFileURL(root + "/");
const gate = await import(new URL("scripts/verify-remote-migration-history.mjs", base));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "infra/release/release-manifest.json"), "utf8"));
const dir = path.join(root, "supabase", "migrations");
const url = fs.readFileSync(process.argv[1], "utf8").split(/\r?\n/)[0].trim();

const claimed = new Set(
  [...manifest.required_for_app, ...manifest.deferred_contract].map((m) => String(m.version)),
);
const local = gate.readLocalMigrations(dir);
const content = gate.readLocalContent(dir, local);

// A CRLF checkout cannot answer this question: the applier sends and records the
// LF form, the gate fingerprints the bytes on disk, and the two differ for reasons
// that have nothing to do with either tool. The gate refuses by cause in that case
// rather than compare; here it has to be a hard stop, because a drill that skips
// its own subject and exits 0 is the failure mode this step exists to rule out.
const crlf = local.filter((entry) => claimed.has(entry.version) && content.get(entry.version)?.crlf);
if (crlf.length > 0) {
  console.error(`cross-tool: ${crlf.length} claimed migration file(s) are CRLF in this checkout; normalise to LF before running this drill`);
  process.exit(1);
}

const { rows, statementsRead } = await gate.fetchRemoteHistory(url, undefined);
if (!statementsRead) {
  console.error("cross-tool: the database did not return recorded statements, so nothing was compared");
  process.exit(1);
}

const problems = [];
let reproduced = 0;
for (const row of rows) {
  const version = String(row.version);
  if (!claimed.has(version)) continue;
  const local = content.get(version);
  if (!local || local.error) {
    problems.push(`${version}: no local content (${local?.error ?? "absent"})`);
    continue;
  }
  if (Number(row.statement_count) !== local.count) {
    problems.push(`${version}: recorded ${row.statement_count} statement(s), the file has ${local.count}`);
    continue;
  }
  if (row.statements_sha256 !== local.fingerprint) {
    problems.push(
      `${version}: recorded content is not reproducible from ${local.file} (${String(row.statements_sha256).slice(0, 12)}… vs ${local.fingerprint.slice(0, 12)}…)`,
    );
    continue;
  }
  reproduced += 1;
}
if (problems.length > 0) {
  for (const problem of problems) console.error(`cross-tool: ${problem}`);
  process.exit(1);
}
if (reproduced !== claimed.size) {
  console.error(`cross-tool: ${reproduced} of ${claimed.size} claimed migration(s) were read back; the rest are not recorded`);
  process.exit(1);
}
console.log(`-- cross-tool: ${reproduced}/${claimed.size} recorded rows reproduced from this release, format ${gate.FINGERPRINT_FORMAT}`);
' "$(url_file "$PGDATABASE")"
}

note "cross-tool: reading the recorded history back through the remote-history gate"
# The generic message names no cause on purpose: this step stops both for a real
# mismatch and for a checkout it cannot answer the question in, and the `cross-tool:`
# line printed above says which.
cross_tool_check || fail "the cross-tool reproducibility check did not pass; see the cross-tool line above"

# The negative control for the step above. A comparison that cannot fail is not
# evidence — F-05 — and this one runs against a live database, where a silent
# mismatch and a pass look identical from the outside. So one recorded array is
# perturbed in the smallest way that must be caught: the same statements, one
# boundary moved, count unchanged. That is exactly the difference the superseded
# space-joined digest could not see, and the length-delimited one must. The check is
# required to FAIL here; the row is then restored and the check required to pass
# again, so a perturbation that never landed cannot be mistaken for a catch.
note "cross-tool negative control: one moved statement boundary must be caught"
PROBE_VERSION="$BREAK_PRIOR_VERSION"
"${PSQL[@]}" -c "create table public._probe_backup as
  select version, statements from supabase_migrations.schema_migrations where version = '$PROBE_VERSION'" >/dev/null \
  || fail "could not stage the cross-tool negative control"
# Moving the boundary, not merging across it: one character crosses from the first
# recorded statement into the second, so the array's length and its concatenation
# are both unchanged and only the split differs. A merge would drop the count by one
# and be caught by the count alone, which would leave the digest untested — the
# thing the digest exists for is precisely the difference a count cannot see.
probed="$("${PSQL[@]}" -c "
  update supabase_migrations.schema_migrations
     set statements = array_cat(
           array[left(statements[1], -1), right(statements[1], 1) || statements[2]],
           statements[3:array_length(statements, 1)])
   where version = '$PROBE_VERSION'
     and array_length(statements, 1) >= 3
     and length(statements[1]) >= 2
  returning version")"
[ "$probed" = "$PROBE_VERSION" ] || fail "the negative control did not perturb $PROBE_VERSION (returned '$probed'), so it proves nothing"
if cross_tool_check >"$WORK/negative-control.log" 2>&1; then
  sed 's/^/    /' "$WORK/negative-control.log" >&2
  fail "the cross-tool check passed with a moved statement boundary: it is not measuring content"
fi
grep -qE "cross-tool: $PROBE_VERSION: recorded content is not reproducible" "$WORK/negative-control.log" \
  || { sed 's/^/    /' "$WORK/negative-control.log" >&2; fail "the cross-tool check failed for some other reason than the perturbation"; }
note "  perturbation caught: $PROBE_VERSION reported unreproducible"
"${PSQL[@]}" -c "update supabase_migrations.schema_migrations m
     set statements = b.statements
    from public._probe_backup b
   where m.version = b.version;
  drop table public._probe_backup" >/dev/null \
  || fail "could not restore $PROBE_VERSION after the negative control"
cross_tool_check || fail "the recorded history did not verify again after the negative control was reverted"

# ---------------------------------------------------------------------------
# 11 · release ↔ database-phase coupling (round-4 C8). Everything above measures
#      the applier. This measures the gate that stands between an operator and the
#      outage the applier makes possible: after step 6 the database is at state 4 —
#      contract applied, mode strict — and an application-only rollback to the
#      previous release refuses every direct money write that release makes.
#
#      scripts/check-release-phase.mjs is what refuses that rollback, and
#      tests/release/database-phase-coupling.test.mjs can only stub the mode. Here
#      the mode is real, read out of a real catalog, in all three states, and each
#      verdict is checked on BOTH channels: exit code, and the single
#      `NEWME_DB_PHASE=` line the rollback script records durably. A refusal that
#      still printed a mode would be recorded as a successful switch.
PHASE_GATE=$((0))
# phase_gate <ok|refuse> <db> <what> [gate args...]
phase_gate() {
  local expect="$1" db="$2" what="$3"
  shift 3
  PHASE_GATE=$((PHASE_GATE + 1))
  local out="$WORK/gate-$PHASE_GATE.out" err="$WORK/gate-$PHASE_GATE.err" rc=0
  GATE_OUT="$out"
  GATE_ERR="$err"
  node "$ROOT/scripts/check-release-phase.mjs" "$@" --url-file "$(url_file "$db")" >"$out" 2>"$err" || rc=$?
  if [ "$expect" = ok ] && [ "$rc" -ne 0 ]; then
    sed 's/^/    /' "$err" >&2
    fail "phase gate ($what) exited $rc; it was expected to allow"
  fi
  if [ "$expect" = refuse ] && [ "$rc" -eq 0 ]; then
    sed 's/^/    /' "$err" >&2
    fail "phase gate ($what) exited 0; it was expected to refuse"
  fi
  if [ "$expect" = refuse ] && [ -s "$out" ]; then
    sed 's/^/    /' "$out" >&2
    fail "phase gate ($what) refused but printed a mode on stdout, which a caller records as a switch it may make"
  fi
  note "phase gate: $what -> exit $rc (as expected)"
}
gate_mode() {   # the recorded line must be exactly one NEWME_DB_PHASE=<mode>
  local want="$1" got
  got="$(cat "$GATE_OUT")"
  [ "$got" = "NEWME_DB_PHASE=$want" ] || {
    fail "the phase gate recorded '$got', expected exactly 'NEWME_DB_PHASE=$want'"
  }
}
gate_says() {
  grep -qE "$1" "$GATE_ERR" || { sed 's/^/    /' "$GATE_ERR" >&2; fail "the phase gate did not report /$1/"; }
}

# The target of the rollback this finding is about: a release tree that predates
# the mechanism, so it carries no manifest and therefore no declaration. Built
# rather than mocked — readReleaseManifest has to walk a real directory.
PREMECHANISM="$WORK/release-premechanism"
mkdir -p "$PREMECHANISM/infra/release" "$PREMECHANISM/scripts"

note "release ↔ phase coupling: state 4 (strict)"
phase_gate ok "$PGDATABASE" "completion at state 4" --for-completion
gate_mode strict
phase_gate ok "$PGDATABASE" "switch to this release at state 4" --for-switch --release-dir "$ROOT"
gate_mode strict
phase_gate refuse "$PGDATABASE" "switch to the pre-mechanism release at state 4" --for-switch --release-dir "$PREMECHANISM"
gate_says "the database is in strict and the target release cannot serve traffic in strict"
gate_says "rollback_money_direct_write_contract_phase\.sql"
# The refusal must be reached through the pre-mechanism default, not through an
# unreadable-manifest error: those are different findings with different remedies.
gate_says "target declares    : absent, compat \(undeclared, no manifest in the release\)"

# state 4 → state 5. The runbook's two-action rollback, executed: the companion
# first, then the switch the gate refused a moment ago.
note "release ↔ phase coupling: running the rollback companion (state 4 → state 5)"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/rollback_money_direct_write_contract_phase.sql" >/dev/null \
  || fail "the rollback companion did not apply"
compat_mode="$("${PSQL[@]}" -c "select public.money_direct_write_mode()")"
[ "$compat_mode" = "compat" ] || fail "the companion left the mode at '$compat_mode'"
phase_gate ok "$PGDATABASE" "switch to the pre-mechanism release at state 5" --for-switch --release-dir "$PREMECHANISM"
gate_mode compat
# …and completion is now the thing that must refuse: the history still records the
# contract phase, which is exactly C8's "contract history can say applied while
# mode is compat". Only the mode can tell the difference.
recorded_contract="$("${PSQL[@]}" -c "select count(*) from supabase_migrations.schema_migrations where version = '$CONTRACT_VERSION'")"
[ "$recorded_contract" = "1" ] || fail "the contract phase is not recorded, so this is not the state C8 describes"
phase_gate refuse "$PGDATABASE" "completion at state 5" --for-completion
gate_says "a release may only be completed in strict"
gate_says "db-phase-push\.mjs --phase deferred_contract"

# state 5 → state 6. The refusal is a property of the database, not a one-shot
# event: re-entering strict must bring it back.
note "release ↔ phase coupling: re-entering strict (state 5 → state 6)"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/recontract_money_direct_write_contract_phase.sql" >/dev/null \
  || fail "the re-contract companion did not apply"
phase_gate refuse "$PGDATABASE" "switch to the pre-mechanism release at state 6" --for-switch --release-dir "$PREMECHANISM"
gate_says "the database is in strict"
phase_gate ok "$PGDATABASE" "completion at state 6" --for-completion
gate_mode strict

# ---------------------------------------------------------------------------
# State 1 needs a database the expand phase has never touched, because `absent` is
# the answer this release must never be served under and the answer an undeclared
# release must be allowed under. A third throwaway database is the only honest way
# to ask.
note "creating $ABSENT_DB for state 1 (absent)"
"${PSQL[@]}" -d postgres -c "create database $ABSENT_DB" >/dev/null
guard_empty "$ABSENT_DB"
phase_gate refuse "$ABSENT_DB" "switch to this release at state 1" --for-switch --release-dir "$ROOT"
gate_says "database phase     : absent"
gate_says "the database is in absent and the target release cannot serve traffic in absent"
phase_gate ok "$ABSENT_DB" "switch to the pre-mechanism release at state 1" --for-switch --release-dir "$PREMECHANISM"
gate_mode absent

# Negative control for `absent` itself. The gate asks pg_proc before it calls the
# function precisely so that a function which exists but cannot be used is NOT
# reported as absence — reading a revoked grant or a broken search_path as state 1
# is the one mistake that lets an undeclared release through while the database is
# strict. So: a present, callable-looking, failing function must produce a refusal
# and must NOT produce `absent`.
note "absence negative control: a present-but-unusable mode function must not read as absent"
"${PSQL[@]}" -d "$ABSENT_DB" -c "
  create function public.money_direct_write_mode() returns text language plpgsql as
  \$\$ begin raise exception 'mode unavailable' using errcode = '42501'; end \$\$" >/dev/null \
  || fail "could not stage the absence negative control"
phase_gate refuse "$ABSENT_DB" "an unusable mode function" --for-switch --release-dir "$PREMECHANISM"
grep -qE "database phase     : absent" "$GATE_ERR" \
  && { sed 's/^/    /' "$GATE_ERR" >&2; fail "a failing mode function was reported as absent: absence is not being established positively"; }
"${PSQL[@]}" -d "$ABSENT_DB" -c "drop function public.money_direct_write_mode()" >/dev/null \
  || fail "could not revert the absence negative control"
phase_gate ok "$ABSENT_DB" "state 1 again after the control was reverted" --for-switch --release-dir "$PREMECHANISM"
gate_mode absent

# The URL file discipline, measured where the modes are real. On a Windows
# development checkout these assertions pass vacuously; this drill is the only
# place they mean anything.
note "url file negative control: a group-readable URL file must be refused"
loose="$WORK/loose.url"
printf 'postgresql://%s@%s:%s/%s\n' "$PGUSER" "$PGHOST" "$PGPORT" "$ABSENT_DB" >"$loose"
chmod 644 "$loose"
loose_rc=0
node "$ROOT/scripts/check-release-phase.mjs" --for-switch --release-dir "$PREMECHANISM" \
  --url-file "$loose" >"$WORK/loose.out" 2>"$WORK/loose.err" || loose_rc=$?
[ "$loose_rc" -ne 0 ] || { sed 's/^/    /' "$WORK/loose.err" >&2; fail "the phase gate accepted a group-readable URL file"; }
[ ! -s "$WORK/loose.out" ] || fail "the phase gate printed a mode while refusing a loose URL file"
note "  refused (exit $loose_rc)"

echo "== phase drill OK: 11 steps, 3 databases, 4 + 7 refusals + 3 negative controls, $TOTAL_COUNT migrations applied in two phases and reproduced through the gate, release↔phase coupling measured in absent, compat and strict =="
