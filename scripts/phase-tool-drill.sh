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
#
# Step 9 breaks the twelfth migration the way a real database breaks one: it leaves
# a stale `public.assert_installment_schedule(jsonb, numeric, text)` behind that
# returns text, so the migration's `create or replace ... returns integer` fails
# with 42P13, 331 lines into a file that has already altered three tables. No file
# in the repository is edited, moved or restored by this drill — that is the point
# of C7's "do not temporarily remove files".
#
# Requires: psql and node on PATH, the `pg` module resolvable, and an EMPTY
# database named in PGDATABASE. It also creates ${PGDATABASE}_interrupt. Nothing
# here touches production: the only databases it talks to are those two.
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
  local db="$1" file="$WORK/$db.url"
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
echo "== phase tool drill: $PGDATABASE (+ $INTERRUPT_DB) =="
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
#     return type makes the twelfth migration fail at its
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
expect_log "refusing: 20260817000000_l0_round4_money_and_business_integrity\.sql failed at statement"
expect_log "no history row was written"
count_log "^applied             : " 11

interrupted="$("${PSQL[@]}" -d "$INTERRUPT_DB" -c "select count(*) from supabase_migrations.schema_migrations")"
[ "$interrupted" = "11" ] || fail "the interrupted phase recorded $interrupted migrations, expected 11"
newest="$("${PSQL[@]}" -d "$INTERRUPT_DB" -c "select max(version) from supabase_migrations.schema_migrations")"
[ "$newest" = "20260816000000" ] || fail "the interrupted phase recorded up to $newest, expected 20260816000000"
# The proof that the whole file rolled back: a column added by a statement BEFORE
# the failing one is absent. With the file's own `commit;` sent instead of
# skipped, this column would survive and the release would be half-applied with
# no record of it.
rolled_back="$("${PSQL[@]}" -d "$INTERRUPT_DB" -c "select count(*) = 0 from information_schema.columns where table_schema = 'public' and table_name = 'payments' and column_name = 'request_key'")"
[ "$rolled_back" = "t" ] || fail "payments.request_key survived a rolled-back migration: the file's own transaction control escaped the tool's transaction"
# The same proof from a second object, added by the same file 350 lines earlier
# still: a check constraint, which unlike a column cannot be explained away by an
# `if not exists` guard.
constraint_gone="$("${PSQL[@]}" -d "$INTERRUPT_DB" -c "select count(*) = 0 from pg_constraint where conname = 'payments_amount_positive'")"
[ "$constraint_gone" = "t" ] || fail "payments_amount_positive survived a rolled-back migration"
note "interruption: 11 applied, the twelfth rolled back whole, nothing recorded for it"

echo "== phase drill OK: 9 steps, 2 databases, 5 refusals, $TOTAL_COUNT migrations applied in two phases =="
