#!/usr/bin/env bash
# ============================================================================
# reassign_lead_atomic() cannot write two of the five rows it writes (R6)
# ============================================================================
# 20260723140000_atomic_lead_reassignment.sql moves a lead and writes five rows in
# one SECURITY DEFINER transaction: the leads UPDATE, transfer_history, activities,
# business_events, notifications, plus its own lead_mutation_requests record. Two of
# those statements are refused by the very schema they write into.
#
#   activities (20260723140000:165-169) inserts type = 'transfer'.
#   activities_type_check, as 20260605000000:209-214 last left it, accepts sixteen
#   values and 'transfer' is not one of them → check_violation, SQLSTATE 23514.
#
#   notifications (20260723140000:177-181) inserts related_id = p_lead_id::text.
#   The historical floor has related_id=uuid and reproduces SQLSTATE 42804. The
#   authenticated production capture has related_id=text; the same cast commits,
#   so that production finding is REFUTED rather than projected from the floor.
#
# Either one aborts the whole routine, so nothing is written and nothing is recorded
# as having failed; src/app/api/leads/[id]/assignment/route.ts matches the message
# against UNAUTHORIZED / FORBIDDEN / NOT_FOUND / CONCURRENT and reports 400
# INVALID_REQUEST for a request that was entirely valid.
#
# The two hid each other, and both hid behind the routine's early returns. With the
# narrow domain installed every call ends at 23514 and never reaches the
# notifications INSERT; and a call that hands a lead to whoever already owns it
# (`unchanged: true`, 20260723140000:144-149) or that replays a key
# (:120-127) returns 200 without reaching either statement. Only a reassignment
# that actually moves a lead fails, which is why this gate moves one.
#
# Source code cannot settle any of it. Whether a CHECK refuses a value and whether
# an assignment cast exists are facts about a database; whether either loss takes
# the other four rows with it is a fact about transaction boundaries. All of it is
# measured here, catalog-selected directions, each control derived from what is installed
# rather than typed out by hand:
#
#   EXPECT=narrow        activities_type_check put back the way production has it:
#                        the constraint is RENAMED aside (so the original object is
#                        never destroyed and the restore is exact by construction)
#                        and a constraint carrying the same definition with
#                        'transfer' removed is added under the production name.
#                        The call is refused 23514 naming activities_type_check.
#   EXPECT=related_text  the widened domain LEFT IN PLACE — so the refusal cannot be
#                        blamed on the other defect — and the `::text` cast put back
#                        into the installed routine by substituting one literal
#                        inside pg_get_functiondef(). The call is refused 42804
#                        naming related_id.
#   EXPECT=related_text_compatible
#                        the captured production text target with the same
#                        catalog-derived cast. The call commits all five rows,
#                        proving the uuid/text defect does not exist on production.
#   EXPECT=fixed         20260817190000_lead_reassignment_activity_type.sql and
#                        20260817200000_lead_reassignment_notification_related_id.sql
#                        both applied. The same call reports "unchanged": false, the
#                        lead has moved, each of the five tables has gained exactly
#                        one row, and the notification carries related_id = the
#                        lead's id in the installed uuid or text column.
#
# Every direction also measures:
#
#   read after write   every count comes from a fresh connection as the harness
#                      role, so what is asserted is committed state and not the
#                      calling session's snapshot.
#   reentry            the call is repeated with the SAME idempotency key. A control
#                      direction must fail identically and still have written
#                      nothing — a refusal that accumulates state on retry is worse
#                      than the refusal. The fixed direction must return
#                      idempotent_replay = true, must NOT move the lead a second
#                      time, and must leave exactly one row in each of the five
#                      tables.
#   interruption       a third call, under a NEW key, inside a transaction that is
#                      rolled back. Fixed: the move and its transfer_history row are
#                      visible inside the transaction and gone afterwards, and the
#                      probe REFUSES TO RUN unless the lead has already moved, so it
#                      cannot pass by silently taking the `unchanged` branch. A
#                      control direction's refusal IS the interruption, and the
#                      zero-row assertion after it is the proof, because psql leaves
#                      on the error and the server rolls the transaction back.
#
# Concurrency is not a dimension of either defect — a value either is or is not in a
# CHECK domain, and a cast either exists or does not, and no interleaving changes
# that. The concurrency dimension of the same routine is measured by
# supabase/replay/23_lead_assignment_cas.sh, which depends on BOTH fixes here: with
# either defect installed the routine cannot reach a committed reassignment at all,
# so a compare-and-set gate run against it would be measuring a refusal and calling
# it a guard.
#
# Footprint: one lead (a6a6…) created by this gate, never a fixture, plus whatever
# rows the routine writes about it. Removed at the end, the removal is verified, and
# the assigned_to of all fixture leads is required back byte-identical. The
# constraint is required back byte-identical to the definition found on entry,
# including convalidated, and the routine is required back at the same
# md5(pg_get_functiondef()) it arrived with.
#
# Requires: psql on PATH, PG* pointing at the throwaway replay database. Invoked by
# scripts/replay-migrations.sh. EXPECT is mandatory and has no default, because
# defaulting it is how a control run silently asserts the other branch's claim.
# ============================================================================
set -euo pipefail

: "${EXPECT:?EXPECT must be 'narrow' (activities_type_check refuses the routine), 'related_text' (a uuid target refuses the cast), 'related_text_compatible' (the production text target accepts the cast) or 'fixed' (the release lets it through)}"
case "$EXPECT" in
  narrow|related_text|related_text_compatible|fixed) ;;
  *) echo "lead reassignment writes gate: EXPECT must be 'narrow', 'related_text', 'related_text_compatible' or 'fixed', got '$EXPECT'" >&2; exit 1 ;;
esac

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=postgres}"
export PGHOST PGPORT PGUSER PGDATABASE

# Fixed values, no random(): the assertions and the cleanup name their rows.
LEAD='a6a6a6a6-a6a6-a6a6-a6a6-a6a6a6a6a6a6'        # created here; no fixture uses it
OWNER='cccccccc-cccc-cccc-cccc-cccccccccccc'       # replay-sales1, role 'sales', active
TARGET='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'      # replay-sales2, role 'sales', active
ADMIN='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'       # replay-admin, role 'admin', active
KEY_1='a6a6a6a6-0001-4000-8000-0000000000a6'       # the call and its replay
KEY_2='a6a6a6a6-0002-4000-8000-0000000000a6'       # the interrupted call
SAVED='activities_type_check_r22_saved'            # where the real constraint waits
CUSTOMER='Replay lead R6 writes'
ROUTINE='public.reassign_lead_atomic(uuid, uuid, timestamptz, uuid, text)'

work_dir="$(mktemp -d)"
restore_needed=0
routine_restore_needed=0

fail() {
  echo "lead reassignment writes gate failed: $*" >&2
  exit 1
}

# One scalar, as the harness role, from a connection of its own.
q() {
  psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 -c "$1" | tr -d '[:space:]'
}

# Same, but keeping the spaces: constraint definitions are compared byte for byte.
q_raw() {
  psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 -c "$1" | tr -d '\r' | head -1
}

run_sql() {
  local what="$1" sql="$2"
  printf '%s\n' "$sql" >"$work_dir/run.sql"
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction \
    -f "$work_dir/run.sql" >"$work_dir/run.log" 2>&1 \
    || { cat "$work_dir/run.log" >&2; fail "$what"; }
}

# The controls have to be undone even when the gate fails, or a failing run would
# leave the replay database carrying a domain or a routine production does not have
# and every later assertion would be measuring this gate's scaffolding.
restore_domain() {
  [ "$restore_needed" = "1" ] || return 0
  restore_needed=0
  printf '%s\n' "
    alter table public.activities drop constraint if exists activities_type_check;
    alter table public.activities rename constraint $SAVED to activities_type_check;
  " >"$work_dir/restore-domain.sql"
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction \
    -f "$work_dir/restore-domain.sql" >"$work_dir/restore-domain.log" 2>&1 \
    || { cat "$work_dir/restore-domain.log" >&2; echo "lead reassignment writes gate: COULD NOT RESTORE activities_type_check" >&2; }
}

# The inverse substitution. Exactness is not taken on faith: the md5 of
# pg_get_functiondef() is compared against the one captured on entry, below.
restore_routine() {
  [ "$routine_restore_needed" = "1" ] || return 0
  routine_restore_needed=0
  printf '%s\n' "
    do \$do\$
    declare
      v_oid oid;
      v_def text;
      v_new text;
      v_n   int;
    begin
      v_oid := to_regprocedure('$ROUTINE');
      v_def := pg_catalog.pg_get_functiondef(v_oid);
      v_n := (length(v_def) - length(replace(v_def, 'p_lead_id::text, ''lead''', '')))
             / length('p_lead_id::text, ''lead''');
      if v_n <> 1 then
        raise exception 'the control routine carries % occurrences of the cast, not 1', v_n;
      end if;
      v_new := replace(v_def, 'p_lead_id::text, ''lead''', 'p_lead_id, ''lead''');
      execute v_new;
    end
    \$do\$;
  " >"$work_dir/restore-routine.sql"
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction \
    -f "$work_dir/restore-routine.sql" >"$work_dir/restore-routine.log" 2>&1 \
    || { cat "$work_dir/restore-routine.log" >&2; echo "lead reassignment writes gate: COULD NOT RESTORE $ROUTINE" >&2; }
}

cleanup() {
  local status=$?
  restore_domain
  restore_routine
  rm -rf "$work_dir"
  return $status
}
trap cleanup EXIT

command -v psql >/dev/null 2>&1 || fail "psql not found on PATH"

# ---------------------------------------------------------------------------
# An attempt whose outcome is a value rather than an exit status. The idiom is
# 21_payment_predicate_divergence.sh's: VERBOSITY verbose so the SQLSTATE is in the
# log, ON_ERROR_STOP=1 so a refused statement ends the session before its COMMIT is
# read, and the ERROR line parsed out.
#
# `set local role authenticated` and the GoTrue claim shape, because this is how the
# application reaches the routine: 20260723140000:199 grants EXECUTE to
# authenticated only, the routine resolves its actor from auth.uid(), and
# 20260816000000 injects assert_current_session_at_entry() into its body, which
# reads the session too.
# ---------------------------------------------------------------------------
call_rpc() {
  local who="$1" key="$2" expected_updated_at="$3" log="$work_dir/attempt.log"
  local arg
  if [ "$expected_updated_at" = "null" ]; then arg='null'; else arg="'$expected_updated_at'::timestamptz"; fi
  {
    echo '\set VERBOSITY verbose'
    echo "set application_name = 'replay_lead_writes';"
    echo 'begin;'
    echo "select set_config('request.jwt.claims',
                            json_build_object('sub', '$who', 'role', 'authenticated',
                                              'iat', floor(extract(epoch from now()))::bigint)::text,
                            true);"
    echo 'set local role authenticated;'
    echo "select public.reassign_lead_atomic('$LEAD', '$TARGET', $arg, '$key',
                                             'replay 22: lead reassignment writes gate');"
    echo 'commit;'
  } >"$work_dir/attempt.sql"

  : >"$log"
  psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 \
    -f "$work_dir/attempt.sql" >"$log" 2>&1 || true

  local err
  err="$(sed -n 's/.*ERROR:  \([0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z]\): \(.*\)$/err|\1|\2/p' "$log" | head -1)"
  if [ -n "$err" ]; then
    printf '%s\n' "$err"
  else
    printf 'ok|%s\n' "$(tr -d '\r' <"$log" | tr '\n' ' ')"
  fi
}

expect_refusal() {
  local got="$1" state="$2" needle="$3" what="$4"
  case "$got" in
    "err|$state|"*) ;;
    *) fail "$what: expected SQLSTATE $state, got '$got'" ;;
  esac
  case "$got" in
    *"$needle"*) ;;
    *) fail "$what: refused with $state but not for the stated reason — expected a message containing '$needle', got '$got'" ;;
  esac
}

# ---------------------------------------------------------------------------
# What the routine writes, counted. Five tables, one number each, all scoped to
# this gate's lead so no fixture's rows are in any of them.
# ---------------------------------------------------------------------------
n_transfer_history() { q "select count(*) from public.transfer_history where lead_id = '$LEAD'"; }
n_activities()       { q "select count(*) from public.activities where lead_id = '$LEAD' and type = 'transfer'"; }
n_business_events()  { q "select count(*) from public.business_events where lead_id = '$LEAD' and event_type = 'transfer'"; }
n_notifications()    { q "select count(*) from public.notifications where related_id = '$LEAD' and type = 'lead_assigned'"; }
n_requests()         { q "select count(*) from public.lead_mutation_requests where lead_id = '$LEAD'"; }
owner_of()           { q "select coalesce(assigned_to::text, '<null>') from public.leads where id = '$LEAD'"; }

all_counts() {
  printf '%s/%s/%s/%s/%s' "$(n_transfer_history)" "$(n_activities)" \
    "$(n_business_events)" "$(n_notifications)" "$(n_requests)"
}

expect_counts() {
  local want="$1" what="$2" got
  got="$(all_counts)"
  [ "$got" = "$want" ] \
    || fail "$what: transfer_history/activities/business_events/notifications/requests is $got, expected $want"
}

routine_def_md5() {
  q "select md5(pg_catalog.pg_get_functiondef(to_regprocedure('$ROUTINE')))"
}

# ISO 8601 without spaces, preserving all six timestamp fractional digits while
# q() removes whitespace from scalar output.
token_of() {
  q "select to_char(updated_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.USOF') from public.leads where id = '$LEAD'"
}

# ---------------------------------------------------------------------------
# Preconditions, asserted rather than assumed.
# ---------------------------------------------------------------------------
[ "$(q "select count(*) from pg_proc where oid = to_regprocedure('$ROUTINE')")" = "1" ] \
  || fail "$ROUTINE is not present in this database"
for t in transfer_history notifications activities business_events lead_mutation_requests leads; do
  [ "$(q "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relname = '$t' and c.relkind = 'r'")" = "1" ] \
    || fail "public.$t is not present in this database, so the routine cannot be measured"
done
# The historical floor has uuid here; the authenticated production baseline has
# text.  The cast mismatch is reproducible only on the former.  On the latter the
# same catalog-derived cast is a positive refutation and must commit, while the
# fixed direction remains required on both shapes.
RELATED_ID_TYPE="$(q "select data_type from information_schema.columns
          where table_schema = 'public' and table_name = 'notifications' and column_name = 'related_id'")"
case "$RELATED_ID_TYPE" in
  uuid|text) ;;
  *) fail "public.notifications.related_id has unsupported data_type '$RELATED_ID_TYPE'; expected uuid (historical floor) or text (captured production)" ;;
esac
if [ "$EXPECT" = related_text ] && [ "$RELATED_ID_TYPE" != uuid ]; then
  fail "EXPECT=related_text requires notifications.related_id uuid, found $RELATED_ID_TYPE"
fi
if [ "$EXPECT" = related_text_compatible ] && [ "$RELATED_ID_TYPE" != text ]; then
  fail "EXPECT=related_text_compatible requires notifications.related_id text, found $RELATED_ID_TYPE"
fi
[ "$(q "select count(*) from public.profiles where id = '$ADMIN' and role = 'admin' and coalesce(is_active, false)")" = "1" ] \
  || fail "fixture profile $ADMIN is not an active admin, so it cannot pass the routine's role check"
for who in "$OWNER" "$TARGET"; do
  [ "$(q "select count(*) from public.profiles where id = '$who' and role = 'sales' and coalesce(is_active, false)")" = "1" ] \
    || fail "fixture profile $who is not an active salesperson, so the routine would answer INVALID_ASSIGNEE for reasons unrelated to this gate"
done
[ "$(q "select count(*) from public.leads where id = '$LEAD'")" = "0" ] \
  || fail "lead $LEAD already exists; this gate creates and removes it, and will not adopt a row it did not make"
# No pre-existing 'transfer' activity anywhere, or the narrow direction's rename
# would be putting a constraint back over rows that violate it, and the counts
# below would not be attributable to this gate.
[ "$(q "select count(*) from public.activities where type = 'transfer'")" = "0" ] \
  || fail "this database already holds activities rows with type = 'transfer'; the domain measurement below would not be clean"
[ "$(q "select count(*) from pg_constraint where conrelid = 'public.activities'::regclass and conname = '$SAVED'")" = "0" ] \
  || fail "$SAVED already exists on public.activities, which means an earlier run of this gate did not restore the domain"

CONSTRAINT_ON_ENTRY="$(q_raw "select pg_catalog.pg_get_constraintdef(oid) from pg_catalog.pg_constraint
                                where conrelid = 'public.activities'::regclass
                                  and conname = 'activities_type_check' and contype = 'c'")"
[ -n "$CONSTRAINT_ON_ENTRY" ] \
  || fail "activities_type_check is not present on public.activities, so there is no domain to measure"
VALIDATED_ON_ENTRY="$(q "select convalidated::text from pg_catalog.pg_constraint
                           where conrelid = 'public.activities'::regclass and conname = 'activities_type_check'")"
ROUTINE_MD5_ON_ENTRY="$(routine_def_md5)"
[ -n "$ROUTINE_MD5_ON_ENTRY" ] || fail "could not read $ROUTINE out of the catalog"
FIXTURE_OWNERS_ON_ENTRY="$(q "select md5(string_agg(id::text || '=' || coalesce(assigned_to::text, ''), ',' order by id))
                                from public.leads where id <> '$LEAD'")"

# All three directions require the RELEASE state on entry and derive their control
# from it. A run where 'transfer' is already absent has nothing for the narrow
# direction to remove; a run where the cast is still installed has nothing for the
# related_text direction to reinstate, and would make the fixed direction assert a
# fix that is not applied.
case "$CONSTRAINT_ON_ENTRY" in
  *"'transfer'"*) ;;
  *) fail "the installed activities_type_check does not mention 'transfer', so 20260817190000_lead_reassignment_activity_type.sql is not applied to this database and the $EXPECT result below is not evidence of anything. Definition found: $CONSTRAINT_ON_ENTRY" ;;
esac
[ "$VALIDATED_ON_ENTRY" = "true" ] \
  || fail "the installed activities_type_check is NOT VALID, so it was never checked against the rows already in the table"
[ "$(q "select position('p_lead_id::text, ''lead''' in pg_catalog.pg_get_functiondef(to_regprocedure('$ROUTINE')))")" = "0" ] \
  || fail "the installed $ROUTINE still casts the lead id to text for notifications.related_id, so 20260817200000_lead_reassignment_notification_related_id.sql is not applied to this database and the $EXPECT result below is not evidence of anything"
[ "$(q "select position('p_lead_id, ''lead''' in pg_catalog.pg_get_functiondef(to_regprocedure('$ROUTINE')))")" != "0" ] \
  || fail "the installed $ROUTINE does not carry the notifications INSERT this gate measures, so neither its control nor its positive direction means anything"

# ---------------------------------------------------------------------------
# The control under test.
#
# narrow: rename the real constraint aside — the object is not destroyed, so the
# restore is exact by construction rather than by re-typing a definition — and add
# a constraint under the production name whose definition is the installed one with
# 'transfer' removed. Derived in the database, from the catalog, so the control is
# what is installed minus one value and nothing else.
# ---------------------------------------------------------------------------
if [ "$EXPECT" = narrow ]; then
  run_sql "could not install the narrow domain" "
    do \$do\$
    declare
      v_def    text;
      v_narrow text;
    begin
      select pg_catalog.pg_get_constraintdef(oid) into v_def
        from pg_catalog.pg_constraint
       where conrelid = 'public.activities'::regclass
         and conname = 'activities_type_check' and contype = 'c';
      if v_def is null then
        raise exception 'activities_type_check disappeared between the precondition and the control';
      end if;
      v_narrow := regexp_replace(v_def, '[[:space:]]*,[[:space:]]*''transfer''(::text)?', '', 'g');
      if v_narrow = v_def then
        raise exception 'removing ''transfer'' from % changed nothing', v_def;
      end if;
      if position('''transfer''' in v_narrow) > 0 then
        raise exception 'the derived narrow domain still accepts transfer: %', v_narrow;
      end if;
      alter table public.activities rename constraint activities_type_check to $SAVED;
      execute format('alter table public.activities add constraint activities_type_check %s not valid', v_narrow);
    end
    \$do\$;
  "
  restore_needed=1
  [ "$(q "select count(*) from pg_constraint where conrelid = 'public.activities'::regclass and conname = '$SAVED'")" = "1" ] \
    || fail "the real constraint was not renamed aside, so this run has no exact way back"
  narrow_def="$(q_raw "select pg_catalog.pg_get_constraintdef(oid) from pg_catalog.pg_constraint
                         where conrelid = 'public.activities'::regclass and conname = 'activities_type_check'")"
  case "$narrow_def" in
    *"'transfer'"*) fail "the control domain still accepts 'transfer': $narrow_def" ;;
  esac
  case "$narrow_def" in
    *"'stage_change'"*) ;;
    *) fail "the control domain lost values other than 'transfer', so it is not the production domain: $narrow_def" ;;
  esac
  echo "  control installed: activities_type_check is the installed domain with 'transfer' removed, derived from the catalog"
fi

# related_text: substitute one literal inside pg_get_functiondef() of whatever is
# installed and re-execute it. Bounded three ways — the repaired literal must occur
# exactly once, the substitution must LENGTHEN the definition by exactly the 6 bytes
# of `::text`, and the md5 has to come back to ROUTINE_MD5_ON_ENTRY at the end. The
# widened domain is deliberately left in place: with it removed the routine would
# stop at 23514 and this direction would be re-measuring the narrow one.
if [ "$EXPECT" = related_text ] || [ "$EXPECT" = related_text_compatible ]; then
  run_sql "could not reinstate the text cast in $ROUTINE" "
    do \$do\$
    declare
      v_oid oid;
      v_def text;
      v_new text;
      v_n   int;
    begin
      v_oid := to_regprocedure('$ROUTINE');
      if v_oid is null then
        raise exception 'the routine disappeared between the precondition and the control';
      end if;
      v_def := pg_catalog.pg_get_functiondef(v_oid);
      v_n := (length(v_def) - length(replace(v_def, 'p_lead_id, ''lead''', '')))
             / length('p_lead_id, ''lead''');
      if v_n <> 1 then
        raise exception 'the installed routine carries % occurrences of the repaired notifications INSERT, not 1', v_n;
      end if;
      v_new := replace(v_def, 'p_lead_id, ''lead''', 'p_lead_id::text, ''lead''');
      if length(v_new) - length(v_def) <> 6 then
        raise exception 'reinstating the cast changed % bytes, not the 6 of ''::text''', length(v_new) - length(v_def);
      end if;
      execute v_new;
    end
    \$do\$;
  "
  routine_restore_needed=1
  [ "$(q "select position('p_lead_id::text, ''lead''' in pg_catalog.pg_get_functiondef(to_regprocedure('$ROUTINE')))")" != "0" ] \
    || fail "the control substitution reported success but the installed routine does not carry the cast"
  [ "$(routine_def_md5)" != "$ROUTINE_MD5_ON_ENTRY" ] \
    || fail "the control substitution left the routine byte-identical to the release, so there is no control here"
  # The other defect must NOT be co-installed, or a 42804 could not be attributed.
  case "$(q_raw "select pg_catalog.pg_get_constraintdef(oid) from pg_catalog.pg_constraint
                   where conrelid = 'public.activities'::regclass and conname = 'activities_type_check'")" in
    *"'transfer'"*) ;;
    *) fail "the widened domain went missing while installing this control, so a refusal below could be either defect" ;;
  esac
  echo "  catalog-derived cast installed: reassign_lead_atomic() casts the lead id to text, with the widened activities domain left in place (related_id type=$RELATED_ID_TYPE)"
fi

# ---------------------------------------------------------------------------
# Stage the lead. As the harness role, like every other gate's fixtures: the
# routine's own call is where the end-user session matters.
# ---------------------------------------------------------------------------
run_sql "could not stage lead $LEAD" "
  insert into public.leads (id, assigned_to, stage, customer_name, source, transfer_candidate, recovery_candidate)
  values ('$LEAD', '$OWNER', 'new', '$CUSTOMER', 'other', true, true);
"
[ "$(owner_of)" = "$OWNER" ] || fail "the staged lead belongs to $(owner_of), not $OWNER"
expect_counts "0/0/0/0/0" "the staged lead starts with no reassignment rows"
LEAD_UPDATED_AT="$(token_of)"
[ -n "$LEAD_UPDATED_AT" ] || fail "the staged lead has a null updated_at, so the routine's token would be null"

# ===========================================================================
# The call. Twice with the same key — the second is the reentry probe — and once
# more under a new key inside a transaction that is rolled back.
# ===========================================================================
first="$(call_rpc "$ADMIN" "$KEY_1" "$LEAD_UPDATED_AT")"
owner_after_first="$(owner_of)"
counts_after_first="$(all_counts)"

# The CONTENTS of the three rows whose contents matter, read here rather than in the
# verdict, because the verdict runs after this gate has removed its own rows. A
# count that is asserted after the delete is an assertion about the delete.
history_match_after_first="$(q "select count(*) from public.transfer_history
                                  where lead_id = '$LEAD' and from_user_id = '$OWNER'
                                    and to_user_id = '$TARGET' and transferred_by = '$ADMIN'")"
notification_match_after_first="$(q "select count(*) from public.notifications
                                       where related_id = '$LEAD' and related_type = 'lead'
                                         and user_id = '$TARGET' and type = 'lead_assigned'")"
lead_flags_after_first="$(q "select count(*) from public.leads where id = '$LEAD'
                               and coalesce(transfer_candidate, false) = false
                               and coalesce(recovery_candidate, false) = false
                               and hold_since is null")"

second="$(call_rpc "$ADMIN" "$KEY_1" "$LEAD_UPDATED_AT")"
owner_after_second="$(owner_of)"
counts_after_second="$(all_counts)"

echo "  first call: ${first%%|*} → owner=$owner_after_first counts=$counts_after_first"
echo "  replayed key: ${second%%|*} → owner=$owner_after_second counts=$counts_after_second"

# Interruption. In the fixed direction the move commits inside the transaction and
# must be gone after the ROLLBACK; in a control direction the routine raises, so the
# transaction is already doomed and the probe would measure the refusal twice. A
# control direction's interruption evidence is the zero-count assertion after
# `first`, which is only true because the server rolled that transaction back.
if [ "$EXPECT" = fixed ]; then
  # The probe hands the lead BACK to its original owner, so it exercises the write
  # branch rather than the routine's `unchanged` early return — which writes none of
  # the five rows and would let this probe pass without touching what it claims to
  # measure. That only holds if the lead has actually moved, so it is checked here
  # instead of inferred from the direction's name.
  [ "$owner_after_second" = "$TARGET" ] \
    || fail "the interruption probe cannot be staged: the lead belongs to $owner_after_second, not $TARGET, so a call naming $OWNER would take the routine's unchanged branch and write none of the five rows"
  INTERRUPT_UPDATED_AT="$(token_of)"
  [ -n "$INTERRUPT_UPDATED_AT" ] \
    || fail "the moved lead has a null updated_at, so the interruption probe cannot supply the required compare-and-set token"
  {
    echo '\set VERBOSITY verbose'
    echo "set application_name = 'replay_lead_writes_inflight';"
    echo 'begin;'
    echo "select set_config('request.jwt.claims',
                            json_build_object('sub', '$ADMIN', 'role', 'authenticated',
                                              'iat', floor(extract(epoch from now()))::bigint)::text,
                            true);"
    echo 'set local role authenticated;'
    echo "select 'inflight_unchanged=' || coalesce(public.reassign_lead_atomic('$LEAD', '$OWNER', '$INTERRUPT_UPDATED_AT'::timestamptz, '$KEY_2',
                                                     'replay 22: interrupted call') ->> 'unchanged', '<null>');"
    echo "select 'effect_in_tx=' || count(*) from public.leads
                  where id = '$LEAD' and assigned_to = '$OWNER';"
    echo "select 'history_in_tx=' || count(*) from public.transfer_history where lead_id = '$LEAD';"
    echo 'rollback;'
  } >"$work_dir/inflight.sql"
  psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 \
    -f "$work_dir/inflight.sql" >"$work_dir/inflight.log" 2>&1 \
    || { cat "$work_dir/inflight.log" >&2; fail "the interrupted call did not run to completion"; }
  inflight_unchanged="$(sed -n 's/^inflight_unchanged=//p' "$work_dir/inflight.log" | head -1 | tr -d '[:space:]')"
  inflight_effect="$(sed -n 's/^effect_in_tx=//p' "$work_dir/inflight.log" | head -1 | tr -d '[:space:]')"
  inflight_history="$(sed -n 's/^history_in_tx=//p' "$work_dir/inflight.log" | head -1 | tr -d '[:space:]')"
  [ "$inflight_unchanged" = "false" ] \
    || fail "the interrupted call reported unchanged=$inflight_unchanged, so it took the routine's early return instead of the branch that writes the five rows"
  [ "$inflight_effect" = "1" ] \
    || fail "the interrupted call did not move the lead inside its own transaction (effect rows = $inflight_effect)"
  [ "$inflight_history" = "2" ] \
    || fail "the interrupted call left $inflight_history transfer_history rows visible inside its transaction, not the 2 a second real move makes"
  [ "$(owner_of)" = "$owner_after_second" ] \
    || fail "the rolled-back call left the lead at $(owner_of) instead of the $owner_after_second it had before; an interrupted reassignment is not supposed to survive"
  [ "$(all_counts)" = "$counts_after_second" ] \
    || fail "the rolled-back call left rows behind: counts are $(all_counts), were $counts_after_second"
  [ "$(q "select count(*) from public.lead_mutation_requests where idempotency_key = '$KEY_2'")" = "0" ] \
    || fail "the rolled-back call left its idempotency key recorded, so a retry would be answered from a transaction that never happened"
  echo "  interrupted call: the move and its transfer_history row were visible inside the transaction (unchanged=false) and left nothing after the rollback"
fi

# ---------------------------------------------------------------------------
# Cleanup before the verdict, so a FAILING gate still leaves the database in the
# state the fixtures created. transfer_history, lead_mutation_requests and
# notifications have no cascade from leads — the first two reference it without
# ON DELETE, and notifications does not reference it at all — so they go first.
# activities and business_events cascade with the lead.
# ---------------------------------------------------------------------------
run_sql "could not remove this gate's rows" "
  delete from public.transfer_history where lead_id = '$LEAD';
  delete from public.lead_mutation_requests where lead_id = '$LEAD';
  delete from public.notifications where related_id = '$LEAD';
  delete from public.leads where id = '$LEAD';
"
restore_domain
restore_routine

[ "$(q "select count(*) from public.leads where id = '$LEAD'")" = "0" ] \
  || fail "this gate's lead was left behind"
[ "$(q "select count(*) from public.activities where lead_id = '$LEAD'")" = "0" ] \
  || fail "activities rows for this gate's lead were left behind"
[ "$(q "select count(*) from public.business_events where lead_id = '$LEAD'")" = "0" ] \
  || fail "business_events rows for this gate's lead were left behind"
[ "$(q "select count(*) from public.transfer_history where lead_id = '$LEAD'")" = "0" ] \
  || fail "transfer_history rows for this gate's lead were left behind"
[ "$(q "select count(*) from public.notifications where related_id = '$LEAD'")" = "0" ] \
  || fail "notifications rows for this gate's lead were left behind"
[ "$(q "select count(*) from public.lead_mutation_requests where lead_id = '$LEAD'")" = "0" ] \
  || fail "lead_mutation_requests rows for this gate's lead were left behind"
[ "$(q "select count(*) from public.activities where type = 'transfer'")" = "0" ] \
  || fail "this gate left activities rows with type = 'transfer' behind"
[ "$(q "select count(*) from pg_constraint where conrelid = 'public.activities'::regclass and conname = '$SAVED'")" = "0" ] \
  || fail "$SAVED was left on public.activities; the domain was not restored"

constraint_on_exit="$(q_raw "select pg_catalog.pg_get_constraintdef(oid) from pg_catalog.pg_constraint
                               where conrelid = 'public.activities'::regclass
                                 and conname = 'activities_type_check' and contype = 'c'")"
[ "$constraint_on_exit" = "$CONSTRAINT_ON_ENTRY" ] \
  || fail "activities_type_check left this gate as '$constraint_on_exit' instead of the '$CONSTRAINT_ON_ENTRY' it arrived with"
[ "$(q "select convalidated::text from pg_catalog.pg_constraint
          where conrelid = 'public.activities'::regclass and conname = 'activities_type_check'")" = "$VALIDATED_ON_ENTRY" ] \
  || fail "activities_type_check left this gate with a different convalidated than the $VALIDATED_ON_ENTRY it arrived with"
[ "$(routine_def_md5)" = "$ROUTINE_MD5_ON_ENTRY" ] \
  || fail "$ROUTINE left this gate with a different definition than the one it arrived with; the control substitution was not undone exactly"
[ "$(q "select md5(string_agg(id::text || '=' || coalesce(assigned_to::text, ''), ',' order by id))
          from public.leads where id <> '$LEAD'")" = "$FIXTURE_OWNERS_ON_ENTRY" ] \
  || fail "this gate changed which salesperson a fixture lead belongs to"

# ===========================================================================
# The verdict.
# ===========================================================================
refusal_is_clean() {
  local state="$1" needle="$2" what="$3"
  expect_refusal "$first" "$state" "$needle" "$what"
  [ "$owner_after_first" = "$OWNER" ] \
    || fail "the refused reassignment still moved the lead to $owner_after_first"
  [ "$counts_after_first" = "0/0/0/0/0" ] \
    || fail "the refused reassignment wrote $counts_after_first into transfer_history/activities/business_events/notifications/requests; the routine is not atomic"
  expect_refusal "$second" "$state" "$needle" "$what, a second time under the same key"
  [ "$second" = "$first" ] \
    || fail "the second attempt reported '$second' but the first reported '$first'; the refusal is not idempotent"
  [ "$counts_after_second" = "0/0/0/0/0" ] \
    || fail "the second refused attempt accumulated $counts_after_second"
  [ "$owner_after_second" = "$OWNER" ] \
    || fail "the second refused attempt moved the lead to $owner_after_second"
}

case "$EXPECT" in
  narrow)
    refusal_is_clean "23514" "activities_type_check" \
      "reassigning a lead while activities_type_check refuses 'transfer'"
    echo "  REPRODUCED: with the production activities domain installed, reassign_lead_atomic() cannot move a lead at all — 23514 on activities_type_check, twice identically, and the lead, the transfer history, the activity, the business event, the notification and the idempotency record are all absent. The one route that calls it (src/app/api/leads/[id]/assignment/route.ts) maps this to 400 INVALID_REQUEST."
    ;;
  related_text)
    refusal_is_clean "42804" "related_id" \
      "reassigning a lead while the routine casts the lead id to text for notifications.related_id"
    case "$first" in
      *uuid*text*) ;;
      *) fail "the refusal named related_id but not the uuid/text mismatch, so it is some other 42804: $first" ;;
    esac
    echo "  REPRODUCED: with the ::text cast installed and the activities domain left widened, reassign_lead_atomic() still cannot move a lead — 42804 on notifications.related_id, twice identically, and all five rows plus the idempotency record are absent. This is a second, independent reason the same reassignment reports 400 INVALID_REQUEST."
    ;;
  related_text_compatible|fixed)
    case "$first" in
      ok*) ;;
      *) fail "the reassignment was refused ('$first') with notifications.related_id type $RELATED_ID_TYPE" ;;
    esac
    case "$first" in
      *'"unchanged":false'*|*'"unchanged": false'*) ;;
      *) fail "the routine reported success without moving the lead: $first" ;;
    esac
    [ "$owner_after_first" = "$TARGET" ] \
      || fail "the reassignment reported success but the lead belongs to $owner_after_first, not $TARGET"
    [ "$counts_after_first" = "1/1/1/1/1" ] \
      || fail "the successful reassignment wrote $counts_after_first into transfer_history/activities/business_events/notifications/requests, not one row each"
    [ "$history_match_after_first" = "1" ] \
      || fail "the transfer_history row does not record the transfer that happened (from $OWNER to $TARGET by $ADMIN)"
    # The notification's payload, not just its existence: related_id is the column
    # the third defect was about, and a row carrying the wrong id would be a
    # notification about somebody else's lead.
    [ "$notification_match_after_first" = "1" ] \
      || fail "the notification does not point the new owner at this lead (related_id = $LEAD, related_type = 'lead', user_id = $TARGET)"
    [ "$lead_flags_after_first" = "1" ] \
      || fail "the reassignment left the lead's transfer_candidate/recovery_candidate/hold_since set, so the routine's UPDATE did not run in full"
    case "$second" in
      ok*) ;;
      *) fail "replaying the idempotency key was refused ('$second') instead of returning the recorded response" ;;
    esac
    case "$second" in
      *'"idempotent_replay":true'*|*'"idempotent_replay": true'*) ;;
      *) fail "replaying the idempotency key did not report idempotent_replay: $second" ;;
    esac
    [ "$counts_after_second" = "1/1/1/1/1" ] \
      || fail "replaying the key wrote a second set of rows: counts are $counts_after_second"
    [ "$owner_after_second" = "$TARGET" ] \
      || fail "replaying the key moved the lead to $owner_after_second"
    if [ "$EXPECT" = related_text_compatible ]; then
      echo "  REFUTED ON CAPTURED PRODUCTION SHAPE: with notifications.related_id=text, reinstating the ::text cast still commits the reassignment and all five rows exactly once; the replayed key writes nothing more. The 42804 uuid/text finding does not apply to this schema."
    else
      echo "  CLOSED: reassign_lead_atomic() moves the lead to its new owner and writes exactly one transfer_history, activities, business_events, notifications and lead_mutation_requests row; the notification carries this lead's id in the $RELATED_ID_TYPE column; the replayed key returns the recorded response and writes nothing more; and an interrupted call leaves neither the move nor its key behind"
    fi
    ;;
esac
