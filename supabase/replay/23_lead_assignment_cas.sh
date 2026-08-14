#!/usr/bin/env bash
# ============================================================================
# The lead-reassignment compare-and-set is only as good as who owns the token (R6)
# ============================================================================
# 20260723140000_atomic_lead_reassignment.sql:140-142 is the whole concurrency
# guard on lead reassignment:
#
#     IF p_expected_updated_at IS NOT NULL
#        AND v_lead.updated_at IS DISTINCT FROM p_expected_updated_at THEN
#       RAISE EXCEPTION 'CONCURRENT_LEAD_UPDATE';
#     END IF;
#
# The row is read `for update` first, so the comparison is sound if the server owns
# the token. The historical floor omitted a stamp; the authenticated production
# baseline already has trg_set_updated_at and therefore refutes the projected
# production vulnerability. Ordinary UPDATE writers and two RLS policies still
# make this a boundary worth proving on both catalog shapes — a
# policy with no WITH CHECK reuses its USING clause as the check:
#
#   policy_leads_update_sales   USING (assigned_to = auth.uid()). Reused as the
#                               check, it lets the owning salesperson write any
#                               column of their OWN lead — including updated_at,
#                               which useLeadDetailMutations.ts:282 and
#                               usePipelineDragDrop.ts:112 both send from the
#                               browser clock. It does NOT let them hand the row to
#                               anybody else: the reused check fails on the new row.
#                               Measured below; the first probe is exactly that
#                               write, and this gate refused to run until it stopped
#                               claiming a salesperson could do the second.
#   policy_leads_update_admin   USING (actor role in admin/boss/operator). That
#                               clause tests the ACTOR, not the ROW, so reusing it
#                               as the check lets an admin, boss or operator write
#                               any column of ANY lead. This is the privilege
#                               src/app/actions/settings.ts spends: assignLead,
#                               bulkAssignLeads and transferAllLeads each send
#                               `.update({ assigned_to: … })` through the caller's
#                               own client, and not one of them names updated_at.
#
# So the two writers raced below are the two that exist today: a boss reassigning a
# lead the way settings.ts does, and an admin reassigning it through the routine that
# carries the compare-and-set. Neither half of what follows is a source-code fact.
# Whether a write moves a column, and whether a compare-and-set fires against a
# concurrent committed write, are facts about a running database. Both are measured
# here, in both directions.
#
# One writer cannot use the routine at all, and it is measured separately for that
# reason. settings.ts bulkUnassignLeads sets assigned_to to NULL, and
# reassign_lead_atomic() has no NULL branch: a null assignee is INVALID_ASSIGNEE, and
# transfer_history.to_user_id is NOT NULL, so there is nothing for the audit row to
# record. It therefore carries the comparison in the statement itself, PostgREST-
# shaped:
#
#     update public.leads set assigned_to = null
#      where id = $1 and updated_at = $2 returning id, updated_at
#
# Whether that WHERE is re-evaluated against a row version that committed while the
# statement was already waiting on its lock — rather than against the snapshot the
# statement was planned on — is not visible in the source at all. Probe 4 stages
# exactly that and measures it, in both directions:
#
#   EXPECT=forged   20260817180000_leads_updated_at_is_server_owned.sql's trigger
#                   DROPPED inside the throwaway database — captured from
#                   pg_get_triggerdef() first and put back from that capture
#                   afterwards, so the control is derived from what is installed
#                   rather than written out by hand. Under it:
#                     · the owning salesperson pins updated_at to a value of their
#                       choosing and it is still there when read back;
#                     · a boss hands the lead to the other salesperson with the plain
#                       UPDATE settings.ts sends, and the token does not move;
#                     · an admin calling reassign_lead_atomic() with the token it read
#                       BEFORE that transfer waits on the row lock and then REPORTS
#                       SUCCESS. The compare-and-set is handed a token that predates a
#                       committed reassignment and takes it. The boss's transfer is
#                       discarded with nobody told, and the transfer_history row the
#                       routine writes records a hand-off FROM the salesperson the
#                       boss moved it to — a state the admin never saw and did not
#                       compare against — while the transfer the boss committed is
#                       recorded nowhere at all.
#                     · the unassign, handed a token that predates a second
#                       concurrent committed transfer, waits on that row lock and
#                       then STILL MATCHES the row and unassigns it. That transfer
#                       is discarded too, and because a plain UPDATE writes no
#                       transfer_history row, discarding it is invisible.
#   EXPECT=baseline_guarded
#                   the captured production shape. The fallback migration has
#                   no-op'd and zz_leads_stamp_updated_at is absent; reapplying the
#                   migration must preserve the exact trigger/function/ACL
#                   fingerprint. The pre-existing stamp then overwrites the pin,
#                   moves on a plain UPDATE and refuses the stale concurrent RPC.
#   EXPECT=guarded  the trigger installed. Same four probes, same statements, same
#                   token: the pin is overwritten by the server, the plain UPDATE
#                   moves the token, and the admin's call waits on the same row
#                   lock and then raises CONCURRENT_LEAD_UPDATE (SQLSTATE P0001).
#                   The lead stays where the boss put it and transfer_history gains
#                   nothing. The unassign, waiting on its own row lock, matches ZERO
#                   rows once the concurrent transfer commits — the token is compared
#                   against the row version that won, not the one the statement was
#                   planned on — and the row reads back still assigned, which is how
#                   settings.ts tells "somebody else took it" from "my retry landed".
#                   A fresh token then unassigns it, and replaying that spent
#                   statement matches nothing while the row reads back NULL.
#
# Why the interleaving is deterministic and not a sleep
# ----------------------------------------------------
# The same reason 15_concurrency_two_session.sh gives, and the same mechanism: a
# green run staged by timing is indistinguishable from a run where the two sessions
# never overlapped, so the database's own lock state is the barrier.
#
#   1. A: begin, claims for the boss, `set local role authenticated`, the plain
#      UPDATE of assigned_to that settings.ts sends, report the row count and its own
#      view of the token, then take an advisory lock as a done-marker. A now holds an
#      uncommitted transfer and waits for input that does not arrive until step 4.
#   2. The coordinator polls pg_locks until that advisory lock is granted — proof
#      that A's UPDATE succeeded and is uncommitted.
#   3. B: begin, claims for the admin, reassign_lead_atomic() with the pre-A token,
#      commit. The coordinator polls pg_locks until B is recorded as WAITING. B
#      blocks inside the routine's `select ... for update`, which is the only place
#      it can block, and that wait is what makes this a real race rather than two
#      statements in a row.
#   4. Only then does the coordinator send A its COMMIT, releasing B.
#
# If either barrier is not reached inside the timeout the run FAILS with both
# session logs. A gate that cannot stage the race must not report on it.
#
# Deadlock-free by construction: A waits on the shell, B waits on A, the shell
# waits on B's wait becoming visible in pg_locks. No cycle inside the database.
#
# Probe 4 stages the same barrier pair with the same mechanism and its own advisory
# key — C in place of A, holding an uncommitted plain transfer, and D in place of B,
# running the single unassign statement. D is required to be seen WAITING before C is
# allowed to commit, for a reason specific to this probe: the whole question is which
# row version the WHERE is checked against. A D that ran after C committed would be
# comparing against the winning version by arithmetic rather than by re-evaluation,
# and both directions would print the same number for opposite reasons.
#
# The other three dimensions, in both directions
# ----------------------------------------------
#   read after write   every measurement outside A's own transaction comes from a
#                      fresh connection, so what is asserted is committed state.
#                      The pin probe is a read-after-write in the strict sense:
#                      write a chosen updated_at, then read the column back from
#                      another connection.
#   interruption       a further call under a new key, inside a transaction that is
#                      ROLLED BACK: the move must be visible inside that
#                      transaction and absent afterwards, and the idempotency key
#                      must NOT be left recorded — a recorded key for a rolled-back
#                      transfer would answer the retry with a transfer that never
#                      committed.
#   reentry            a successful call replayed under the same key must return the
#                      recorded response with idempotent_replay, must not move the
#                      lead a second time, and must not add a second
#                      transfer_history row. Asserted in BOTH directions: the
#                      trigger must not break the routine's reentry contract, and
#                      the un-triggered control must not appear to fix it.
#
# Probe 4 carries its own four, because a statement is not a routine and none of the
# three above transfer to it: a positive (a fresh token unassigns the lead — which is
# also the control proving nothing in this database refuses a NULL assignee, so a
# zero-row match in the guarded direction is the token and not a trigger), a negative
# (the stale token after the concurrent commit), an interruption (the same unassign
# inside a transaction that is ROLLED BACK: matched inside, gone after), and a reentry
# (the spent statement run again — guarded, it matches nothing and the row reads back
# NULL, which is the branch settings.ts reports as `unchanged` rather than as a
# transfer it performed twice). Every count outside a session's own transaction is
# read from a fresh connection, so all of it is committed state.
#
# Footprint: one lead (a7a7…) created by this gate, never a fixture, plus the rows
# the routine writes about it. Removed at the end, the removal verified, the
# trigger required back byte-identical to the definition found on entry, both
# advisory done-markers required released, and the assigned_to of every fixture lead
# required back unchanged.
#
# Requires: psql on PATH, PG* pointing at the throwaway replay database. Invoked by
# scripts/replay-migrations.sh. EXPECT is mandatory and has no default, because
# defaulting it is how a control run silently asserts the other branch's claim.
# ============================================================================
set -euo pipefail

# No apostrophe anywhere in the message below: bash treats a single quote inside
# ${VAR:?word} as opening a quoted region even when the whole expansion is already
# inside double quotes, so one possessive here makes the rest of the file unparseable.
: "${EXPECT:?EXPECT must be forged (no stamp trigger remains), baseline_guarded (the release trigger is removed but the pre-existing production stamp remains), or guarded (the release trigger is installed)}"
case "$EXPECT" in
  forged|baseline_guarded|guarded) ;;
  *) echo "lead CAS gate: EXPECT must be 'forged', 'baseline_guarded' or 'guarded', got '$EXPECT'" >&2; exit 1 ;;
esac

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=postgres}"
export PGHOST PGPORT PGUSER PGDATABASE

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAMP_MIGRATION="$ROOT/supabase/migrations/20260817180000_leads_updated_at_is_server_owned.sql"

# Fixed values, no random(): the assertions and the cleanup name their rows.
LEAD='a7a7a7a7-a7a7-a7a7-a7a7-a7a7a7a7a7a7'      # created here; no fixture uses it
OWNER='cccccccc-cccc-cccc-cccc-cccccccccccc'     # replay-sales1,   'sales',    active — holds the lead, and pins the token
HIJACK='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'    # replay-sales2,   'sales',    active — where A moves it
THIRD='0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a'     # replay-operator, 'operator', active — where B moves it
ACTOR_A='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'   # replay-boss,     'boss',     active — A's actor, the settings.ts privilege
ADMIN='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'     # replay-admin,    'admin',    active — B's actor
KEY_RACE='a7a7a7a7-0001-4000-8000-0000000000a7'
KEY_INFLIGHT='a7a7a7a7-0002-4000-8000-0000000000a7'
KEY_REENTRY='a7a7a7a7-0003-4000-8000-0000000000a7'
PINNED='2020-01-01 00:00:00+00'                  # a token the client picks, years stale
TRIGGER='zz_leads_stamp_updated_at'
CUSTOMER='Replay lead R6 CAS'
MARK_HI=918274                                   # advisory done-marker for A; 918273/645
MARK_LO=646                                      # belongs to 15_concurrency_two_session.sh
MARK_LO_C=647                                    # probe 4's own marker, for session C
BARRIER_TIMEOUT="${BARRIER_TIMEOUT:-90}"

work_dir="$(mktemp -d)"
out_a="$work_dir/session_a.log"
out_b="$work_dir/session_b.log"
out_c="$work_dir/session_c.log"
out_d="$work_dir/session_d.log"
restore_needed=0
TRIGGER_DEF=

fail() {
  echo "lead CAS gate failed: $*" >&2
  exit 1
}

q() {
  psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 -c "$1" | tr -d '[:space:]'
}

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

# ISO 8601 with no spaces and six digits of fraction, so the value survives a trip
# through the shell and back into ::timestamptz without losing a microsecond. `q`
# strips whitespace, which is why the space between date and time is not left in.
token_of() {
  q "select to_char(updated_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.USOF') from public.leads where id = '$LEAD'"
}

lead_stamp_fingerprint() {
  q "select md5(
       coalesce((select string_agg(t.tgname || '|' || pg_catalog.pg_get_triggerdef(t.oid) || '|' ||
                                    coalesce(p.proacl::text, '<null>') || '|' ||
                                    coalesce(p.proconfig::text, '<null>') || '|' ||
                                    pg_catalog.pg_get_functiondef(p.oid), E'\\n' order by t.tgname)
                   from pg_catalog.pg_trigger t
                   join pg_catalog.pg_proc p on p.oid = t.tgfoid
                  where t.tgrelid = 'public.leads'::regclass and not t.tgisinternal), '')
       || '|all-public-trigger-functions|'
       || coalesce((select string_agg(p.oid::text || '|' || p.proname || '|' ||
                                      coalesce(p.proacl::text, '<null>') || '|' ||
                                      coalesce(p.proconfig::text, '<null>') || '|' ||
                                      pg_catalog.pg_get_functiondef(p.oid), E'\\n' order by p.oid)
                     from pg_catalog.pg_proc p
                    where p.pronamespace = 'public'::regnamespace
                      and p.prorettype = 'trigger'::regtype), '')
     )"
}

dump_sessions() {
  for log in "$out_a" "$out_b" "$out_c" "$out_d"; do
    [ -f "$log" ] || continue
    echo "--- $(basename "$log") ---" >&2
    cat "$log" >&2
  done
}

# The rows this gate created. transfer_history and lead_mutation_requests reference
# leads with NO ACTION, and notifications does not reference it at all, so they go
# first; activities and business_events are ON DELETE CASCADE and go with the lead.
# Also called from the cleanup trap, because both directions run against the same
# database: a run that fails after staging the lead must not leave a row that makes
# the NEXT direction fail on a precondition instead of reporting its own result.
remove_rows() {
  printf '%s\n' "
    delete from public.transfer_history where lead_id = '$LEAD';
    delete from public.lead_mutation_requests where lead_id = '$LEAD';
    delete from public.notifications where related_id = '$LEAD';
    delete from public.leads where id = '$LEAD';
  " >"$work_dir/remove.sql"
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction \
    -f "$work_dir/remove.sql" >"$work_dir/remove.log" 2>&1
}

# The control has to be undone even when the gate fails, or a failing run would
# leave the replay database without a trigger the release installs and every later
# assertion would be measuring this gate's scaffolding.
restore_trigger() {
  [ "$restore_needed" = "1" ] || return 0
  [ -n "$TRIGGER_DEF" ] || { echo "lead CAS gate: no captured trigger definition to restore" >&2; return 0; }
  restore_needed=0
  printf '%s;\n' "$TRIGGER_DEF" >"$work_dir/restore.sql"
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction \
    -f "$work_dir/restore.sql" >"$work_dir/restore.log" 2>&1 \
    || { cat "$work_dir/restore.log" >&2; echo "lead CAS gate: COULD NOT RESTORE $TRIGGER" >&2; }
}

cleanup() {
  local status=$?
  # Close A's and C's stdin if either is still open, so a failure between the
  # barriers does not leave a psql holding row locks in the replay database.
  if [ -n "${A_IN:-}" ]; then
    eval "exec ${A_IN}>&-" 2>/dev/null || true
  fi
  if [ -n "${C_IN:-}" ]; then
    eval "exec ${C_IN}>&-" 2>/dev/null || true
  fi
  [ -n "${A_PID:-}" ] && wait "$A_PID" 2>/dev/null || true
  [ -n "${B_PID:-}" ] && wait "$B_PID" 2>/dev/null || true
  [ -n "${C_PID:-}" ] && wait "$C_PID" 2>/dev/null || true
  [ -n "${D_PID:-}" ] && wait "$D_PID" 2>/dev/null || true
  # After the sessions are closed, so nothing still holds a row lock on the lead.
  # A no-op on a successful run, which already removed and verified its rows.
  remove_rows || { cat "$work_dir/remove.log" >&2; echo "lead CAS gate: COULD NOT REMOVE this gate's rows for $LEAD" >&2; }
  restore_trigger
  rm -rf "$work_dir"
  return $status
}
trap cleanup EXIT

command -v psql >/dev/null 2>&1 || fail "psql not found on PATH"

# ---------------------------------------------------------------------------
# Preconditions, asserted rather than assumed. Each of these being absent would
# otherwise show up as a confusing session error at a barrier, or worse, as a
# refusal that looks like the guard working.
# ---------------------------------------------------------------------------
[ "$(q "select count(*) from pg_proc where oid = to_regprocedure('public.reassign_lead_atomic(uuid, uuid, timestamptz, uuid, text)')")" = "1" ] \
  || fail "public.reassign_lead_atomic(uuid, uuid, timestamptz, uuid, text) is not present in this database"
for t in leads transfer_history notifications activities business_events lead_mutation_requests; do
  [ "$(q "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relname = '$t' and c.relkind = 'r'")" = "1" ] \
    || fail "public.$t is not present in this database, so the routine cannot be measured"
done
[ "$(q "select count(*) from public.profiles where id = '$ADMIN' and role = 'admin' and coalesce(is_active, false)")" = "1" ] \
  || fail "fixture profile $ADMIN is not an active admin, so reassign_lead_atomic() would answer FORBIDDEN_REASSIGNMENT for reasons unrelated to this gate"
[ "$(q "select count(*) from public.profiles where id = '$OWNER' and role = 'sales' and coalesce(is_active, false)")" = "1" ] \
  || fail "fixture profile $OWNER is not an active salesperson"
[ "$(q "select count(*) from public.profiles where id = '$HIJACK' and role = 'sales' and coalesce(is_active, false)")" = "1" ] \
  || fail "fixture profile $HIJACK is not an active salesperson, so the routine would answer INVALID_ASSIGNEE"
[ "$(q "select count(*) from public.profiles where id = '$THIRD' and role = 'operator' and coalesce(is_active, false)")" = "1" ] \
  || fail "fixture profile $THIRD is not an active operator, so the routine would answer INVALID_ASSIGNEE"
[ "$(q "select count(*) from public.profiles where id = '$ACTOR_A' and role = 'boss' and coalesce(is_active, false)")" = "1" ] \
  || fail "fixture profile $ACTOR_A is not an active boss, so session A cannot stage the direct write this gate is about"
[ "$(q "select has_table_privilege('authenticated', 'public.leads', 'update')::text")" = "true" ] \
  || fail "the authenticated role cannot UPDATE public.leads in this database, so session A cannot stage the direct write this gate is about"
# Both policies are load-bearing here, and for opposite reasons. Reused as its own
# check, policy_leads_update_sales is what lets the owning salesperson write
# updated_at in probe 1 — and it is also why they CANNOT be session A: the reused
# check tests the row, so handing the lead away fails it. policy_leads_update_admin
# tests the actor instead, which is what makes session A possible at all. A WITH
# CHECK appearing on either would change what these probes measure, so neither is
# assumed.
[ "$(q "select count(*) from pg_policy p where p.polrelid = 'public.leads'::regclass
          and p.polname = 'policy_leads_update_sales' and p.polwithcheck is null and p.polpermissive")" = "1" ] \
  || fail "policy_leads_update_sales is missing, no longer permissive, or has grown a WITH CHECK clause; probe 1 stages the owning salesperson's updated_at write through it, so this gate cannot measure who owns the token"
[ "$(q "select count(*) from pg_policy p where p.polrelid = 'public.leads'::regclass
          and p.polname = 'policy_leads_update_admin' and p.polwithcheck is null and p.polpermissive")" = "1" ] \
  || fail "policy_leads_update_admin is missing, no longer permissive, or has grown a WITH CHECK clause; session A's cross-owner write is staged through it, exactly as src/app/actions/settings.ts does, so this gate cannot measure what it is for"
[ "$(q "select count(*) from public.leads where id = '$LEAD'")" = "0" ] \
  || fail "lead $LEAD already exists; this gate creates and removes it, and will not adopt a row it did not make"
[ "$(q "select count(*) from public.transfer_history where lead_id = '$LEAD'")" = "0" ] \
  || fail "transfer_history already holds rows for $LEAD"
[ "$(q "select count(*) from public.lead_mutation_requests where idempotency_key in ('$KEY_RACE', '$KEY_INFLIGHT', '$KEY_REENTRY')")" = "0" ] \
  || fail "this gate's idempotency keys are already recorded, which means an earlier run did not clean up; a replayed key would be answered from that run"
[ "$(q "select count(*) from pg_locks where locktype = 'advisory' and classid = $MARK_HI and objid = $MARK_LO")" = "0" ] \
  || fail "the advisory done-marker $MARK_HI/$MARK_LO is already held, so barrier 1 would pass without session A having done anything"
[ "$(q "select count(*) from pg_locks where locktype = 'advisory' and classid = $MARK_HI and objid = $MARK_LO_C")" = "0" ] \
  || fail "probe 4's advisory done-marker $MARK_HI/$MARK_LO_C is already held, so its first barrier would pass without session C having done anything"

# The activities repair has to be applied for every direction: without it the
# routine raises 23514 and a refusal could be misread as CAS. On a uuid related_id
# target the text-cast repair is also required; on captured production's text target
# that defect is refuted. Both catalog shapes are measured by 22_ before this gate.
[ "$(q "select count(*) from pg_catalog.pg_constraint
          where conrelid = 'public.activities'::regclass and conname = 'activities_type_check'
            and pg_catalog.pg_get_constraintdef(oid) like '%''transfer''%'")" = "1" ] \
  || fail "activities_type_check does not accept 'transfer', so reassign_lead_atomic() cannot commit a reassignment in this database and the $EXPECT result below is not evidence of anything. Apply 20260817190000_lead_reassignment_activity_type.sql (measured by 22_lead_reassignment_writes.sh) first"
RELATED_ID_TYPE="$(q "select data_type from information_schema.columns
  where table_schema = 'public' and table_name = 'notifications' and column_name = 'related_id'")"
case "$RELATED_ID_TYPE" in
  uuid)
    [ "$(q "select position('p_lead_id::text, ''lead''' in
              pg_catalog.pg_get_functiondef(to_regprocedure('public.reassign_lead_atomic(uuid, uuid, timestamptz, uuid, text)')))")" = "0" ] \
      || fail "reassign_lead_atomic() casts the lead id to text for a uuid notifications.related_id target, so it cannot commit a reassignment in this database"
    ;;
  text) ;;
  *) fail "notifications.related_id has unsupported data_type '$RELATED_ID_TYPE'; expected uuid or text" ;;
esac

TRIGGER_DEF="$(q_raw "select pg_catalog.pg_get_triggerdef(t.oid)
                        from pg_catalog.pg_trigger t
                       where t.tgrelid = 'public.leads'::regclass
                         and t.tgname = '$TRIGGER' and not t.tgisinternal")"
VALID_STAMP_TRIGGERS="$(q "select count(*) from pg_catalog.pg_trigger t
  join pg_catalog.pg_proc p on p.oid = t.tgfoid
  where t.tgrelid = 'public.leads'::regclass
    and not t.tgisinternal and t.tgenabled = 'O'
    and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2 and (t.tgtype & 16) = 16
    and t.tgattr::text = '' and t.tgqual is null and not p.prosecdef
    and pg_catalog.regexp_replace(p.prosrc, '[[:space:]]+', '', 'g')
          ~* '^beginnew[.]updated_at(:=|=)(pg_catalog[.])?now[(][)];returnnew;end;?$'")"
OTHER_STAMP_TRIGGERS="$(q "select count(*) from pg_catalog.pg_trigger t
  join pg_catalog.pg_proc p on p.oid = t.tgfoid
  where t.tgrelid = 'public.leads'::regclass
    and not t.tgisinternal and t.tgname <> '$TRIGGER' and t.tgenabled = 'O'
    and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2 and (t.tgtype & 16) = 16
    and t.tgattr::text = '' and t.tgqual is null and not p.prosecdef
    and pg_catalog.regexp_replace(p.prosrc, '[[:space:]]+', '', 'g')
          ~* '^beginnew[.]updated_at(:=|=)(pg_catalog[.])?now[(][)];returnnew;end;?$'")"
case "$EXPECT" in
  forged)
    [ -n "$TRIGGER_DEF" ] \
      || fail "EXPECT=forged requires the fallback $TRIGGER so it can derive and restore the no-stamp control"
    [ "$(q "select tgenabled from pg_catalog.pg_trigger
              where tgrelid = 'public.leads'::regclass and tgname = '$TRIGGER'")" = "O" ] \
      || fail "$TRIGGER is present on public.leads but not enabled"
    [ "$VALID_STAMP_TRIGGERS" = "1" ] \
      || fail "EXPECT=forged requires exactly the fallback stamp before it is removed; found $VALID_STAMP_TRIGGERS valid stamps"
    [ "$OTHER_STAMP_TRIGGERS" = "0" ] \
      || fail "EXPECT=forged cannot represent the pre-migration state: $OTHER_STAMP_TRIGGERS other enabled BEFORE UPDATE row trigger(s) already stamp leads.updated_at"
    ;;
  baseline_guarded)
    [ -z "$TRIGGER_DEF" ] \
      || fail "EXPECT=baseline_guarded requires 20260817180000 to have no-op'd; $TRIGGER exists"
    [ "$OTHER_STAMP_TRIGGERS" -gt 0 ] \
      || fail "EXPECT=baseline_guarded requires a pre-existing enabled BEFORE UPDATE row trigger that stamps leads.updated_at"
    ;;
  guarded)
    [ "$VALID_STAMP_TRIGGERS" -gt 0 ] \
      || fail "EXPECT=guarded requires at least one enabled unconditional server-clock stamp for leads.updated_at"
    ;;
esac

FIXTURE_OWNERS_ON_ENTRY="$(q "select md5(string_agg(id::text || '=' || coalesce(assigned_to::text, ''), ',' order by id))
                                from public.leads where id <> '$LEAD'")"

# ---------------------------------------------------------------------------
# The control.
# ---------------------------------------------------------------------------
if [ "$EXPECT" = forged ]; then
  run_sql "could not drop $TRIGGER for the control direction" \
    "drop trigger $TRIGGER on public.leads;"
  restore_needed=1
  [ "$(q "select count(*) from pg_trigger where tgrelid = 'public.leads'::regclass and tgname = '$TRIGGER'")" = "0" ] \
    || fail "$TRIGGER is still on public.leads after the drop"
  echo "  control installed: $TRIGGER dropped, captured for restore from pg_get_triggerdef(); other server stamp triggers=$OTHER_STAMP_TRIGGERS"
fi

if [ "$EXPECT" = baseline_guarded ]; then
  [ -f "$STAMP_MIGRATION" ] || fail "missing $STAMP_MIGRATION"
  stamp_fingerprint_before="$(lead_stamp_fingerprint)"
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 -f "$STAMP_MIGRATION" \
    >"$work_dir/stamp-reentry.log" 2>&1 \
    || { cat "$work_dir/stamp-reentry.log" >&2; fail "the production-aware stamp migration did not re-enter cleanly"; }
  stamp_fingerprint_after="$(lead_stamp_fingerprint)"
  [ "$stamp_fingerprint_after" = "$stamp_fingerprint_before" ] \
    || fail "the production-aware no-op changed the leads trigger/function/ACL fingerprint ($stamp_fingerprint_before -> $stamp_fingerprint_after)"
  [ "$(q "select count(*) from pg_catalog.pg_trigger where tgrelid = 'public.leads'::regclass
              and not tgisinternal and tgname = '$TRIGGER'")" = "0" ] \
    || fail "the production-aware no-op created the redundant $TRIGGER"
  echo "  migration no-op verified: trigger/function/ACL fingerprint stayed $stamp_fingerprint_before and $TRIGGER remains absent"
fi

# ---------------------------------------------------------------------------
# The lead. Staged as the harness role, like every other gate's fixtures; the
# end-user sessions are where this gate's identities matter.
# ---------------------------------------------------------------------------
run_sql "could not stage lead $LEAD" "
  insert into public.leads (id, assigned_to, stage, customer_name, source, transfer_candidate)
  values ('$LEAD', '$OWNER', 'new', '$CUSTOMER', 'other', true);
"
[ "$(q "select coalesce(assigned_to::text, '<null>') from public.leads where id = '$LEAD'")" = "$OWNER" ] \
  || fail "the staged lead does not belong to $OWNER"

# ===========================================================================
# Probe 1 · who owns the token — a read-after-write, one session, no race
# ===========================================================================
# The owning salesperson writes updated_at directly on their own lead, which
# policy_leads_update_sales permits because it has no WITH CHECK and the row still
# satisfies the reused USING clause afterwards. This is not hypothetical:
# src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts:282 and
# src/shared/hooks/usePipelineDragDrop.ts:112 both send
# `updated_at: new Date().toISOString()` from the browser clock.
{
  echo '\set VERBOSITY verbose'
  echo "set application_name = 'replay_cas_pin';"
  echo 'begin;'
  echo "select set_config('request.jwt.claims',
                          json_build_object('sub', '$OWNER', 'role', 'authenticated',
                                            'iat', floor(extract(epoch from now()))::bigint)::text,
                          true);"
  echo 'set local role authenticated;'
  echo "update public.leads set updated_at = '$PINNED'::timestamptz where id = '$LEAD';"
  echo "select 'pin_rows=' || count(*) from public.leads
                where id = '$LEAD' and updated_at = '$PINNED'::timestamptz;"
  echo 'commit;'
} >"$work_dir/pin.sql"
psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 \
  -f "$work_dir/pin.sql" >"$work_dir/pin.log" 2>&1 \
  || { cat "$work_dir/pin.log" >&2; fail "the owning salesperson could not write leads.updated_at at all; this gate is about who wins that write, so it cannot report on a write that was refused"; }

PINNED_AS_TEXT="$(q "select to_char('$PINNED'::timestamptz, 'YYYY-MM-DD\"T\"HH24:MI:SS.USOF')")"
token_after_pin="$(token_of)"
pin_in_tx="$(sed -n 's/^pin_rows=//p' "$work_dir/pin.log" | head -1 | tr -d '[:space:]')"
echo "  pin probe: the owner wrote updated_at = $PINNED_AS_TEXT; a fresh connection reads $token_after_pin (in-transaction match rows = $pin_in_tx)"

# ===========================================================================
# The race
# ===========================================================================
TOKEN_BEFORE="$(token_of)"
[ -n "$TOKEN_BEFORE" ] || fail "the staged lead has a null updated_at, so there is no token to compare against"

# --- session A, driven statement by statement over a pipe -------------------
# A coprocess rather than a fifo, for the reason 15_concurrency_two_session.sh
# gives: an anonymous pipe is what `cmd | psql` already uses, so it works through
# every psql wrapper this harness runs under.
coproc A_SESSION { psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 >"$out_a" 2>&1; }
A_IN="${A_SESSION[1]}"
A_PID="$A_SESSION_PID"

a_send() { printf '%s\n' "$1" >&"$A_IN" || true; }

# The statement is settings.ts verbatim in SQL: assigned_to and nothing else, under
# the caller's own identity. Nothing here names updated_at, and that is the point.
a_send "set application_name = 'replay_cas_a';
        set idle_in_transaction_session_timeout = '${BARRIER_TIMEOUT}s';
        begin;
        select set_config('request.jwt.claims',
                          json_build_object('sub', '$ACTOR_A', 'role', 'authenticated',
                                            'iat', floor(extract(epoch from now()))::bigint)::text,
                          true);
        set local role authenticated;
        update public.leads set assigned_to = '$HIJACK' where id = '$LEAD';
        select 'a_rows=' || count(*) from public.leads
              where id = '$LEAD' and assigned_to = '$HIJACK';
        select 'a_token=' || to_char(updated_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.USOF')
          from public.leads where id = '$LEAD';
        select pg_advisory_xact_lock($MARK_HI, $MARK_LO);"

wait_for() {
  local sql="$1" what="$2" deadline=$((SECONDS + BARRIER_TIMEOUT))
  while :; do
    if [ "$(q "$sql")" != "0" ]; then return 0; fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "lead CAS gate: barrier never reached — $what" >&2
      dump_sessions
      return 1
    fi
    sleep 0.2
  done
}

# Barrier 1: A's transfer is done and uncommitted.
wait_for "select count(*) from pg_locks
           where locktype = 'advisory' and classid = $MARK_HI and objid = $MARK_LO and granted" \
         "session A never finished its direct UPDATE (it was refused, or the session died)" \
  || fail "session A did not reach the hand-off point"

A_ROWS="$(sed -n 's/^a_rows=//p' "$out_a" | head -1 | tr -d '[:space:]')"
A_TOKEN="$(sed -n 's/^a_token=//p' "$out_a" | head -1 | tr -d '[:space:]')"
[ "$A_ROWS" = "1" ] \
  || { dump_sessions; fail "session A's direct UPDATE matched $A_ROWS row(s) instead of 1, so it did not stage a transfer"; }
echo "  session A: the boss handed the lead from $OWNER to $HIJACK with a plain UPDATE, uncommitted; its own view of the token is $A_TOKEN (was $TOKEN_BEFORE)"

# --- session B, the whole transaction at once -------------------------------
# It is meant to block inside the database, not to be steered. lock_timeout so a
# coordinator that dies leaves a failed session rather than a hung one. It is
# EXPECTED to raise in the guarded direction, so its exit status is recorded rather
# than trusted.
{
  echo '\set VERBOSITY verbose'
  echo "set application_name = 'replay_cas_b';"
  echo "set lock_timeout = '${BARRIER_TIMEOUT}s';"
  echo 'begin;'
  echo "select set_config('request.jwt.claims',
                          json_build_object('sub', '$ADMIN', 'role', 'authenticated',
                                            'iat', floor(extract(epoch from now()))::bigint)::text,
                          true);"
  echo 'set local role authenticated;'
  echo "select 'b_result=' || public.reassign_lead_atomic(
                   '$LEAD', '$THIRD', '$TOKEN_BEFORE'::timestamptz, '$KEY_RACE',
                   'replay 23: compare-and-set gate')::text;"
  echo 'commit;'
} >"$work_dir/session_b.sql"

# `set +e` inside the subshell on purpose: B is EXPECTED to fail in the guarded
# direction, and under the script's own `set -e` the subshell would exit at the
# failing psql and never record the status, so the log would say nothing about the
# exit code in exactly the direction where it is most interesting.
( set +e
  psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 \
    -f "$work_dir/session_b.sql" >"$out_b" 2>&1
  echo "b_exit=$?" >>"$out_b" ) &
B_PID=$!

# Barrier 2: B is blocked, and blocked on A. Without this the two could have run
# one after the other and the verdict would mean nothing.
wait_for "select count(*) from pg_locks l
            join pg_stat_activity s on s.pid = l.pid
           where not l.granted and s.application_name = 'replay_cas_b'" \
         "session B never blocked on session A, so the reassignment and the direct write did not overlap" \
  || fail "the interleaving could not be staged"

blocked_on="$(q "select coalesce(string_agg(distinct l.locktype, ','), '')
                   from pg_locks l join pg_stat_activity s on s.pid = l.pid
                  where not l.granted and s.application_name = 'replay_cas_b'")"
echo "  session B: admin calling reassign_lead_atomic() with the pre-transfer token, blocked on A (waiting for a $blocked_on lock)"

# Hand-off: A commits, B proceeds.
a_send "commit;"
eval "exec ${A_IN}>&-"
A_IN=
wait "$A_PID" || { dump_sessions; fail "session A did not complete"; }
A_PID=
wait "$B_PID" 2>/dev/null || true
B_PID=

B_ERR="$(sed -n 's/.*ERROR:  \([0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z]\): \(.*\)$/err|\1|\2/p' "$out_b" | head -1)"
B_OK="$(sed -n 's/^b_result=//p' "$out_b" | head -1)"
B_EXIT="$(sed -n 's/^b_exit=//p' "$out_b" | head -1 | tr -d '[:space:]')"

# --- what committed --------------------------------------------------------
owner_after_race="$(q "select coalesce(assigned_to::text, '<null>') from public.leads where id = '$LEAD'")"
th_after_race="$(q "select count(*) from public.transfer_history where lead_id = '$LEAD'")"
# The routine reads the row `for update`, so once A commits it sees assigned_to =
# HIJACK and writes that as from_user_id. Both counts below are therefore about the
# same one row: it records a hand-off from a state the admin never saw, and there is
# no row anywhere for the OWNER -> HIJACK transfer the boss actually committed.
th_from_hijack="$(q "select count(*) from public.transfer_history
                       where lead_id = '$LEAD' and from_user_id = '$HIJACK' and to_user_id = '$THIRD'")"
th_from_owner="$(q "select count(*) from public.transfer_history
                      where lead_id = '$LEAD' and from_user_id = '$OWNER'")"
act_after_race="$(q "select count(*) from public.activities where lead_id = '$LEAD' and type = 'transfer'")"
be_after_race="$(q "select count(*) from public.business_events where lead_id = '$LEAD' and event_type = 'transfer'")"
notif_after_race="$(q "select count(*) from public.notifications where related_id = '$LEAD' and type = 'lead_assigned'")"
key_after_race="$(q "select count(*) from public.lead_mutation_requests where idempotency_key = '$KEY_RACE'")"

echo "  after the race: owner=$owner_after_race transfer_history=$th_after_race activities=$act_after_race business_events=$be_after_race notifications=$notif_after_race key_recorded=$key_after_race (psql exit $B_EXIT)"

# ===========================================================================
# Probe 2 · interruption. A further reassignment under a NEW key, in a
# transaction that is rolled back. Target OWNER, which is neither where the lead
# sits in the forged direction ($THIRD) nor where it sits in the guarded one
# ($HIJACK), so the call takes the moving branch either way instead of the
# `unchanged` early return that writes none of the five rows.
# ===========================================================================
token_before_inflight="$(token_of)"
{
  echo '\set VERBOSITY verbose'
  echo "set application_name = 'replay_cas_inflight';"
  echo 'begin;'
  echo "select set_config('request.jwt.claims',
                          json_build_object('sub', '$ADMIN', 'role', 'authenticated',
                                            'iat', floor(extract(epoch from now()))::bigint)::text,
                          true);"
  echo 'set local role authenticated;'
  echo "select public.reassign_lead_atomic('$LEAD', '$OWNER',
                 '$token_before_inflight'::timestamptz, '$KEY_INFLIGHT',
                 'replay 23: interrupted call');"
  echo "select 'effect_in_tx=' || count(*) from public.leads
                where id = '$LEAD' and assigned_to = '$OWNER';"
  echo 'rollback;'
} >"$work_dir/inflight.sql"
psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 \
  -f "$work_dir/inflight.sql" >"$work_dir/inflight.log" 2>&1 \
  || { cat "$work_dir/inflight.log" >&2; fail "the interrupted call did not run to completion; with a token read from the row itself the compare-and-set has nothing to refuse, so this is a real failure and not the guard firing"; }
inflight_effect="$(sed -n 's/^effect_in_tx=//p' "$work_dir/inflight.log" | head -1 | tr -d '[:space:]')"
[ "$inflight_effect" = "1" ] \
  || fail "the interrupted call did not move the lead inside its own transaction (effect rows = $inflight_effect)"
[ "$(q "select coalesce(assigned_to::text, '<null>') from public.leads where id = '$LEAD'")" = "$owner_after_race" ] \
  || fail "the rolled-back call left the lead at $(q "select coalesce(assigned_to::text, '<null>') from public.leads where id = '$LEAD'") instead of the $owner_after_race it had before it; an interrupted reassignment is not supposed to survive"
[ "$(q "select count(*) from public.transfer_history where lead_id = '$LEAD'")" = "$th_after_race" ] \
  || fail "the rolled-back call left a transfer_history row behind"
[ "$(q "select count(*) from public.lead_mutation_requests where idempotency_key = '$KEY_INFLIGHT'")" = "0" ] \
  || fail "the rolled-back call left its idempotency key recorded, so a retry would be answered with a transfer that never committed"
echo "  interrupted call: the move was visible inside its transaction and left neither the move, the audit row nor the key behind"

# ===========================================================================
# Probe 3 · reentry. One committed reassignment, then the same key again.
# ===========================================================================
token_before_reentry="$(token_of)"
reentry_first="$(
  { echo '\set VERBOSITY verbose'
    echo "set application_name = 'replay_cas_reentry';"
    echo 'begin;'
    echo "select set_config('request.jwt.claims',
                            json_build_object('sub', '$ADMIN', 'role', 'authenticated',
                                              'iat', floor(extract(epoch from now()))::bigint)::text,
                            true);"
    echo 'set local role authenticated;'
    echo "select 'r=' || public.reassign_lead_atomic('$LEAD', '$OWNER',
                   '$token_before_reentry'::timestamptz, '$KEY_REENTRY',
                   'replay 23: reentry')::text;"
    echo 'commit;'
  } >"$work_dir/reentry1.sql"
  psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 \
    -f "$work_dir/reentry1.sql" 2>&1 || true
)"
case "$reentry_first" in
  *'"unchanged":false'*|*'"unchanged": false'*) ;;
  *) fail "the reentry probe's first call did not commit a reassignment: $reentry_first" ;;
esac
th_after_reentry_first="$(q "select count(*) from public.transfer_history where lead_id = '$LEAD'")"
[ "$th_after_reentry_first" = "$((th_after_race + 1))" ] \
  || fail "the reentry probe's first call wrote $((th_after_reentry_first - th_after_race)) transfer_history row(s), not one"

reentry_replay="$(
  { echo '\set VERBOSITY verbose'
    echo "set application_name = 'replay_cas_reentry2';"
    echo 'begin;'
    echo "select set_config('request.jwt.claims',
                            json_build_object('sub', '$ADMIN', 'role', 'authenticated',
                                              'iat', floor(extract(epoch from now()))::bigint)::text,
                            true);"
    echo 'set local role authenticated;'
    # Deliberately a STALE token: the recorded response has to be returned before
    # the compare-and-set is reached, or a retry after a timeout would be refused
    # for having lost a race it actually won.
    echo "select 'r=' || public.reassign_lead_atomic('$LEAD', '$OWNER',
                   '$token_before_reentry'::timestamptz, '$KEY_REENTRY',
                   'replay 23: reentry')::text;"
    echo 'commit;'
  } >"$work_dir/reentry2.sql"
  psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 \
    -f "$work_dir/reentry2.sql" 2>&1 || true
)"
case "$reentry_replay" in
  *'"idempotent_replay":true'*|*'"idempotent_replay": true'*) ;;
  *) fail "replaying the idempotency key did not return the recorded response: $reentry_replay" ;;
esac
[ "$(q "select count(*) from public.transfer_history where lead_id = '$LEAD'")" = "$th_after_reentry_first" ] \
  || fail "replaying the idempotency key wrote a second transfer_history row"
[ "$(q "select coalesce(assigned_to::text, '<null>') from public.leads where id = '$LEAD'")" = "$OWNER" ] \
  || fail "replaying the idempotency key moved the lead again, to $(q "select coalesce(assigned_to::text, '<null>') from public.leads where id = '$LEAD'")"
echo "  reentry: one commit wrote one audit row; the replayed key returned the recorded response, wrote nothing and moved nothing"

# ===========================================================================
# Probe 4 · the unassign that cannot use the routine, raced the same way
# ===========================================================================
# src/app/actions/settings.ts bulkUnassignLeads. Everything else in that file now
# goes through reassign_lead_atomic(); this one cannot, so it carries the comparison
# in its own WHERE. Four measurements follow, and the first is the one that cannot be
# read off the source: a stale token handed to a statement that is already WAITING on
# the row lock of the transfer that will invalidate it.
token_before_unassign="$(token_of)"
owner_before_unassign="$(q "select coalesce(assigned_to::text, '<null>') from public.leads where id = '$LEAD'")"
th_before_unassign="$(q "select count(*) from public.transfer_history where lead_id = '$LEAD'")"
[ "$owner_before_unassign" = "$OWNER" ] \
  || fail "probe 4 expected the lead on $OWNER after the reentry probe and found $owner_before_unassign; the states this probe compares are staged by the probes above, so it will not run against a row it cannot account for"

# --- session C: the interleaving transfer, uncommitted ----------------------
coproc C_SESSION { psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 >"$out_c" 2>&1; }
C_IN="${C_SESSION[1]}"
C_PID="$C_SESSION_PID"

c_send() { printf '%s\n' "$1" >&"$C_IN" || true; }

c_send "set application_name = 'replay_cas_c';
        set idle_in_transaction_session_timeout = '${BARRIER_TIMEOUT}s';
        begin;
        select set_config('request.jwt.claims',
                          json_build_object('sub', '$ACTOR_A', 'role', 'authenticated',
                                            'iat', floor(extract(epoch from now()))::bigint)::text,
                          true);
        set local role authenticated;
        update public.leads set assigned_to = '$HIJACK' where id = '$LEAD';
        select 'c_rows=' || count(*) from public.leads
              where id = '$LEAD' and assigned_to = '$HIJACK';
        select pg_advisory_xact_lock($MARK_HI, $MARK_LO_C);"

wait_for "select count(*) from pg_locks
           where locktype = 'advisory' and classid = $MARK_HI and objid = $MARK_LO_C and granted" \
         "session C never finished its direct UPDATE (it was refused, or the session died)" \
  || fail "session C did not reach the hand-off point"

C_ROWS="$(sed -n 's/^c_rows=//p' "$out_c" | head -1 | tr -d '[:space:]')"
[ "$C_ROWS" = "1" ] \
  || { dump_sessions; fail "session C's direct UPDATE matched $C_ROWS row(s) instead of 1, so it did not stage a transfer for the unassign to collide with"; }

# --- session D: bulkUnassignLeads, one statement, the pre-C token -----------
# The CTE is only there to make the row count observable; the UPDATE inside it is the
# statement PostgREST emits for
#   .update({ assigned_to: null }).eq('id', …).eq('updated_at', …).select('id, updated_at')
# with the same single-statement semantics and the same WHERE.
{
  echo '\set VERBOSITY verbose'
  echo "set application_name = 'replay_cas_d';"
  echo "set lock_timeout = '${BARRIER_TIMEOUT}s';"
  echo 'begin;'
  echo "select set_config('request.jwt.claims',
                          json_build_object('sub', '$ADMIN', 'role', 'authenticated',
                                            'iat', floor(extract(epoch from now()))::bigint)::text,
                          true);"
  echo 'set local role authenticated;'
  echo "with cas as (
          update public.leads set assigned_to = null
           where id = '$LEAD' and updated_at = '$token_before_unassign'::timestamptz
          returning id
        ) select 'd_rows=' || count(*) from cas;"
  echo 'commit;'
} >"$work_dir/session_d.sql"

( set +e
  psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 \
    -f "$work_dir/session_d.sql" >"$out_d" 2>&1
  echo "d_exit=$?" >>"$out_d" ) &
D_PID=$!

wait_for "select count(*) from pg_locks l
            join pg_stat_activity s on s.pid = l.pid
           where not l.granted and s.application_name = 'replay_cas_d'" \
         "session D never blocked on session C, so the unassign and the transfer did not overlap and the token was not re-evaluated against a concurrent commit" \
  || fail "probe 4's interleaving could not be staged"

d_blocked_on="$(q "select coalesce(string_agg(distinct l.locktype, ','), '')
                     from pg_locks l join pg_stat_activity s on s.pid = l.pid
                    where not l.granted and s.application_name = 'replay_cas_d'")"
echo "  session D: bulkUnassignLeads with the pre-transfer token $token_before_unassign, blocked on C (waiting for a $d_blocked_on lock)"

c_send "commit;"
eval "exec ${C_IN}>&-"
C_IN=
wait "$C_PID" || { dump_sessions; fail "session C did not complete"; }
C_PID=
wait "$D_PID" 2>/dev/null || true
D_PID=

D_ROWS="$(sed -n 's/^d_rows=//p' "$out_d" | head -1 | tr -d '[:space:]')"
D_EXIT="$(sed -n 's/^d_exit=//p' "$out_d" | head -1 | tr -d '[:space:]')"
[ -n "$D_ROWS" ] && [ "$D_EXIT" = "0" ] \
  || { dump_sessions; fail "session D neither reported a row count nor exited cleanly (rows='$D_ROWS', exit='$D_EXIT'); a compare-and-set that errors is a different finding from one that matches nothing, and this probe is about the second"; }

# The read-back settings.ts performs when the statement matched nothing, and the only
# thing that tells "somebody else took it" from "my retry already landed".
owner_after_unassign="$(q "select coalesce(assigned_to::text, '<null>') from public.leads where id = '$LEAD'")"
echo "  after the unassign race: matched=$D_ROWS row(s), the lead reads back as $owner_after_unassign (was $owner_before_unassign, C committed a move to $HIJACK)"

# --- interruption: the same unassign, rolled back --------------------------
token_unassign_rollback="$(token_of)"
{
  echo '\set VERBOSITY verbose'
  echo "set application_name = 'replay_cas_unassign_rollback';"
  echo 'begin;'
  echo "select set_config('request.jwt.claims',
                          json_build_object('sub', '$ADMIN', 'role', 'authenticated',
                                            'iat', floor(extract(epoch from now()))::bigint)::text,
                          true);"
  echo 'set local role authenticated;'
  echo "with cas as (
          update public.leads set assigned_to = null
           where id = '$LEAD' and updated_at = '$token_unassign_rollback'::timestamptz
          returning id
        ) select 'rollback_rows=' || count(*) from cas;"
  echo 'rollback;'
} >"$work_dir/unassign_rollback.sql"
psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 \
  -f "$work_dir/unassign_rollback.sql" >"$work_dir/unassign_rollback.log" 2>&1 \
  || { cat "$work_dir/unassign_rollback.log" >&2; fail "the interrupted unassign did not run to completion; with a token read from the row itself the comparison has nothing to refuse, so this is a real failure"; }
unassign_rollback_rows="$(sed -n 's/^rollback_rows=//p' "$work_dir/unassign_rollback.log" | head -1 | tr -d '[:space:]')"
[ "$unassign_rollback_rows" = "1" ] \
  || fail "the interrupted unassign matched $unassign_rollback_rows row(s) inside its own transaction with a token read from the row itself, so it never staged the write it was supposed to abandon"
[ "$(q "select coalesce(assigned_to::text, '<null>') from public.leads where id = '$LEAD'")" = "$owner_after_unassign" ] \
  || fail "the rolled-back unassign left the lead at $(q "select coalesce(assigned_to::text, '<null>') from public.leads where id = '$LEAD'") instead of the $owner_after_unassign it had before it"
echo "  interrupted unassign: matched one row inside its transaction and left the lead on $owner_after_unassign"

# --- positive, and the control that a NULL assignee is permitted at all ----
# This is what makes a zero-row match above attributable to the token. If some
# trigger in this database refused a null assigned_to, the guarded direction would
# print the same zero for an entirely different reason.
token_unassign_fresh="$(token_of)"
{
  echo '\set VERBOSITY verbose'
  echo "set application_name = 'replay_cas_unassign_ok';"
  echo 'begin;'
  echo "select set_config('request.jwt.claims',
                          json_build_object('sub', '$ADMIN', 'role', 'authenticated',
                                            'iat', floor(extract(epoch from now()))::bigint)::text,
                          true);"
  echo 'set local role authenticated;'
  echo "with cas as (
          update public.leads set assigned_to = null
           where id = '$LEAD' and updated_at = '$token_unassign_fresh'::timestamptz
          returning id
        ) select 'ok_rows=' || count(*) from cas;"
  echo 'commit;'
} >"$work_dir/unassign_ok.sql"
psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 \
  -f "$work_dir/unassign_ok.sql" >"$work_dir/unassign_ok.log" 2>&1 \
  || { cat "$work_dir/unassign_ok.log" >&2; fail "the unassign was REFUSED with a token read from the row itself, so this database rejects a null assigned_to and probe 4 cannot attribute a zero-row match to the token"; }
unassign_ok_rows="$(sed -n 's/^ok_rows=//p' "$work_dir/unassign_ok.log" | head -1 | tr -d '[:space:]')"
[ "$unassign_ok_rows" = "1" ] \
  || fail "the unassign with a current token matched $unassign_ok_rows row(s), not 1; the statement itself does not work in this database, so nothing above is evidence about the token"
[ "$(q "select coalesce(assigned_to::text, '<null>') from public.leads where id = '$LEAD'")" = "<null>" ] \
  || fail "the unassign reported a match but the lead still belongs to $(q "select coalesce(assigned_to::text, '<null>') from public.leads where id = '$LEAD'")"

# --- reentry: the spent statement, run again -------------------------------
{
  echo '\set VERBOSITY verbose'
  echo "set application_name = 'replay_cas_unassign_replay';"
  echo 'begin;'
  echo "select set_config('request.jwt.claims',
                          json_build_object('sub', '$ADMIN', 'role', 'authenticated',
                                            'iat', floor(extract(epoch from now()))::bigint)::text,
                          true);"
  echo 'set local role authenticated;'
  echo "with cas as (
          update public.leads set assigned_to = null
           where id = '$LEAD' and updated_at = '$token_unassign_fresh'::timestamptz
          returning id
        ) select 'replay_rows=' || count(*) from cas;"
  echo 'commit;'
} >"$work_dir/unassign_replay.sql"
psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 \
  -f "$work_dir/unassign_replay.sql" >"$work_dir/unassign_replay.log" 2>&1 \
  || { cat "$work_dir/unassign_replay.log" >&2; fail "replaying the unassign errored instead of matching or not matching"; }
unassign_replay_rows="$(sed -n 's/^replay_rows=//p' "$work_dir/unassign_replay.log" | head -1 | tr -d '[:space:]')"
owner_after_unassign_replay="$(q "select coalesce(assigned_to::text, '<null>') from public.leads where id = '$LEAD'")"
[ "$owner_after_unassign_replay" = "<null>" ] \
  || fail "replaying the unassign left the lead on $owner_after_unassign_replay"
echo "  unassign positive/reentry: a current token matched $unassign_ok_rows row(s); the same statement replayed matched $unassign_replay_rows, and the lead reads back as $owner_after_unassign_replay"

# Shared, both directions: a plain UPDATE writes no audit row. This is the
# limitation bulkUnassignLeads carries and it is stated as measured rather than
# assumed — four unassign writes above, and transfer_history is untouched.
th_after_unassign="$(q "select count(*) from public.transfer_history where lead_id = '$LEAD'")"
[ "$th_after_unassign" = "$th_before_unassign" ] \
  || fail "the unassign probes changed transfer_history from $th_before_unassign to $th_after_unassign; a plain UPDATE cannot write it, so something else in this database did and probe 4 is not measuring what it says"

# ---------------------------------------------------------------------------
# Cleanup before the verdict, so a failing gate still leaves the database in the
# state the fixtures created. Every fact the verdict asserts was captured into a
# variable above, before this point.
# ---------------------------------------------------------------------------
remove_rows || { cat "$work_dir/remove.log" >&2; fail "could not remove this gate's rows"; }
restore_trigger

for pair in "leads:id = '$LEAD'" "activities:lead_id = '$LEAD'" "business_events:lead_id = '$LEAD'" \
            "transfer_history:lead_id = '$LEAD'" "notifications:related_id = '$LEAD'" \
            "lead_mutation_requests:lead_id = '$LEAD'"; do
  t="${pair%%:*}"; w="${pair#*:}"
  [ "$(q "select count(*) from public.$t where $w")" = "0" ] \
    || fail "public.$t rows for this gate's lead were left behind"
done
[ "$(q "select count(*) from public.lead_mutation_requests
          where idempotency_key in ('$KEY_RACE', '$KEY_INFLIGHT', '$KEY_REENTRY')")" = "0" ] \
  || fail "this gate's idempotency keys were left recorded"
[ "$(q "select count(*) from pg_locks where locktype = 'advisory'
          and classid = $MARK_HI and objid in ($MARK_LO, $MARK_LO_C)")" = "0" ] \
  || fail "an advisory done-marker ($MARK_HI/$MARK_LO or $MARK_HI/$MARK_LO_C) is still held, so a session from this gate is still open"

trigger_on_exit="$(q_raw "select pg_catalog.pg_get_triggerdef(t.oid)
                            from pg_catalog.pg_trigger t
                           where t.tgrelid = 'public.leads'::regclass
                             and t.tgname = '$TRIGGER' and not t.tgisinternal")"
[ "$trigger_on_exit" = "$TRIGGER_DEF" ] \
  || fail "$TRIGGER left this gate as '$trigger_on_exit' instead of the '$TRIGGER_DEF' it arrived with"
[ "$(q "select md5(string_agg(id::text || '=' || coalesce(assigned_to::text, ''), ',' order by id))
          from public.leads where id <> '$LEAD'")" = "$FIXTURE_OWNERS_ON_ENTRY" ] \
  || fail "this gate changed which salesperson a fixture lead belongs to"

# ===========================================================================
# The verdict.
# ===========================================================================
case "$EXPECT" in
  forged)
    [ "$token_after_pin" = "$PINNED_AS_TEXT" ] \
      || fail "without $TRIGGER the owning salesperson's chosen updated_at should have survived, but a fresh connection read $token_after_pin instead of $PINNED_AS_TEXT. The control is not the state this release starts from — re-read the drop above before changing the expectation"
    [ "$A_TOKEN" = "$TOKEN_BEFORE" ] \
      || fail "without $TRIGGER the plain UPDATE of assigned_to should not have moved the token, but session A saw $A_TOKEN where the row held $TOKEN_BEFORE"
    if [ -n "$B_ERR" ]; then
      fail "the un-remediated control REFUSED the reassignment ('$B_ERR'), so this gate proves nothing about the fix. Re-read the two barriers above: if B did not overlap A, the refusal is not the compare-and-set firing"
    fi
    [ -n "$B_OK" ] && [ "$B_EXIT" = "0" ] \
      || { dump_sessions; fail "session B neither raised nor reported a result, so the race outcome is unknown"; }
    case "$B_OK" in
      *'"unchanged":false'*|*'"unchanged": false'*) ;;
      *) fail "session B reported success without moving the lead: $B_OK" ;;
    esac
    [ "$owner_after_race" = "$THIRD" ] \
      || fail "session B reported success but the lead ended on $owner_after_race, not $THIRD; the control did not lose session A's transfer"
    [ "$th_after_race" = "1" ] && [ "$th_from_hijack" = "1" ] \
      || fail "expected exactly one transfer_history row, recording a transfer from $HIJACK to $THIRD, and saw $th_after_race row(s) of which $th_from_hijack match; the audit consequence is part of the finding and it was not reproduced"
    [ "$th_from_owner" = "0" ] \
      || fail "transfer_history holds $th_from_owner row(s) from $OWNER; the boss's committed transfer was supposed to be unrecorded, so this gate is not measuring the writer it thinks it is"
    [ "$act_after_race" = "1" ] && [ "$be_after_race" = "1" ] && [ "$notif_after_race" = "1" ] && [ "$key_after_race" = "1" ] \
      || fail "the committed reassignment did not write one row each into activities/business_events/notifications/lead_mutation_requests ($act_after_race/$be_after_race/$notif_after_race/$key_after_race)"
    # Probe 4. The token did not move, so the unassign's own comparison is decorative
    # for the same reason the routine's is, and it discards a committed transfer
    # without even the audit row the routine would have left.
    [ "$D_ROWS" = "1" ] \
      || fail "without $TRIGGER the unassign should have matched the row with a token that predates session C's committed transfer, but it matched $D_ROWS. The control is not the state this release starts from"
    [ "$owner_after_unassign" = "<null>" ] \
      || fail "the unassign matched the row but the lead reads back as $owner_after_unassign instead of unassigned"
    [ "$unassign_replay_rows" = "1" ] \
      || fail "without $TRIGGER the replayed unassign should have matched again (nothing moved the token), but it matched $unassign_replay_rows"
    echo "  REPRODUCED (probe 4): the unassign settings.ts sends waited on session C's row lock and then matched anyway, discarding the transfer to $HIJACK that C had committed — and since a plain UPDATE writes no transfer_history row, transfer_history stayed at $th_after_unassign and there is no record that either write happened. Replaying the same statement matched a second time, so a retry is a fresh write rather than a no-op."
    echo "  REPRODUCED: leads.updated_at is not server-owned, so the compare-and-set is decorative. The owner pinned the token to $PINNED_AS_TEXT and it stayed; the boss's plain UPDATE of assigned_to left it at $TOKEN_BEFORE; and an admin holding that pre-transfer token waited on the row lock and then committed a reassignment anyway, discarding the boss's transfer to $HIJACK with nobody told. The only audit row left says the lead went from $HIJACK to $THIRD — a hand-off the admin never saw and did not compare against — and the transfer the boss did commit, $OWNER to $HIJACK, is recorded nowhere."
    ;;
  baseline_guarded|guarded)
    [ "$token_after_pin" != "$PINNED_AS_TEXT" ] \
      || fail "$TRIGGER is installed but the owning salesperson's chosen updated_at ($PINNED_AS_TEXT) survived a read-after-write; the column is still client-owned"
    [ "$(q "select ('$token_after_pin'::timestamptz > '$PINNED'::timestamptz)::text")" = "true" ] \
      || fail "$TRIGGER replaced the pinned token with $token_after_pin, which is not later than the $PINNED_AS_TEXT the client asked for; a stamp that can move the token backwards is not a stamp"
    [ "$A_TOKEN" != "$TOKEN_BEFORE" ] \
      || fail "$TRIGGER is installed but session A's plain UPDATE of assigned_to — the statement settings.ts sends — left the token at $TOKEN_BEFORE, so a writer that does not name updated_at still does not move it"
    [ -n "$B_ERR" ] \
      || { dump_sessions; fail "the reassignment was NOT refused after a concurrent committed transfer (session B reported '$B_OK'); the compare-and-set did not fire"; }
    case "$B_ERR" in
      "err|P0001|"*) ;;
      *) fail "the reassignment was refused, but not by the compare-and-set: expected SQLSTATE P0001, got '$B_ERR'" ;;
    esac
    case "$B_ERR" in
      *CONCURRENT_LEAD_UPDATE*) ;;
      *) fail "the reassignment was refused with P0001 but not for the stated reason — expected CONCURRENT_LEAD_UPDATE, got '$B_ERR'" ;;
    esac
    { [ -n "$B_EXIT" ] && [ "$B_EXIT" != "0" ]; } \
      || fail "the reassignment raised CONCURRENT_LEAD_UPDATE but the client session exited '$B_EXIT'; a refusal the caller does not see as a failure is not a refusal"
    [ -z "$B_OK" ] \
      || fail "the reassignment raised CONCURRENT_LEAD_UPDATE and ALSO returned a result ('$B_OK'), so something in this session committed"
    [ "$owner_after_race" = "$HIJACK" ] \
      || fail "the reassignment was refused but the lead ended on $owner_after_race instead of the $HIJACK session A committed"
    [ "$th_from_hijack" = "0" ] && [ "$th_from_owner" = "0" ] \
      || fail "the refused reassignment still recorded transfer history ($th_from_hijack from $HIJACK, $th_from_owner from $OWNER)"
    [ "$th_after_race" = "0" ] \
      || fail "the refused reassignment still wrote $th_after_race transfer_history row(s); the routine is not atomic"
    [ "$act_after_race" = "0" ] && [ "$be_after_race" = "0" ] && [ "$notif_after_race" = "0" ] && [ "$key_after_race" = "0" ] \
      || fail "the refused reassignment left rows in activities/business_events/notifications/lead_mutation_requests ($act_after_race/$be_after_race/$notif_after_race/$key_after_race)"
    # Probe 4. Same trigger, a statement instead of a routine: the WHERE is checked
    # against the row version that committed while the statement was waiting, so the
    # stale token matches nothing and the caller is told the truth.
    [ "$D_ROWS" = "0" ] \
      || fail "$TRIGGER is installed but the unassign, holding a token that predates session C's committed transfer, still matched $D_ROWS row(s); the comparison in the WHERE clause did not fire"
    [ "$owner_after_unassign" = "$HIJACK" ] \
      || fail "the unassign matched nothing but the lead ended on $owner_after_unassign instead of the $HIJACK session C committed"
    [ "$unassign_replay_rows" = "0" ] \
      || fail "$TRIGGER is installed but replaying the spent unassign matched $unassign_replay_rows row(s) instead of nothing, so the statement is not a compare-and-set on reentry"
    echo "  GUARDED (probe 4): the CAS predicate holds. Session D waited on C's row lock and then matched ZERO rows — the token was re-evaluated against C's committed version, not the one D was planned on — so the lead stayed on $HIJACK and reads back still assigned. A fresh token then unassigned it ($unassign_ok_rows row), replay matched nothing, and rollback left no change."
    if [ "$EXPECT" = baseline_guarded ]; then
      echo "  REFUTED ON CAPTURED PRODUCTION SHAPE: with $TRIGGER removed, $OTHER_STAMP_TRIGGERS pre-existing production trigger(s) still made leads.updated_at server-owned. The pinned token was overwritten, the boss's plain UPDATE moved it from $TOKEN_BEFORE to $A_TOKEN, and the stale concurrent RPC raised CONCURRENT_LEAD_UPDATE with no audit/idempotency residue."
    else
      echo "  CLOSED: leads.updated_at is server-owned. The owner's pinned token was overwritten, the boss's plain UPDATE of assigned_to moved it from $TOKEN_BEFORE to $A_TOKEN even though the statement never named the column, and the admin's call — holding the pre-transfer token, waiting on the same row lock — raised CONCURRENT_LEAD_UPDATE. The lead stayed where the boss put it, $HIJACK, and no audit row, notification or idempotency record was written for the transfer that did not happen."
    fi
    ;;
esac
