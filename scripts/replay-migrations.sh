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
#   MODE=history  (gating)
#       Every 14-digit migration in supabase/migrations/, from empty, in order.
#       The history does not replay from empty — it never has — so this mode does
#       not gate on "it applies". It gates on the failure being EXACTLY the one
#       recorded in supabase/replay/history-replay-expectation.txt: the same file,
#       the same line, the same count of migrations applied before it. That makes
#       it a change detector rather than a report. A branch that repairs the
#       history must update the expectation file, and a branch that makes it fail
#       EARLIER — the shape of an accidental edit to applied history — fails here.
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
# from a branch — and the applied files are immutable, so this branch may not
# rewrite them to make the replay succeed. So the gate proves what it can actually
# prove, MODE=history pins the known failure point so it cannot move unnoticed,
# and the finding is reported rather than papered over.
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
# The migrations this branch ships are DERIVED, not listed.
#
# They used to be spelled out here, on the reasoning that a glob would silently
# widen the set under review. It did the opposite: the list was a second place
# that had to be updated, so when a migration was added or renamed the list went
# stale and the gate quietly stopped covering it. The reviewed head shipped
# exactly that — the list still named a file that had been renamed, so the
# harness would have failed on a missing file, and before that it named six of
# the seven migrations the branch actually added.
#
# The set is now computed as "present in supabase/migrations/ but not in
# supabase/migration-history-baseline.sha256", which is the definition of new,
# and the same derivation re-verifies that every already-applied file is
# byte-identical to the base. Under-declaring is no longer possible: a new file
# that nobody added to a list is still new.
# ---------------------------------------------------------------------------
BASELINE_MANIFEST="$ROOT/supabase/migration-history-baseline.sha256"
BRANCH_MIGRATIONS=()
ROLLBACK_COMPANIONS=()

# ---------------------------------------------------------------------------
# MODE=control expectations: assertions that MUST fail when the migrations are
# not applied.
#
# This is now the complete complement: of the 131 assertions in
# 10_assert_release_contracts.sql, exactly 31 hold against the un-remediated
# floor, and every one of the other 100 is listed here. The 31 that are absent are
# absent for a stated reason, not by omission — they are the F-09 leg-2 outage
# detectors (`authenticated` must KEEP its table grants), the F-02 "do not delete
# the identity" assertions, the last_active_at write the previous release needs,
# the two policies that were already closed before this branch, and the handful of
# positive money-path behaviours the pre-remediation routines got right in the
# simple case. Anything that could regress silently is on this list.
#
# The reviewed head listed 17 of 29, which meant twelve assertions could have been
# tautologies without the control noticing. If you add an assertion and the
# control does not complain, check whether it belongs here before assuming it is
# one of the 28.
# ---------------------------------------------------------------------------
CONTROL_MUST_FAIL=(
  baseline-profiles-revocation-columns-exist
  f09-anon-cannot-execute-confirm-payment
  f09-anon-cannot-execute-approve-contract
  f09-anon-cannot-execute-allocate-payment
  f06-authenticated-cannot-update-email
  f06-authenticated-cannot-update-password-changed-at
  f06-authenticated-cannot-update-force-password-change
  f06-authenticated-cannot-update-is-active
  f06-authenticated-cannot-update-role
  f08-permissive-audit-insert-policy-is-gone
  f08-audit-insert-closed-for-authenticated
  f08-activity-insert-closed-for-authenticated
  f08-session-insert-closed-for-authenticated
  f08-authenticated-cannot-forge-audit-row
  f08-authenticated-cannot-append-self-attributed-audit-row
  f10-permissive-select-policy-is-gone
  f10-authenticated-has-no-select-grant
  f10-anon-has-no-select-grant
  f10-authenticated-cannot-read-meta-tokens
  f02-account-neutralised
  kpi-replace-function-exists
  kpi-service-role-can-execute
  kpi-authenticated-cannot-execute
  kpi-anon-cannot-execute
  kpi-definer-with-pinned-search-path
  kpi-unassigned-target-is-unique-per-period-and-type
  kpi-fixture-period-seeded
  kpi-failed-replace-preserves-period
  kpi-empty-replace-preserves-period
  kpi-replace-refuses-duplicate-unassigned-keys
  kpi-duplicate-key-replace-preserves-period
  kpi-replace-holds-a-period-scoped-advisory-lock
  kpi-replace-lock-key-is-derived-from-the-period
  kpi-successful-replace-replaces-period
  money-actor-definer-with-pinned-search-path
  money-counters-table-unreachable-by-end-user-roles
  money-next-contract-no-unreachable-by-end-user-roles
  money-write-guards-installed-and-enabled
  money-routines-are-security-definer
  money-lead-won-trigger-kept-definer-and-pinned-search-path
  money-contract-no-seeded-from-highest-issued-number
  money-contract-no-increments-under-repeat-calls
  money-actor-returns-session-subject-for-end-user-call
  money-actor-refuses-claimed-id-that-is-not-the-session
  money-actor-refuses-inactive-account
  money-actor-refuses-disallowed-role
  money-actor-requires-an-actor-id-in-a-server-context
  f09-confirm-payment-refuses-impersonated-confirmer
  f09-confirm-payment-refuses-unauthorised-role
  f09-confirm-payment-succeeds-for-finance-as-itself
  money-confirm-payment-updates-project-paid-amount
  money-confirm-payment-increments-kpi-actual-amount
  money-confirm-payment-refuses-second-confirmation
  f09-allocate-payment-refuses-impersonated-allocator
  money-allocate-payment-refuses-plan-from-another-contract
  money-allocate-payment-leaves-the-other-contract-untouched
  money-allocate-payment-resets-de-allocated-plans
  money-allocate-payment-refuses-total-over-payment-amount
  f09-approve-contract-refuses-impersonated-approver
  f09-approve-contract-impersonation-left-the-contract-unapproved
  f09-approve-contract-refuses-sales-role
  money-approve-contract-admin-step-settles-pending-row-and-opens-ceo-review
  money-approve-contract-ceo-step-settles-and-approves
  money-approve-contract-raises-instead-of-returning-error-json
  money-approve-contract-rejects-unknown-action
  money-create-contract-is-atomic-for-a-sales-caller
  money-create-contract-issues-a-counter-based-number
  money-create-contract-refuses-second-active-contract-for-a-lead
  money-create-contract-refuses-non-positive-amount
  money-convert-quotation-refuses-non-owner-sales
  money-convert-quotation-refuses-unaccepted-quotation
  money-convert-quotation-is-atomic-for-the-owner
  money-convert-quotation-refuses-second-conversion
  money-direct-contract-insert-refused
  money-direct-contract-status-update-refused
  money-direct-contract-amount-update-refused
  money-direct-payment-insert-preconfirmed-refused
  money-direct-payment-confirmation-refused
  money-confirmed-payment-amount-immutable
  money-direct-contract-approval-insert-refused
  money-direct-payment-allocation-insert-refused
  money-direct-installment-plan-delete-refused
  money-set-contract-status-permits-owner-submission-for-approval
  money-set-contract-status-refuses-approval-chain-transition
  money-revoke-contract-requires-a-manager
  session-predicates-are-definer-with-pinned-search-path
  session-predicates-not-executable-by-anon
  session-boundary-covers-every-authenticated-reachable-table
  session-boundary-policies-are-restrictive-and-scoped-to-authenticated
  session-inactive-admin-identity-reads-no-contracts
  session-inactive-identity-reads-no-profile-row
  session-inactive-identity-cannot-write-its-own-profile
  session-banned-identity-reads-no-contracts
  session-ban-fixture-was-rolled-back
  session-token-issued-before-password-change-reads-nothing
  session-token-issued-after-password-change-still-reads
  session-claim-set-without-iat-is-refused
  session-stale-token-still-reads-its-own-profile-row
  session-stale-token-cannot-enumerate-other-profiles
  session-password-change-fixture-was-rolled-back
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
# History integrity, then derivation of the branch set. Deterministic, needs no
# database and no git, so it runs in every mode.
#
# Three properties, each of which the reviewed head got wrong:
#
#   1. Immutability. Every file the baseline manifest lists as already applied
#      must still be present under the same name with the same content. The
#      reviewed head had renamed 1780601210_workflow_stages.sql to a backdated
#      20260604192650_ name and rewritten 20260603000000_add_crm_fields.sql,
#      both of which production records as applied.
#
#   2. Filename shape, for NEW files only. The rule is the Supabase CLI's:
#      14 digits, underscore, name, .sql. rollback_*.sql deliberately does not
#      match — that is the property the down-migrations rely on to stay inert.
#      1780601210_workflow_stages.sql does not match either, and that is the
#      recorded defect: a 10-digit unix epoch, so the CLI never saw it, never
#      pushed it and never replayed it, while the table it creates is in
#      production because someone applied it by hand. It is pinned by name and
#      hash in the manifest instead of being renamed away, so the defect stays
#      visible and stays reportable, while a SECOND file with a name the CLI
#      cannot see is still a hard failure.
#
#   3. Forward-only ordering. A new migration must sort strictly after every
#      applied one, or a fresh database applies it in a different order than
#      production did.
#
# The hash is sha256 over content with CRLF normalised to LF, matching
# scripts/check-migration-history.mjs, so the two gates cannot disagree and
# neither depends on the developer's platform.
# ---------------------------------------------------------------------------
[ -f "$BASELINE_MANIFEST" ] || fail "missing $BASELINE_MANIFEST"

content_hash() { sed 's/\r$//' "$1" | sha256sum | cut -d' ' -f1; }

declare -A BASELINE_HASH=()
highest_applied=
while read -r hash name; do
  [ -n "$hash" ] || continue
  BASELINE_HASH["$name"]="$hash"
  case "$name" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]_*)
      stamp="${name:0:14}"
      if [[ ! "$stamp" =~ ^[0-9]{14}$ ]]; then continue; fi
      if [ -z "$highest_applied" ] || [[ "$stamp" > "$highest_applied" ]]; then
        highest_applied="$stamp"
      fi
      ;;
  esac
done < <(grep -v '^[[:space:]]*#' "$BASELINE_MANIFEST" | grep -v '^[[:space:]]*$')

[ "${#BASELINE_HASH[@]}" -gt 0 ] || fail "baseline manifest lists no migrations"
[ -n "$highest_applied" ] || fail "baseline manifest declares no 14-digit applied migration"

tampered=()
for name in "${!BASELINE_HASH[@]}"; do
  path="$MIGRATIONS_DIR/$name"
  if [ ! -f "$path" ]; then
    tampered+=("$name: MISSING (deleted or renamed)")
  elif [ "$(content_hash "$path")" != "${BASELINE_HASH[$name]}" ]; then
    tampered+=("$name: MODIFIED")
  fi
done
if [ "${#tampered[@]}" -gt 0 ]; then
  printf 'applied migration changed: %s\n' "${tampered[@]}" >&2
  fail "${#tampered[@]} already-applied migration(s) differ from the baseline manifest; restore them byte-for-byte and use a new forward-only migration instead"
fi

mapfile -t all_sql < <(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' -print \
  | sed 's|.*/||' | LC_ALL=C sort)

bad_names=()
for name in "${all_sql[@]}"; do
  if [ -n "${BASELINE_HASH[$name]+set}" ]; then
    continue                       # already applied, verified above
  fi
  case "$name" in
    rollback_*.sql)
      ROLLBACK_COMPANIONS+=("$name")
      continue
      ;;
  esac
  if [[ ! "$name" =~ ^[0-9]{14}_.*\.sql$ ]]; then
    bad_names+=("$name: the Supabase CLI will never apply this name")
    continue
  fi
  if [[ ! "${name:0:14}" > "$highest_applied" ]]; then
    bad_names+=("$name: sorts at or before the last applied migration ($highest_applied)")
    continue
  fi
  BRANCH_MIGRATIONS+=("$name")
done
if [ "${#bad_names[@]}" -gt 0 ]; then
  printf 'rejected migration: %s\n' "${bad_names[@]}" >&2
  fail "${#bad_names[@]} new migration file(s) violate the naming or forward-only rule"
fi

[ "${#BRANCH_MIGRATIONS[@]}" -gt 0 ] \
  || fail "no new migrations found; the gate would assert nothing"

# ---------------------------------------------------------------------------
# Rollback coverage, declared by the artifacts themselves.
#
# A rollback companion names the migrations it reverses with `-- ROLLS_BACK:`
# lines, and a migration that intentionally has no rollback says so with
# `-- NO_ROLLBACK:` plus a reason. Every new migration must be covered by one or
# the other, so shipping a migration with no way back is a gate failure rather
# than something discovered during an incident.
#
# Deriving which companions to execute from these declarations also keeps the
# gate from running the pre-existing companions for base-history migrations,
# which the floor never applied and which would fail for the wrong reason.
# ---------------------------------------------------------------------------
declare -A ROLLBACK_FOR=()
for companion in "${ROLLBACK_COMPANIONS[@]}"; do
  while read -r covered; do
    [ -n "$covered" ] || continue
    ROLLBACK_FOR["$covered"]="$companion"
  done < <(sed -n 's/^--[[:space:]]*ROLLS_BACK:[[:space:]]*\([A-Za-z0-9_.-]\{1,\}\)[[:space:]]*$/\1/p' \
    "$MIGRATIONS_DIR/$companion")
done

uncovered=()
BRANCH_ROLLBACKS=()
for name in "${BRANCH_MIGRATIONS[@]}"; do
  if [ -n "${ROLLBACK_FOR[$name]+set}" ]; then
    companion="${ROLLBACK_FOR[$name]}"
    case " ${BRANCH_ROLLBACKS[*]-} " in
      *" $companion "*) ;;
      *) BRANCH_ROLLBACKS+=("$companion") ;;
    esac
  elif grep -qE '^--[[:space:]]*NO_ROLLBACK:[[:space:]]*\S' "$MIGRATIONS_DIR/$name"; then
    printf '  no rollback by declaration: %s\n' "$name"
  else
    uncovered+=("$name")
  fi
done
if [ "${#uncovered[@]}" -gt 0 ]; then
  printf 'no rollback companion: %s\n' "${uncovered[@]}" >&2
  fail "${#uncovered[@]} new migration(s) have neither a '-- ROLLS_BACK:' companion nor a '-- NO_ROLLBACK: <reason>' declaration"
fi

# Reverse application order.
mapfile -t BRANCH_ROLLBACKS < <(printf '%s\n' "${BRANCH_ROLLBACKS[@]}" | LC_ALL=C sort -r)

echo "== history integrity =="
echo "  applied and unchanged : ${#BASELINE_HASH[@]}"
echo "  last applied stamp    : $highest_applied"
echo "  new on this branch    : ${#BRANCH_MIGRATIONS[@]}"
printf '    %s\n' "${BRANCH_MIGRATIONS[@]}"
echo "  rollback companions   : ${#BRANCH_ROLLBACKS[@]}"
printf '    %s\n' "${BRANCH_ROLLBACKS[@]}"

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
  echo "HISTORY_REPLAY_STOPPED_AT=$stopped_at"
  echo

  # -------------------------------------------------------------------------
  # This mode used to print the numbers and exit 0, and CI ran it with
  # continue-on-error: true. Both halves of that were wrong: a step that cannot
  # fail is not a check, and the job it lived in reported success while its own
  # log said the migration directory does not replay.
  #
  # It is now gated against a committed expectation. The debt is real and is not
  # fixable from this branch, so the gate asserts its exact shape rather than its
  # absence: stop at exactly this file, after exactly this many applications.
  # Movement in either direction — a repair, or a regression that breaks an
  # earlier file — turns the job red and has to be acknowledged.
  # -------------------------------------------------------------------------
  expectation="$REPLAY_DIR/history-replay-expectation.txt"
  [ -f "$expectation" ] || fail "missing $expectation"

  exp_applied="$(sed -n 's/^EXPECTED_APPLIED=\([0-9]\{1,\}\)$/\1/p' "$expectation" | head -1)"
  exp_stopped="$(sed -n 's/^EXPECTED_STOPPED_AT=\(.*\)$/\1/p' "$expectation" | head -1)"
  [ -n "$exp_applied" ] || fail "$expectation does not declare EXPECTED_APPLIED"

  mismatch=0
  if [ "$applied" != "$exp_applied" ]; then
    echo "expected EXPECTED_APPLIED=$exp_applied, observed $applied" >&2
    mismatch=1
  fi
  if [ "$stopped_at" != "$exp_stopped" ]; then
    echo "expected EXPECTED_STOPPED_AT=$exp_stopped, observed '${stopped_at:-<none>}'" >&2
    mismatch=1
  fi

  if [ "$mismatch" -ne 0 ]; then
    if [ -z "$stopped_at" ]; then
      fail "the full history now replays from empty. This is good news and still a failure: update $expectation, promote this mode to the primary gate and delete supabase/replay/01_floor_schema.sql"
    fi
    fail "the migration history debt changed shape. Re-read the log, then update $expectation in the same commit as whatever moved it"
  fi

  echo "== history debt unchanged: $applied applied, stops at $stopped_at as recorded =="
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

  # -----------------------------------------------------------------------
  # Three checks, not one. The reviewed head had only the second, which is
  # satisfiable by accident: "no line matching ASSERT_OK <name>" is also true
  # when there is no assertion called <name> at all, so a renamed or misspelled
  # entry in CONTROL_MUST_FAIL passed the control forever while proving nothing.
  # -----------------------------------------------------------------------
  assertion_file="$REPLAY_DIR/10_assert_release_contracts.sql"

  # 1 · every name listed here must actually exist as an assertion.
  missing_names=()
  for name in "${CONTROL_MUST_FAIL[@]}"; do
    grep -qF "'$name'" "$assertion_file" || missing_names+=("$name")
  done
  if [ "${#missing_names[@]}" -gt 0 ]; then
    printf 'listed in CONTROL_MUST_FAIL but not defined in the assertion file: %s\n' "${missing_names[@]}" >&2
    fail "${#missing_names[@]} control expectation(s) name an assertion that does not exist, so they can never fail and never prove anything"
  fi

  # 2 · none of them may hold against the un-remediated floor.
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

  # 3 · the marker the other two checks depend on must be observable. If the
  # assertion file failed to run, or the ASSERT_OK format changed, check 2
  # becomes vacuously true and the control turns into a rubber stamp.
  control_ok="$(printf '%s\n' "$control_output" \
    | grep -oE 'ASSERT_OK [a-z0-9][a-z0-9-]*' | sort -u | wc -l | tr -d ' ')"
  [ "$control_ok" -gt 0 ] || {
    printf '%s\n' "$control_output" >&2
    fail "the control run produced no ASSERT_OK markers at all, so 'did not pass' proves nothing about any assertion"
  }

  # 4 · every assertion is accounted for. listed-as-must-fail + observed-to-pass
  # has to equal the declared total, which makes the control complete rather than
  # merely non-empty: a new assertion that fails against the floor and is NOT
  # listed above changes the total without changing either term, and lands here.
  # That is the hole the reviewed head had — twelve assertions were neither listed
  # nor passing, so any one of them could have been a tautology unnoticed.
  declared_total="$(grep -m1 -oE '^-- ASSERT_TOTAL: [0-9]+' "$assertion_file" | grep -oE '[0-9]+')"
  [ -n "$declared_total" ] || fail "$assertion_file declares no ASSERT_TOTAL"
  accounted=$(( ${#CONTROL_MUST_FAIL[@]} + control_ok ))
  if [ "$accounted" -ne "$declared_total" ]; then
    printf 'must-fail listed : %s\npassed on floor  : %s\ndeclared total   : %s\n' \
      "${#CONTROL_MUST_FAIL[@]}" "$control_ok" "$declared_total" >&2
    # Diagnostic only, and scraped rather than parsed, so it can carry a stray
    # string literal. The counts above are the authority; this is the shortlist to
    # look at first.
    printf 'candidates to classify (scraped from the file, may include non-assertion literals):\n' >&2
    grep -oE "'[a-z0-9][a-z0-9-]*'\);" "$assertion_file" | tr -d "');" | sort -u \
      | grep -vxF -f <(printf '%s\n' "${CONTROL_MUST_FAIL[@]}" | sort -u) \
      | grep -vxF -f <(printf '%s\n' "$control_output" \
          | grep -oE 'ASSERT_OK [a-z0-9][a-z0-9-]*' | sed 's/^ASSERT_OK //' | sort -u) >&2 || true
    fail "the control accounts for $accounted of $declared_total assertions; an assertion that neither passes against the floor nor is declared load-bearing proves nothing either way"
  fi

  echo "== control OK: ${#CONTROL_MUST_FAIL[@]} load-bearing assertions all fail without their migration =="
  echo "   ($control_ok of $declared_total passed against the floor, which is how we know the file ran;"
  echo "    ${#CONTROL_MUST_FAIL[@]} + $control_ok = $declared_total, so every assertion is accounted for)"
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
# Down migration, then the state it leaves behind.
#
# "The rollback SQL executes" was the entire previous claim, and it was not
# enough: the companion that executed cleanly also re-enabled the published
# credential's profile, re-granted meta_tokens to authenticated, re-granted
# profiles UPDATE and recreated the with_check(true) audit-insert policy. It
# rolled back the security fixes along with the schema, and the gate was green
# because SQL that opens a hole runs just as cleanly as SQL that closes one.
#
# So the rollback is followed by a second assertion file whose only job is the
# post-rollback state: whatever else reverting does, it must not restore a
# vulnerability. Counted exactly, like the first one.
# ---------------------------------------------------------------------------
echo "== rollback companions =="
for companion in "${BRANCH_ROLLBACKS[@]}"; do
  [ -f "$MIGRATIONS_DIR/$companion" ] || fail "missing $companion"
  "${PSQL_TX[@]}" -f "$MIGRATIONS_DIR/$companion" >/dev/null \
    || fail "$companion does not apply on top of the replayed schema"
  printf '  applied %s\n' "$companion"
done

echo "== post-rollback security invariants =="
POST_ROLLBACK_ASSERTS="$REPLAY_DIR/20_assert_post_rollback.sql"
[ -f "$POST_ROLLBACK_ASSERTS" ] || fail "missing post-rollback assertions"
post_expected="$(sed -n 's/^-- ASSERT_TOTAL: \([0-9]\{1,\}\)$/\1/p' "$POST_ROLLBACK_ASSERTS" | head -1)"
[ -n "${post_expected:-}" ] && [ "$post_expected" -gt 0 ] \
  || fail "post-rollback assertion file does not declare ASSERT_TOTAL"

post_output="$(psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 -f "$POST_ROLLBACK_ASSERTS" 2>&1)" || {
  printf '%s\n' "$post_output" >&2
  fail "rollback restored a security hole (post-rollback assertions raised)"
}
printf '%s\n' "$post_output"
post_observed="$(printf '%s\n' "$post_output" | grep -c 'ASSERT_OK ' || true)"
[ "$post_observed" = "$post_expected" ] \
  || fail "expected $post_expected post-rollback assertions, saw $post_observed"

echo "== replay OK: ${#BRANCH_MIGRATIONS[@]} migrations, $observed release assertions, ${#BRANCH_ROLLBACKS[@]} rollback companion(s), $post_observed post-rollback assertions =="
