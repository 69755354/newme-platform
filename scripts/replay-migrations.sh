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
#       then supabase/replay/10_assert_release_contracts.sql, then
#       supabase/replay/15_concurrency_two_session.sh with EXPECT=consistent,
#       then the rollback companion and supabase/replay/20_assert_post_rollback.sql,
#       then the recontract companion — twice — and
#       supabase/replay/30_assert_post_recontract.sql. This is the executable proof
#       that the L0 migrations apply, do what they claim at the behaviour level,
#       hold up under two concurrent writers, are idempotent, are reversible, and
#       that the posture a rollback gives up can be re-entered afterwards without
#       replaying an already-recorded migration (review round 4 B9).
#
#   MODE=control  (gating)
#       The floor and the fixtures, WITHOUT the migrations, then the same
#       assertion file with `replay.collect = on`, then exact marker accounting
#       against supabase/replay/control-expectations.txt: every assertion declared
#       load-bearing must emit exactly one `ASSERT_FAIL <name>`, every assertion
#       declared floor-passing must emit exactly one `ASSERT_OK <name>`, and the
#       run must contain no unclassified SQL error. This is the negative control:
#       it proves the assertions detect the un-remediated state instead of passing
#       against anything. It has already earned its place — it caught three F-10
#       assertions that were passing vacuously because the floor had no
#       meta_tokens table for the migration to act on. It then runs
#       supabase/replay/15_concurrency_two_session.sh with EXPECT=lost, which
#       requires the floor to actually lose a concurrent allocation.
#
#   MODE=history  (gating)
#       The authenticated, schema-only production baseline is verified byte for
#       byte against its capture metadata and migration-history reconciliation,
#       applied to empty PG17, and proved to contain zero application rows. The
#       exact release-manifest set after the captured production watermark is then
#       required to equal the timestamped files on disk and is run through the
#       same fixtures, re-entry, behaviour, concurrency, rollback and recontract
#       chain as MODE=branch. Baseline tampering, undeclared pending migrations,
#       row-bearing SQL and credential-shaped material all refuse before apply.
#
# Why branch/control retain a floor
# ---------------------------------
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
# The applied files remain immutable and several carry unsafe backfills, so they
# are not rewritten to manufacture a replay. MODE=history instead starts at the
# independently captured production watermark. MODE=branch and MODE=control keep
# the smaller synthetic floor because their mutation controls require a known
# vulnerable state; neither floor is evidence about production history.
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
RECONTRACT_COMPANIONS=()

# ---------------------------------------------------------------------------
# MODE=control expectations live in supabase/replay/control-expectations.txt,
# one declared verdict per assertion, and are enforced by
# scripts/control-marker-accounting.mjs.
#
# They used to be a 176-name bash array here, checked by "this name appears in the
# assertion file" plus "no ASSERT_OK line was seen for it". Round-3 finding P1-12:
# the second half is satisfied by an assertion that never executed, and 78 of them
# never executed — against the un-remediated floor a DO block that hits
# undefined_function aborts and silences every assertion below it. The gate
# reported "100 load-bearing assertions all fail without their migration" over a
# log with 87 assertion-specific markers and 40 unclassified SQL errors.
#
# The accounting is now one marker per assertion in both directions, and the
# accounting logic itself is mutation-tested by
# tests/release/control-marker-accounting.test.mjs — the previous gate was
# untested shell, which is why nobody noticed it was counting absences.
# ---------------------------------------------------------------------------
CONTROL_EXPECTATIONS="$REPLAY_DIR/control-expectations.txt"
CONTROL_ACCOUNTING="$ROOT/scripts/control-marker-accounting.mjs"
HISTORY_BASELINE_CHECK="$ROOT/scripts/check-history-baseline.mjs"
HISTORY_BASELINE_SQL="$REPLAY_DIR/production-schema-baseline.sql"

# ---------------------------------------------------------------------------
# The one behaviour no assertion in 10_assert_release_contracts.sql can reach:
# a lost update needs two sessions, and that file runs in one. Round-3 finding
# P1-7 was reproduced by hand and fixed with row locks in allocate_payment(); the
# reproduction now lives in supabase/replay/15_concurrency_two_session.sh and is
# required to come out CONSISTENT in MODE=branch and LOST in MODE=control, so
# deleting the `for update` again turns the gate red instead of going unnoticed.
# ---------------------------------------------------------------------------
CONCURRENCY_GATE="$REPLAY_DIR/15_concurrency_two_session.sh"

# ---------------------------------------------------------------------------
# The same argument for round-4 finding B3. Sequentially, "the same payment
# request twice is one payment" is a uniqueness rule and the assertion file
# measures it. Concurrently it is a claim about an index: two overlapping
# transactions carrying one request key must not both produce a payment, and
# nothing a single session does can distinguish an index from a
# SELECT-then-INSERT in application code that happens to work when unraced.
# Required UNIQUE in MODE=branch and DUPLICATE in MODE=control, so dropping
# idx_payments_request_key turns the gate red.
# ---------------------------------------------------------------------------
REQUEST_KEY_GATE="$REPLAY_DIR/16_concurrency_request_key.sh"

# ---------------------------------------------------------------------------
# And the same argument for round-4 finding C4-3, with one difference that
# decides where the control lives.
#
# "The contract phase refuses direct writes" is a single-session claim and
# 10_assert_release_contracts.sql measures it. "The contract phase does not commit
# 'strict' underneath a write the PREVIOUS release already has in flight" is a
# claim about two overlapping transactions, and no single session can distinguish
# a serialized flip from an unserialized one — both leave mode = 'strict' and both
# refuse the next write.
#
# Unlike the two gates above, its negative control cannot run in MODE=control:
# the un-remediated floor has no money_release_mode, no mode function and no
# guards, so there is no flip there to fail to serialize. So both directions run
# here, against this schema, and the mutant is the guard itself —
# money_direct_write_is_blocked() replaced with its pre-C4-3 lock-free body inside
# the throwaway replay database, captured with pg_get_functiondef() and restored
# from that capture. EXPECT=torn runs FIRST on purpose: if the restore did not put
# the serialized guard back, the EXPECT=serialized run immediately after it goes
# red rather than the rest of the harness quietly measuring a mutated database.
# ---------------------------------------------------------------------------
MODE_FLIP_GATE="$REPLAY_DIR/17_concurrency_mode_flip.sh"

# The same claim about the other way in. The three artifacts above are hand-run
# files; public.money_set_direct_write_mode() is the GRANTED route — service_role
# holds EXECUTE on it and this harness's own assertions call it — so serializing
# the files and leaving the function unlocked would make the serialization depend
# on the caller's choice of path. Same two directions, same in-database mutation
# restored from pg_get_functiondef(), control first for the same reason.
MODE_SETTER_GATE="$REPLAY_DIR/18_concurrency_mode_setter.sh"

# ---------------------------------------------------------------------------
# R3, and the same argument once more. "A period's targets are saved atomically"
# and "a collection is added to actual_amount" are both single-session claims that
# 10_assert_release_contracts.sql measures. "A collection that overlaps a target
# save survives it" is not: replace_kpi_targets() and clear_kpi_targets() took a
# period advisory lock, confirm_payment() and void_payment() wrote the same rows
# without it, and the only way to observe that is two transactions in flight at
# once. Sequentially every one of the four routines does the arithmetic anyone
# would expect.
#
# Its negative control cannot run in MODE=control either, and for a sharper reason
# than the mode gates': the un-remediated floor has no B7 carry-forward, so a
# target save there resets actuals to zero whether or not anything raced it, and
# the floor therefore cannot distinguish this finding from the one B7 closed. So
# both directions run here, against this schema, and the mutant is the LIVE
# definitions of confirm_payment()/void_payment() with the one
# pg_advisory_xact_lock() line removed from each — captured with
# pg_get_functiondef(), restored from that capture, byte-compared on the way back.
# EXPECT=lost runs FIRST for the same reason it does above.
# ---------------------------------------------------------------------------
KPI_PERIOD_GATE="$REPLAY_DIR/19_concurrency_kpi_period.sh"

# ---------------------------------------------------------------------------
# R5, whose control is neither a mutation nor MODE=control but the release mode
# itself.
#
# The finding is that seven read paths counted a payment as cash when
# `confirmed` was true, while every derived total in the database counts
# `confirmed = true and voided_at is null`. That is only a defect if a row can
# hold both — and one can, because guard_payments_write() places its
# confirmed-immutability checks behind money_direct_write_is_blocked() (direct AND
# strict) while refusing void-column edits unconditionally. So inside the
# compatibility window the contract's own salesperson can re-confirm a reversed
# payment with an ordinary UPDATE, and the two predicates then disagree by its
# amount.
#
# EXPECT=compat is therefore the reproduction and EXPECT=strict is the bound, with
# the mode as the only variable: same row, same statement, same session identity.
# The reproduction runs FIRST for the same reason the mutants above do — if compat
# no longer admits the write, the finding is closed in the database and this gate
# has to say so instead of the strict run reporting green for a state nobody can
# reach. Four claims the mode does not change are measured in both directions (the
# reversal is one-way; the confirm/allocate refusals form a loop with no exit; both
# refusals are idempotent on retry; a rolled-back write leaves nothing), and the
# in-flight write is required to hold money_release_mode_lock_key() in SHARE mode —
# asserted by re-taking the key and finding no new pg_locks row, which ties this
# gate's write to the exclusive lock 17_/18_ prove the flip takes.
#
# It stages one payment in a period no fixture and no assertion uses, removes it
# again, and restores the mode it was invoked under, so what follows sees the state
# the fixtures left.
# ---------------------------------------------------------------------------
PREDICATE_GATE="$REPLAY_DIR/21_payment_predicate_divergence.sh"

# ---------------------------------------------------------------------------
# R6, in two gates, because the lead-reassignment path turned out to hold three
# defects of two different kinds, and the first kind is a precondition of measuring
# the second.
#
# 22_ measures two defects that are not concurrency findings at all: statements
# reassign_lead_atomic() makes that the schema it writes into refuses.
#   * activities (20260723140000:165-169) inserts type = 'transfer', and
#     activities_type_check — the domain 20260605000000:209-214 installed, still the
#     last word on that column — does not contain it → 23514.
#   * the historical floor has notifications.related_id=uuid while the legacy
#     routine inserts p_lead_id::text, which PostgreSQL refuses with 42804. The
#     authenticated production baseline instead has related_id=text; there the
#     same catalog-derived cast control commits, refuting that production risk.
# Either one aborts the branch that actually moves a lead, taking the lead UPDATE,
# the transfer_history row, the business_events row, the notification and the
# idempotency record with it, and the one API that calls the routine reports 400
# INVALID_REQUEST. Neither control can run in MODE=control: the floor carries the
# same narrow domain AND the same cast, so BOTH modes would refuse and the gate
# would measure nothing. So all three directions run here and each control is an
# in-database derivation of what is installed — the constraint renamed aside and
# re-added under the production name with 'transfer' removed by regexp from
# pg_get_constraintdef(), and the cast put back by substituting one literal inside
# pg_get_functiondef() and re-executing it, with the md5 required back afterwards.
# The two controls run FIRST, for the reason every control above does.
#
# 23_ measures the concurrency boundary in both catalog shapes. The historical
# floor has no server-clock stamp, so its control removes the migration's fallback
# and reproduces a client-pinnable token. The authenticated production baseline
# already has trg_set_updated_at with an unconditional server-clock body, so the
# migration is a catalog-proven no-op and removing only the repository fallback
# does not weaken CAS; that direction refutes the earlier production-no-trigger
# claim. Two overlapping transactions are still required to prove stale-token
# refusal after a committed transfer. The control cannot run in MODE=control
# because the migration/fallback is the variable, so it is exercised inside the
# throwaway database and restored from
# pg_get_triggerdef(). EXPECT=forged runs FIRST, same reason.
#
# The ORDER of the two gates matters and is not alphabetical by accident: with
# either write defect in place reassign_lead_atomic() cannot commit a reassignment,
# so a compare-and-set run against it would be measuring a refusal and reporting a
# guard. 23_ asserts both fixes as preconditions and fails closed if either is
# missing, rather than trusting this ordering.
# ---------------------------------------------------------------------------
LEAD_WRITES_GATE="$REPLAY_DIR/22_lead_reassignment_writes.sh"
LEAD_CAS_GATE="$REPLAY_DIR/23_lead_assignment_cas.sh"

# Round-4 R7. The rollback path's own two defects, and the only two things in this
# harness that have to be measured with the companions treated as the artifact
# under test rather than as a step: the money companion's readback (it checked the
# row, not the function the guards call) and the KPI drop in rollback_l0_20260811
# (no period lock, no lock_timeout). Both run BEFORE the rollback section below,
# because both need the release posture — strict, guards enabled — to be what they
# start from, and both are required to leave it exactly as they found it.
COMPANION_GUARD_GATE="$REPLAY_DIR/24_rollback_companion_guards.sh"

# R8. Quote allocation and lead unassignment share one integrity migration, and
# both need behaviour that a single catalog query cannot establish: initialization
# must wait for an in-flight quotation INSERT; overlapping inserts must receive
# distinct database-owned numbers; same-key lead mutations must serialize into a
# replay; CAS failures and caller rollback must leave no audit/request residue.
# The gate re-applies only that migration against this throwaway PG17 database,
# stages fixed synthetic UUIDs and removes every row it creates.
QUOTE_UNASSIGN_GATE="$REPLAY_DIR/25_quote_unassignment_integrity.sh"
NOTIFICATION_EVENT_GATE="$REPLAY_DIR/26_notification_event_idempotency.sh"
LEAD_REBALANCE_PLAN_GATE="$REPLAY_DIR/27_lead_rebalance_plan_idempotency.sh"

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
    recontract_*.sql)
      # The forward twin of a rollback companion, and inert for the same reason:
      # the name does not match ^[0-9]{14}_ so the CLI never applies it. Review
      # round 4 B9 is why these exist — once a numbered migration is recorded,
      # nothing pending can return the database to the state it established, so
      # the way back from a hand-run rollback has to be a hand-run artifact too.
      RECONTRACT_COMPANIONS+=("$name")
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

# ---------------------------------------------------------------------------
# Return coverage: a rollback with no way forward again is a one-way door.
#
# Review round 4 B9. A hand-run rollback companion leaves the database in a state
# the CLI can no longer change: the migration it reverses is RECORDED, so
# `supabase db push` and scripts/db-phase-push.mjs both skip it, and there is
# nothing pending that would restore what the companion undid. Shipping a second
# numbered migration does not fix that — it would be applied and recorded during
# the first deploy and the next attempt would be back in the same dead end — so
# the way forward has to be a hand-run artifact too, declared with
# `-- RECONTRACTS:` in a recontract_*.sql file.
#
# Every migration that a rollback companion reverses therefore needs a recontract
# companion, or the rollback companion must say why not with `-- NO_RECONTRACT:`
# plus a reason. The escape hatch is deliberate and it is on the ROLLBACK file:
# the artifact that creates the one-way door is where the reason for it belongs.
# ---------------------------------------------------------------------------
declare -A RECONTRACT_FOR=()
for companion in "${RECONTRACT_COMPANIONS[@]}"; do
  while read -r covered; do
    [ -n "$covered" ] || continue
    RECONTRACT_FOR["$covered"]="$companion"
  done < <(sed -n 's/^--[[:space:]]*RECONTRACTS:[[:space:]]*\([A-Za-z0-9_.-]\{1,\}\)[[:space:]]*$/\1/p' \
    "$MIGRATIONS_DIR/$companion")
done

no_way_forward=()
BRANCH_RECONTRACTS=()
for name in "${BRANCH_MIGRATIONS[@]}"; do
  [ -n "${ROLLBACK_FOR[$name]+set}" ] || continue   # nothing rolls it back
  if [ -n "${RECONTRACT_FOR[$name]+set}" ]; then
    companion="${RECONTRACT_FOR[$name]}"
    case " ${BRANCH_RECONTRACTS[*]-} " in
      *" $companion "*) ;;
      *) BRANCH_RECONTRACTS+=("$companion") ;;
    esac
  elif grep -qE '^--[[:space:]]*NO_RECONTRACT:[[:space:]]*\S' "$MIGRATIONS_DIR/${ROLLBACK_FOR[$name]}"; then
    printf '  no return path by declaration: %s (via %s)\n' "$name" "${ROLLBACK_FOR[$name]}"
  else
    no_way_forward+=("$name (rolled back by ${ROLLBACK_FOR[$name]})")
  fi
done
if [ "${#no_way_forward[@]}" -gt 0 ]; then
  printf 'no return path: %s\n' "${no_way_forward[@]}" >&2
  fail "${#no_way_forward[@]} rolled-back migration(s) have neither a '-- RECONTRACTS:' companion nor a '-- NO_RECONTRACT: <reason>' declaration on the rollback companion; a rollback the CLI cannot undo is a one-way door"
fi

# Forward application order, the mirror of the rollback ordering above.
if [ "${#BRANCH_RECONTRACTS[@]}" -gt 0 ]; then
  mapfile -t BRANCH_RECONTRACTS < <(printf '%s\n' "${BRANCH_RECONTRACTS[@]}" | LC_ALL=C sort)
fi

echo "== history integrity =="
echo "  applied and unchanged : ${#BASELINE_HASH[@]}"
echo "  last applied stamp    : $highest_applied"
echo "  new on this branch    : ${#BRANCH_MIGRATIONS[@]}"
printf '    %s\n' "${BRANCH_MIGRATIONS[@]}"
echo "  rollback companions   : ${#BRANCH_ROLLBACKS[@]}"
printf '    %s\n' "${BRANCH_ROLLBACKS[@]}"
echo "  recontract companions : ${#BRANCH_RECONTRACTS[@]}"
if [ "${#BRANCH_RECONTRACTS[@]}" -gt 0 ]; then
  printf '    %s\n' "${BRANCH_RECONTRACTS[@]}"
fi

# ---------------------------------------------------------------------------
# Companion content, Round-4 review C4-5.
#
# Everything above is about which companion covers which migration. Nothing above
# — and until C4-5 nothing anywhere — said anything about what a companion
# contains. These files are executed by hand against production, are never
# recorded in supabase_migrations.schema_migrations, and are excluded from the
# applied-history baseline by design, so the remote-history fingerprint gate
# structurally cannot reach them.
#
# Two further facts, measured on PG 17.10 rather than assumed:
#   * `grant select on public.contracts to anon` and `grant execute on function
#     public.create_contract(jsonb) to authenticated`, appended to
#     rollback_money_direct_write_contract_phase.sql, both left this harness at
#     rc=0 with every post-rollback assertion passing.
#   * BRANCH_ROLLBACKS only selects companions that cover a migration new on this
#     branch, so rollback_crm_v3.sql and rollback_p0_10.sql are executed by no
#     gate at all — an escalation inside them is invisible to every assertion
#     because the file never runs.
#
# So the check is the declared hash of every companion on disk, in every mode,
# before any of them is executed, which is the only form that covers the two
# nothing runs. infra/release/release-manifest.json holds the hashes and
# scripts/check-release-manifest.mjs --verify-companions is the same code the CI
# release-gates job and infra/systemd/newme-deploy.sh run against the candidate
# SHA's own worktree.
# ---------------------------------------------------------------------------
COMPANION_TOTAL=$(( ${#ROLLBACK_COMPANIONS[@]} + ${#RECONTRACT_COMPANIONS[@]} ))
echo "== companion content =="
if [ "$COMPANION_TOTAL" -gt 0 ]; then
  command -v node >/dev/null 2>&1 \
    || fail "node not found on PATH; the companion content binding needs it"
  node "$ROOT/scripts/check-release-manifest.mjs" --verify-companions \
      --migrations-dir "$MIGRATIONS_DIR" \
    || fail "$COMPANION_TOTAL hand-run companion(s) on disk do not match the release manifest"
else
  echo "  no hand-run companions in this tree"
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
# MODE=history — captured production baseline plus exact pending manifest
# ===========================================================================
HISTORY_BASELINE_ACTIVE=0
if [ "$MODE" = history ]; then
  command -v node >/dev/null 2>&1 \
    || fail "node not found on PATH; MODE=history needs the baseline integrity verifier"
  [ -f "$HISTORY_BASELINE_CHECK" ] || fail "missing $HISTORY_BASELINE_CHECK"
  [ -f "$HISTORY_BASELINE_SQL" ] || fail "missing $HISTORY_BASELINE_SQL"

  manifest_output="$(node "$HISTORY_BASELINE_CHECK" --print-forward)" \
    || fail "production schema baseline or exact pending manifest did not verify"
  mapfile -t manifest_forward <<<"$manifest_output"
  [ "${#manifest_forward[@]}" -gt 0 ] || fail "verified history baseline has no pending migrations"
  [ "${#manifest_forward[@]}" = "${#BRANCH_MIGRATIONS[@]}" ] \
    || fail "verified manifest has ${#manifest_forward[@]} pending migrations but history derivation has ${#BRANCH_MIGRATIONS[@]}"
  for i in "${!manifest_forward[@]}"; do
    [ "${manifest_forward[$i]}" = "${BRANCH_MIGRATIONS[$i]}" ] \
      || fail "pending migration order differs between exact manifest and history derivation at item $((i + 1))"
  done

  echo "== production schema baseline =="
  "${PSQL_TX[@]}" -f "$HISTORY_BASELINE_SQL" >/dev/null \
    || fail "production schema baseline did not apply transactionally to empty PG17"

  expected_inventory="$(node "$HISTORY_BASELINE_CHECK" --print-inventory)" \
    || fail "baseline inventory metadata did not verify"
  actual_inventory="$("${PSQL[@]}" -c "select concat_ws('|',
    (select count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')),
    (select count(*) from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid=a.attrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped),
    (select count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('v','m')),
    (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public'),
    (select count(*) from pg_catalog.pg_constraint co join pg_catalog.pg_class c on c.oid=co.conrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and co.conparentid=0),
    (select count(*) from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid=i.indrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not exists(select 1 from pg_catalog.pg_constraint co where co.conindid=i.indexrelid)),
    (select count(*) from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid=t.tgrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal),
    (select count(*) from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid=p.polrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public'))")"
  [ "$actual_inventory" = "$expected_inventory" ] \
    || fail "applied baseline inventory differs from captured metadata"

  "${PSQL[@]}" >/dev/null <<'SQL'
do $baseline_zero_rows$
declare
  relation record;
  row_total bigint;
begin
  for relation in
    select format('%I.%I', n.nspname, c.relname) as qualified_name
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
    order by c.relname
  loop
    execute format('select count(*) from %s', relation.qualified_name) into row_total;
    if row_total <> 0 then
      raise exception 'schema baseline contains application rows in %', relation.qualified_name;
    end if;
  end loop;
end
$baseline_zero_rows$;
SQL
  HISTORY_BASELINE_ACTIVE=1
  echo "== history baseline verified: 0 application rows; ${#manifest_forward[@]} exact pending migrations =="
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

  # ON_ERROR_STOP is deliberately OFF here, and the assertion file is switched into
  # collect mode: against the un-remediated floor a failed assertion is the
  # EXPECTED result, so pg_temp.assert() records it and returns instead of raising,
  # and pg_temp.absorb() does the same for a measurement the floor cannot even
  # take. Without that, one early failure abandoned the rest of its DO block and
  # took every assertion below it out of the accounting — round-3 P1-12.
  #
  # The switch is set on the database, not through PGOPTIONS, so it survives
  # whatever wrapper psql is invoked through and applies to exactly one throwaway
  # database. MODE=branch never sets it, so the gate still raises on the first
  # broken invariant.
  "${PSQL[@]}" -c "alter database \"$PGDATABASE\" set replay.collect = 'on'" >/dev/null \
    || fail "could not switch $PGDATABASE into assertion collect mode"

  echo "== assertions against the un-remediated floor (collect mode) =="
  assertion_file="$REPLAY_DIR/10_assert_release_contracts.sql"
  control_log="$(mktemp)"
  # shellcheck disable=SC2064
  trap "rm -f '$control_log'" EXIT
  psql --no-psqlrc --quiet -f "$assertion_file" > "$control_log" 2>&1 || true

  # -----------------------------------------------------------------------
  # Exact marker accounting. Every check the previous version made is subsumed,
  # and the ones it was missing — one marker per assertion, no duplicates, no
  # unclassified SQL errors, verdicts matched in both directions — are the point.
  #
  # It lives in a separate module because the accounting logic is what was wrong
  # last time, and shell is not testable: tests/release/control-marker-accounting.test.mjs
  # mutation-tests it with dropped markers, duplicated markers, injected SQL
  # errors, renamed assertions and a tampered ledger, and requires each of those
  # to be rejected.
  # -----------------------------------------------------------------------
  [ -f "$CONTROL_EXPECTATIONS" ] || fail "missing $CONTROL_EXPECTATIONS"
  [ -f "$CONTROL_ACCOUNTING" ] || fail "missing $CONTROL_ACCOUNTING"
  command -v node >/dev/null 2>&1 || fail "node not found on PATH; the control accounting needs it"

  if ! node "$CONTROL_ACCOUNTING" \
      --assertions "$assertion_file" \
      --expectations "$CONTROL_EXPECTATIONS" \
      --log "$control_log"; then
    echo "--- control run log ---" >&2
    cat "$control_log" >&2
    fail "the negative control did not account for every assertion"
  fi

  # The second half of the negative control, and the only one that needs two
  # sessions: without allocate_payment()'s row locks the floor must actually lose
  # an update. If it does not, the branch-mode "serialized" result is not evidence
  # of anything the floor did not already do.
  echo "== two-session concurrency against the un-remediated floor =="
  [ -f "$CONCURRENCY_GATE" ] || fail "missing $CONCURRENCY_GATE"
  EXPECT=lost bash "$CONCURRENCY_GATE" \
    || fail "the un-remediated floor did not reproduce the lost update recorded as P1-7"

  # And the same for the request key: on the floor there is no index to block on,
  # so the second submission of one request commits while the first is still open
  # and the contract ends up with the payment twice. If that ever stops happening,
  # the branch-mode "unique" result stops being evidence.
  echo "== two-session request-key idempotency against the un-remediated floor =="
  [ -f "$REQUEST_KEY_GATE" ] || fail "missing $REQUEST_KEY_GATE"
  EXPECT=duplicate bash "$REQUEST_KEY_GATE" \
    || fail "the un-remediated floor did not reproduce the duplicated payment request recorded as B3"

  echo "== control OK =="
  exit 0
fi

# ===========================================================================
# MODE=branch — the gate
# ===========================================================================
echo "== schema floor =="
if [ "$HISTORY_BASELINE_ACTIVE" = 1 ]; then
  echo "  captured production baseline already applied"
else
  [ -f "$REPLAY_DIR/01_floor_schema.sql" ] || fail "missing schema floor"
  "${PSQL[@]}" -f "$REPLAY_DIR/01_floor_schema.sql" >/dev/null \
    || fail "01_floor_schema.sql did not apply to an empty database"
fi

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
# The two-session gate. It runs here, after the single-session assertions and
# before the rollback, because it is the only check in this harness that needs
# the migrations applied AND two concurrent transactions: allocate_payment()'s
# lost update (P1-7) is invisible to any test that runs in one session. It stages
# its own rows on the fixture contract and removes them again, so what follows
# sees the state the fixtures left.
# ---------------------------------------------------------------------------
echo "== two-session concurrency (allocate_payment) =="
[ -f "$CONCURRENCY_GATE" ] || fail "missing $CONCURRENCY_GATE"
EXPECT=consistent bash "$CONCURRENCY_GATE" \
  || fail "concurrent allocations to one installment plan are not serialized"

echo "== two-session request-key idempotency (payments) =="
[ -f "$REQUEST_KEY_GATE" ] || fail "missing $REQUEST_KEY_GATE"
EXPECT=unique bash "$REQUEST_KEY_GATE" \
  || fail "two concurrent submissions of one payment request are not collapsed to one payment"

# The mode flip, both directions. See MODE_FLIP_GATE above for why the control
# runs here instead of in MODE=control, and why it runs first. Both leave the
# release mode as they found it, so the rollback companions below still see the
# strict posture the contract phase established.
echo "== two-session mode flip: control, the flip without the lock =="
[ -f "$MODE_FLIP_GATE" ] || fail "missing $MODE_FLIP_GATE"
EXPECT=torn bash "$MODE_FLIP_GATE" \
  || fail "removing the shared lock from money_direct_write_is_blocked() did not reproduce the flip committing 'strict' over an in-flight compat write, so the serialized result below is not evidence of anything"

echo "== two-session mode flip (contract phase vs in-flight compat write) =="
EXPECT=serialized bash "$MODE_FLIP_GATE" \
  || fail "the contract phase is not serialized against the direct money writes it is supposed to end"

echo "== two-session mode setter: control, the granted route without the lock =="
[ -f "$MODE_SETTER_GATE" ] || fail "missing $MODE_SETTER_GATE"
EXPECT=torn bash "$MODE_SETTER_GATE" \
  || fail "removing the lock from money_set_direct_write_mode() did not reproduce a posture change over an in-flight compat write, so the serialized result below is not evidence of anything"

echo "== two-session mode setter (money_set_direct_write_mode vs in-flight compat write) =="
EXPECT=serialized bash "$MODE_SETTER_GATE" \
  || fail "the granted route into the posture is not serialized against the direct money writes it ends"

# The KPI period lock, both directions. See KPI_PERIOD_GATE above for why the
# control runs here instead of in MODE=control, and why it runs first. It stages
# its own target row and payment in a period no fixture uses and removes them
# again, so what follows sees the state the fixtures left.
echo "== two-session kpi period lock: control, the money routines without the lock =="
[ -f "$KPI_PERIOD_GATE" ] || fail "missing $KPI_PERIOD_GATE"
EXPECT=lost bash "$KPI_PERIOD_GATE" \
  || fail "removing the period lock from confirm_payment()/void_payment() did not reproduce the collection being lost across a target save, so the serialized result below is not evidence of anything"

echo "== two-session kpi period lock (confirm/void vs an in-flight target save) =="
EXPECT=serialized bash "$KPI_PERIOD_GATE" \
  || fail "kpi_targets.actual_amount is written outside the period lock that replace_kpi_targets() holds"

# The cash predicate, both postures. See PREDICATE_GATE above for why the
# compatibility window is the control and why it runs first.
echo "== cash predicate: the compatibility window admits the contradictory row =="
[ -f "$PREDICATE_GATE" ] || fail "missing $PREDICATE_GATE"
EXPECT=compat bash "$PREDICATE_GATE" \
  || fail "the compatibility window did not reproduce a payment that is confirmed and voided at once, so the strict result below is not evidence of anything"

echo "== cash predicate (direct re-confirmation of a reversed payment under the strict posture) =="
EXPECT=strict bash "$PREDICATE_GATE" \
  || fail "the strict posture does not refuse the direct re-confirmation that makes a reversed payment count as cash"

# The two writes reassign_lead_atomic() could not make, three directions. Both
# controls are reproductions and both run first: if the release's domain or the
# release's routine is not installed, or if either derivation did not go back, the
# fixed run immediately after them goes red rather than the rest of the harness
# measuring a mutated constraint or a mutated routine body.
echo "== lead reassignment writes: control, the activities domain that refuses 'transfer' =="
[ -f "$LEAD_WRITES_GATE" ] || fail "missing $LEAD_WRITES_GATE"
EXPECT=narrow bash "$LEAD_WRITES_GATE" \
  || fail "putting activities_type_check back the way production has it did not reproduce reassign_lead_atomic() failing with 23514 and rolling back its own audit rows, so the fixed result below is not evidence of anything"

related_id_type="$("${PSQL[@]}" -c "select data_type from information_schema.columns
  where table_schema = 'public' and table_name = 'notifications' and column_name = 'related_id'" | tr -d '[:space:]')"
case "$related_id_type" in
  uuid)
    echo "== lead reassignment writes: control, text cast refused by uuid notifications.related_id =="
    EXPECT=related_text bash "$LEAD_WRITES_GATE" \
      || fail "putting the ::text cast back into reassign_lead_atomic() did not reproduce 42804 on the uuid notifications.related_id target"
    ;;
  text)
    echo "== lead reassignment writes: production refutation, text cast accepted by text notifications.related_id =="
    EXPECT=related_text_compatible bash "$LEAD_WRITES_GATE" \
      || fail "the captured production text notifications.related_id target did not accept the catalog-derived ::text control, so the production refutation is not established"
    ;;
  *)
    fail "notifications.related_id has unsupported data_type '$related_id_type'; expected uuid or text"
    ;;
esac

echo "== lead reassignment writes (reassign_lead_atomic writes all five of its rows) =="
EXPECT=fixed bash "$LEAD_WRITES_GATE" \
  || fail "reassign_lead_atomic() still cannot write one of the rows it inserts, so no reassignment it performs can commit"

# The lead compare-and-set, both directions. Runs after the domain gate for the
# reason given at LEAD_CAS_GATE above — it needs a reassignment that can commit —
# and the control runs first for the reason every control here does.
[ -f "$LEAD_CAS_GATE" ] || fail "missing $LEAD_CAS_GATE"
other_stamp_triggers="$("${PSQL[@]}" -c "select count(*) from pg_catalog.pg_trigger t
  join pg_catalog.pg_proc p on p.oid = t.tgfoid
  where t.tgrelid = 'public.leads'::regclass
    and not t.tgisinternal and t.tgname <> 'zz_leads_stamp_updated_at' and t.tgenabled = 'O'
    and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2 and (t.tgtype & 16) = 16
    and t.tgattr::text = '' and t.tgqual is null and not p.prosecdef
    and pg_catalog.regexp_replace(p.prosrc, '[[:space:]]+', '', 'g')
          ~* '^beginnew[.]updated_at(:=|=)(pg_catalog[.])?now[(][)];returnnew;end;?$'" | tr -d '[:space:]')"
if [ "$other_stamp_triggers" = "0" ]; then
  echo "== lead assignment compare-and-set: control, updated_at not server-owned =="
  EXPECT=forged bash "$LEAD_CAS_GATE" \
    || fail "dropping zz_leads_stamp_updated_at did not reproduce a client-pinnable token and a reassignment committing over a concurrent transfer"
else
  echo "== lead assignment compare-and-set: production refutation, pre-existing stamp remains after release trigger removal =="
  EXPECT=baseline_guarded bash "$LEAD_CAS_GATE" \
    || fail "the captured production schema's pre-existing updated_at stamp did not preserve the CAS boundary after zz_leads_stamp_updated_at was removed"
fi

echo "== lead assignment compare-and-set (reassign_lead_atomic vs a concurrent direct transfer) =="
EXPECT=guarded bash "$LEAD_CAS_GATE" \
  || fail "leads.updated_at is not server-owned, so reassign_lead_atomic()'s compare-and-set does not refuse a reassignment whose token was invalidated by a concurrent committed transfer"

echo "== quote allocation and atomic lead unassignment (lock, poison, concurrency, CAS, replay, rollback, re-entry) =="
[ -f "$QUOTE_UNASSIGN_GATE" ] || fail "missing $QUOTE_UNASSIGN_GATE"
EXPECT=fixed bash "$QUOTE_UNASSIGN_GATE" \
  || fail "quote allocation or lead unassignment failed its PG17 behaviour contract"

echo "== notification event idempotency (concurrent same-key insert, binding, rollback, re-entry, ACL) =="
[ -f "$NOTIFICATION_EVENT_GATE" ] || fail "missing $NOTIFICATION_EVENT_GATE"
EXPECT=fixed bash "$NOTIFICATION_EVENT_GATE" \
  || fail "notification event idempotency failed its PG17 behaviour contract"

echo "== lead rebalance plan idempotency (concurrent winner, rollback, empty replay, ACL) =="
[ -f "$LEAD_REBALANCE_PLAN_GATE" ] || fail "missing $LEAD_REBALANCE_PLAN_GATE"
EXPECT=fixed bash "$LEAD_REBALANCE_PLAN_GATE" \
  || fail "lead rebalance plan idempotency failed its PG17 behaviour contract"

# The rollback path, measured before it is used. Each direction restores what it
# mutated, so the rollback section below still runs against the release posture.
echo "== rollback companion guards (the money companion's readback and promised-closed set) =="
[ -f "$COMPANION_GUARD_GATE" ] || fail "missing $COMPANION_GUARD_GATE"
MIGRATIONS_DIR="$MIGRATIONS_DIR" EXPECT=companion_guards bash "$COMPANION_GUARD_GATE" \
  || fail "the money rollback companion does not verify what it claims: it either accepted a mode function the guards would disagree with, or returned to 'compat' on a database the previous release never ran under, or did not record the posture change"

echo "== rollback KPI drop (period lock and lock_timeout around dropping the save path) =="
MIGRATIONS_DIR="$MIGRATIONS_DIR" EXPECT=kpi_drop bash "$COMPANION_GUARD_GATE" \
  || fail "rollback_l0_20260811.sql drops public.replace_kpi_targets() without ordering itself against an in-flight KPI write, or without a bound on how long it will block while holding the rollback's DDL locks"

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

# ---------------------------------------------------------------------------
# Forward again, and the state THAT leaves behind.
#
# Review round 4 B9: the rollback was verified and the way back was not, so the
# release had a measured exit and an unmeasured return. This runs the recontract
# companions on top of the rolled-back schema and asserts the strict posture is
# genuinely re-established — at the behaviour level, because after a round trip
# `direct_write_mode = 'strict'` is a claim and a refused write is evidence.
#
# Each companion is applied TWICE. An operator re-running a hand-run file, or
# re-running it because they cannot tell whether the first run committed, must not
# be punished for it; and idempotence is what makes it usable on the second and
# third redeploy attempt rather than only the first.
# ---------------------------------------------------------------------------
if [ "${#BRANCH_RECONTRACTS[@]}" -gt 0 ]; then
  echo "== recontract companions =="
  for companion in "${BRANCH_RECONTRACTS[@]}"; do
    [ -f "$MIGRATIONS_DIR/$companion" ] || fail "missing $companion"
    for attempt in 1 2; do
      "${PSQL_TX[@]}" -f "$MIGRATIONS_DIR/$companion" >/dev/null \
        || fail "$companion does not apply on top of the rolled-back schema (attempt $attempt)"
    done
    printf '  applied %s twice\n' "$companion"
  done

  echo "== post-recontract posture =="
  POST_RECONTRACT_ASSERTS="$REPLAY_DIR/30_assert_post_recontract.sql"
  [ -f "$POST_RECONTRACT_ASSERTS" ] || fail "missing post-recontract assertions"
  recontract_expected="$(sed -n 's/^-- ASSERT_TOTAL: \([0-9]\{1,\}\)$/\1/p' "$POST_RECONTRACT_ASSERTS" | head -1)"
  [ -n "${recontract_expected:-}" ] && [ "$recontract_expected" -gt 0 ] \
    || fail "post-recontract assertion file does not declare ASSERT_TOTAL"

  recontract_output="$(psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 -f "$POST_RECONTRACT_ASSERTS" 2>&1)" || {
    printf '%s\n' "$recontract_output" >&2
    fail "the re-contract did not restore the strict posture (post-recontract assertions raised)"
  }
  printf '%s\n' "$recontract_output"
  recontract_observed="$(printf '%s\n' "$recontract_output" | grep -c 'ASSERT_OK ' || true)"
  [ "$recontract_observed" = "$recontract_expected" ] \
    || fail "expected $recontract_expected post-recontract assertions, saw $recontract_observed"
else
  recontract_observed=0
fi

echo "== replay OK: ${#BRANCH_MIGRATIONS[@]} migrations, $observed release assertions, ${#BRANCH_ROLLBACKS[@]} rollback companion(s), $post_observed post-rollback assertions, ${#BRANCH_RECONTRACTS[@]} recontract companion(s), $recontract_observed post-recontract assertions =="
