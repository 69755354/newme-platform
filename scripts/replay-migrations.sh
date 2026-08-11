#!/usr/bin/env bash
# ============================================================================
# Ephemeral migration replay
# ============================================================================
# Three modes, all against a throwaway PostgreSQL database. None of them touches
# production; the only database any of them talks to is the one named in
# PGDATABASE, and it refuses to start if that database already has application
# tables.
#
#   MODE=branch   (default, gating)
#       supabase/replay/01_floor_schema.sql, then only the migrations this branch
#       adds or changes, then fixtures, then a re-apply against those fixtures,
#       then supabase/replay/10_assert_release_contracts.sql, then the rollback
#       companion. This is the executable proof that the L0 migrations apply, do
#       what they claim at the behaviour level, are idempotent, and are
#       reversible.
#
#   MODE=control  (gating)
#       The floor and the fixtures, WITHOUT the migrations, then the same
#       assertion file. Requires that every assertion in CONTROL_MUST_FAIL below
#       fails. This is the negative control: it proves the assertions detect the
#       un-remediated state instead of passing against anything. It has already
#       earned its place — it caught three F-10 assertions that were passing
#       vacuously because the floor had no meta_tokens table for the migration to
#       act on.
#
#   MODE=history  (informational)
#       Every 14-digit migration in supabase/migrations/, from empty, in order.
#       Reports the first file that fails and how far it got. Does not gate,
#       because it does not currently pass and cannot be made to pass from this
#       branch — see below.
#
# Why the gate uses a floor instead of the real history
# ----------------------------------------------------
# Before this script existed, CI exercised four migrations (the narrowed contract
# under supabase/ci-local); the other 109 had never run anywhere except
# production. A migration that has never run is not a migration, it is a hope.
#
# Running the history for the first time showed that the directory is not a
# replayable history at all. In the first eight files: one carried a 10-digit
# unix epoch so the Supabase CLI never saw it, though its table is in production;
# one contains `ALTER TABLE TABLE`, a syntax error, and since the CLI runs each
# file in a single transaction it has never applied anywhere; one backfills from
# leads.metadata, a column no migration creates and production does not have; and
# four objects that production does have are created by no migration at all.
#
# Repairing the rest needs the live schema to decide what each dead file should
# now say, and several of them carry backfill UPDATEs that would rewrite
# production rows the first time they were allowed to run. That is an operator
# task — `supabase db dump` squashed into a baseline — not something to guess at
# from a branch. So the gate proves what it can actually prove, MODE=history
# stays runnable as the evidence, and the finding is reported rather than papered
# over.
#
# Requires: psql on PATH. No Supabase CLI, no Docker-in-Docker, no secrets — the
# CI job points it at a service container over trust/local auth.
#
# Usage:
#   PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGDATABASE=replay \
#     bash scripts/replay-migrations.sh
#   MODE=history ... bash scripts/replay-migrations.sh
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="$ROOT/supabase/migrations"
REPLAY_DIR="$ROOT/supabase/replay"

: "${MODE:=branch}"
: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=postgres}"
export PGHOST PGPORT PGUSER PGDATABASE

# ---------------------------------------------------------------------------
# The migrations this branch ships. Spelled out rather than globbed: the set is
# the thing under review, and a glob would silently widen it. Order matters.
# ---------------------------------------------------------------------------
BRANCH_MIGRATIONS=(
  20260601010000_baseline_undeclared_production_objects.sql
  20260811100000_f08_audit_logs_actor_identity.sql
  20260811100100_f06_profiles_revocation_columns.sql
  20260811100200_f10_meta_tokens_drop_permissive_select.sql
  20260811100300_f02_remove_default_credential_admin.sql
  20260811100400_f09_money_authorization_phase1.sql
  20260811100500_kpi_targets_atomic_replace.sql
)
ROLLBACK_COMPANION=rollback_l0_20260811.sql

# ---------------------------------------------------------------------------
# MODE=control expectations: assertions that MUST fail when the migrations are
# not applied. Anything not listed here is allowed to pass against the floor —
# the F-09 leg-2 outage detectors, for instance, are regression guards that are
# supposed to hold both before and after, and several catalog checks are
# preconditions rather than remediations. Being explicit about which assertions
# are load-bearing is the point of the list.
# ---------------------------------------------------------------------------
CONTROL_MUST_FAIL=(
  baseline-profiles-revocation-columns-exist
  f09-anon-cannot-execute-confirm-payment
  f09-anon-cannot-execute-approve-contract
  f09-anon-cannot-execute-allocate-payment
  f06-authenticated-cannot-update-email
  f06-authenticated-cannot-update-is-active
  f06-authenticated-cannot-update-role
  f08-permissive-audit-insert-policy-is-gone
  f08-audit-insert-closed-for-authenticated
  f08-authenticated-cannot-forge-audit-row
  f08-authenticated-cannot-append-self-attributed-audit-row
  f10-permissive-select-policy-is-gone
  f10-authenticated-has-no-select-grant
  f10-anon-has-no-select-grant
  f10-authenticated-cannot-read-meta-tokens
  f02-account-neutralised
  kpi-replace-function-exists
)

PSQL=(psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1)

# Migration files are applied with --single-transaction, because that is what the
# Supabase CLI does: one transaction per file. It is not a detail — it is why
# 20260603000000_add_crm_fields.sql has never applied anywhere despite being 243
# lines long, since its `ALTER TABLE TABLE` typo rolls the whole file back. A
# replay that committed statement-by-statement would let half a broken file
# through and report a state production can never be in.
#
# Many migrations here open their own `begin; ... commit;`, so psql logs
# "there is already a transaction in progress" / "there is no transaction in
# progress" for those files. That is expected, and it is what the CLI does too:
# the file's own COMMIT ends the wrapping transaction early. The warnings are
# left visible rather than silenced, because they are an accurate description of
# how those files behave when they are actually applied.
PSQL_TX=("${PSQL[@]}" --single-transaction)

fail() {
  echo "replay failed: $*" >&2
  exit 1
}

command -v psql >/dev/null 2>&1 || fail "psql not found on PATH"
[ -d "$MIGRATIONS_DIR" ] || fail "missing $MIGRATIONS_DIR"
[ -f "$REPLAY_DIR/00_platform_bootstrap.sql" ] || fail "missing platform bootstrap"

case "$MODE" in
  branch|control|history) ;;
  *) fail "MODE must be 'branch', 'control' or 'history', got '$MODE'" ;;
esac

# ---------------------------------------------------------------------------
# Filename lint. Runs in both modes because it is deterministic and needs no
# database: it encodes EXACTLY the Supabase CLI's rule — 14 digits, underscore,
# name, .sql — and matching the CLI matters in both directions.
#
#   * rollback_*.sql does not match, which is the property the down-migrations
#     rely on to stay inert.
#   * 1780601210_workflow_stages.sql did not match either — a 10-digit unix epoch
#     instead of a 14-digit timestamp — so the CLI had never seen it, never
#     pushed it and never replayed it, while the table it creates exists in
#     production because someone applied it by hand. A looser glob would have
#     hidden that. The file is now 20260604192650_workflow_stages.sql.
#
# So any .sql here that is neither a 14-digit migration nor a rollback_ companion
# is a hard failure, not a skip.
# ---------------------------------------------------------------------------
mapfile -t unrecognised < <(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' \
  -regextype posix-extended -not -regex '.*/([0-9]{14}_|rollback_).*\.sql' -print | LC_ALL=C sort)
if [ "${#unrecognised[@]}" -gt 0 ]; then
  printf 'invisible to the Supabase CLI: %s\n' "${unrecognised[@]##*/}" >&2
  fail "migration filenames must be <14-digit timestamp>_name.sql or rollback_*.sql"
fi

# ---------------------------------------------------------------------------
# Refuse a non-empty target. This is a replay harness, not a repair tool; if it
# is ever pointed at a database that already has application tables, the only
# safe thing it can do is stop.
# ---------------------------------------------------------------------------
existing="$("${PSQL[@]}" -c \
  "select count(*) from pg_tables where schemaname = 'public'" | tr -d '[:space:]')"
[ "$existing" = "0" ] || fail "target database is not empty (public has $existing tables)"

echo "== platform bootstrap =="
"${PSQL[@]}" -f "$REPLAY_DIR/00_platform_bootstrap.sql" >/dev/null

# ===========================================================================
# MODE=history — informational full replay
# ===========================================================================
if [ "$MODE" = history ]; then
  mapfile -t migrations < <(find "$MIGRATIONS_DIR" -maxdepth 1 -type f \
    -regextype posix-extended -regex '.*/[0-9]{14}_.*\.sql' -print | LC_ALL=C sort)
  [ "${#migrations[@]}" -gt 0 ] || fail "no timestamped migrations found"

  echo "== history replay: ${#migrations[@]} migrations from empty =="
  applied=0
  stopped_at=
  for migration in "${migrations[@]}"; do
    name="$(basename "$migration")"
    if ! "${PSQL_TX[@]}" -f "$migration"; then
      stopped_at="$name"
      break
    fi
    applied=$((applied + 1))
  done

  echo
  echo "HISTORY_REPLAY_APPLIED=$applied"
  echo "HISTORY_REPLAY_TOTAL=${#migrations[@]}"
  if [ -n "$stopped_at" ]; then
    echo "HISTORY_REPLAY_STOPPED_AT=$stopped_at"
    echo
    echo "The migration directory is not replayable from empty. This is a known,"
    echo "reported finding, not a harness bug: production was partly built by hand"
    echo "and the directory is a partial record of it. Fixing it requires a"
    echo "\`supabase db dump\` baseline taken by an operator with credentials."
    echo "MODE=branch is the gating job; this mode exists to keep the evidence"
    echo "reproducible and to show movement when the baseline lands."
  else
    echo "HISTORY_REPLAY_STOPPED_AT="
    echo
    echo "The full history now replays from empty. Promote this mode to a required"
    echo "gate and delete supabase/replay/01_floor_schema.sql."
  fi
  exit 0
fi

# ===========================================================================
# MODE=control — negative control
# ===========================================================================
if [ "$MODE" = control ]; then
  echo "== schema floor (no migrations) =="
  [ -f "$REPLAY_DIR/01_floor_schema.sql" ] || fail "missing schema floor"
  "${PSQL[@]}" -f "$REPLAY_DIR/01_floor_schema.sql" >/dev/null \
    || fail "01_floor_schema.sql did not apply to an empty database"

  echo "== behaviour fixtures =="
  "${PSQL[@]}" -f "$REPLAY_DIR/05_seed_behaviour_fixtures.sql" >/dev/null \
    || fail "behaviour fixtures did not load onto the floor"

  # ON_ERROR_STOP is deliberately OFF here. Against the un-remediated floor the
  # assertion file is expected to error repeatedly — a missing column makes
  # has_column_privilege() raise, a successful forgery makes its DO block raise —
  # and the run has to continue so that every expectation can be checked, not
  # just the first one.
  echo "== assertions against the un-remediated floor =="
  control_output="$(psql --no-psqlrc --quiet \
    -f "$REPLAY_DIR/10_assert_release_contracts.sql" 2>&1 || true)"

  passed_anyway=()
  for name in "${CONTROL_MUST_FAIL[@]}"; do
    if printf '%s\n' "$control_output" | grep -q "ASSERT_OK $name\$"; then
      passed_anyway+=("$name")
    fi
  done

  if [ "${#passed_anyway[@]}" -gt 0 ]; then
    printf 'passed without its migration: %s\n' "${passed_anyway[@]}" >&2
    fail "${#passed_anyway[@]} assertion(s) hold against the un-remediated floor, so they prove nothing"
  fi

  echo "== control OK: all ${#CONTROL_MUST_FAIL[@]} load-bearing assertions fail without their migration =="
  exit 0
fi

# ===========================================================================
# MODE=branch — the gate
# ===========================================================================
echo "== schema floor =="
[ -f "$REPLAY_DIR/01_floor_schema.sql" ] || fail "missing schema floor"
"${PSQL[@]}" -f "$REPLAY_DIR/01_floor_schema.sql" >/dev/null \
  || fail "01_floor_schema.sql did not apply to an empty database"

echo "== applying ${#BRANCH_MIGRATIONS[@]} branch migrations =="
for name in "${BRANCH_MIGRATIONS[@]}"; do
  path="$MIGRATIONS_DIR/$name"
  [ -f "$path" ] || fail "$name is listed in BRANCH_MIGRATIONS but does not exist"
  "${PSQL_TX[@]}" -f "$path" >/dev/null || fail "$name did not apply onto the floor"
  printf '  applied %s\n' "$name"
done

# ---------------------------------------------------------------------------
# Fixtures, then a second application of the same migrations.
#
# "The migration applied cleanly" against an empty schema says nothing: the F-02
# migration's entire behaviour is what it does to an existing account, and the
# revision of it that was reviewed DELETED rows. Seeding first and re-applying
# second means the migrations act on real rows, and it doubles as an idempotency
# check — the CLI never re-runs an applied migration, but an operator re-running
# one by hand must not end up with a different database.
# ---------------------------------------------------------------------------
echo "== behaviour fixtures =="
[ -f "$REPLAY_DIR/05_seed_behaviour_fixtures.sql" ] || fail "missing behaviour fixtures"
"${PSQL[@]}" -f "$REPLAY_DIR/05_seed_behaviour_fixtures.sql" >/dev/null \
  || fail "behaviour fixtures did not load"

echo "== re-applying the same migrations against the fixtures =="
for name in "${BRANCH_MIGRATIONS[@]}"; do
  "${PSQL_TX[@]}" -f "$MIGRATIONS_DIR/$name" >/dev/null \
    || fail "$name is not idempotent on re-apply"
  printf '  re-applied %s\n' "$name"
done

# ---------------------------------------------------------------------------
# Assertions. The file raises on failure; the runner additionally counts the
# ASSERT_OK markers, so an assertion file that silently stopped early — the
# false-green shape this repository has already shipped once — fails the job.
# ---------------------------------------------------------------------------
echo "== release contract assertions =="
[ -f "$REPLAY_DIR/10_assert_release_contracts.sql" ] || fail "missing assertions"
expected="$(sed -n 's/^-- ASSERT_TOTAL: \([0-9]\{1,\}\)$/\1/p' \
  "$REPLAY_DIR/10_assert_release_contracts.sql" | head -1)"
[ -n "${expected:-}" ] && [ "$expected" -gt 0 ] \
  || fail "assertion file does not declare ASSERT_TOTAL"

assert_output="$(psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 \
  -f "$REPLAY_DIR/10_assert_release_contracts.sql" 2>&1)" || {
  printf '%s\n' "$assert_output" >&2
  fail "release contract assertions raised"
}
printf '%s\n' "$assert_output"

observed="$(printf '%s\n' "$assert_output" | grep -c 'ASSERT_OK ' || true)"
[ "$observed" = "$expected" ] || \
  fail "expected $expected assertions to report ASSERT_OK, saw $observed"

# ---------------------------------------------------------------------------
# Down migration. Running the rollback companion after a successful up proves the
# rollout is reversible rather than merely documented as reversible.
# ---------------------------------------------------------------------------
echo "== rollback companion =="
[ -f "$MIGRATIONS_DIR/$ROLLBACK_COMPANION" ] || fail "missing $ROLLBACK_COMPANION"
"${PSQL_TX[@]}" -f "$MIGRATIONS_DIR/$ROLLBACK_COMPANION" >/dev/null \
  || fail "$ROLLBACK_COMPANION does not apply on top of the replayed schema"
echo "  $ROLLBACK_COMPANION applied"

echo "== replay OK: ${#BRANCH_MIGRATIONS[@]} migrations, $observed assertions, rollback clean =="
