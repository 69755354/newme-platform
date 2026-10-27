#!/usr/bin/env bash
# PG17 behaviour gate for 20260817210000.
#
# The gate is intentionally stateful and then self-cleaning. It proves:
#   * migration re-entry waits for an in-flight quotation INSERT before deriving
#     the sequence floor, and a >bigint poison suffix cannot abort initialization;
#   * overlapping quotation INSERTs receive distinct database-owned numbers and
#     the assigned number cannot be rewritten later;
#   * reassignment rejects a NULL token, serializes a concurrent same-key replay,
#     and refuses reuse of that key for another assignee;
#   * unassignment has the same replay binding, writes all three audit ledgers
#     once, enforces CAS, rejects a non-privileged caller, and rolls back fully.
set -euo pipefail

: "${EXPECT:?EXPECT must be 'fixed'}"
[ "$EXPECT" = fixed ] || { echo "quote/unassignment gate: EXPECT must be 'fixed', got '$EXPECT'" >&2; exit 1; }

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=postgres}"
export PGHOST PGPORT PGUSER PGDATABASE

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20260817210000_quote_number_and_lead_unassignment_integrity.sql"

ADMIN='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
OWNER='cccccccc-cccc-cccc-cccc-cccccccccccc'
TARGET='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
FIXTURE_LEAD='66666666-6666-6666-6666-666666666666'
LEAD_A='25252525-2525-4525-8525-252525252525'
LEAD_B='26262626-2626-4626-8626-262626262626'
LEAD_C='27272727-2727-4727-8727-272727272727'
QUOTE_HIGH='25111111-1111-4111-8111-111111111111'
QUOTE_POISON='25222222-2222-4222-8222-222222222222'
QUOTE_REENTRY='25333333-3333-4333-8333-333333333333'
QUOTE_A='25444444-4444-4444-8444-444444444444'
QUOTE_B='25555555-5555-4555-8555-555555555555'
REASSIGN_KEY='25000000-0000-4000-8000-000000000001'
NULL_KEY='25000000-0000-4000-8000-000000000002'
UNASSIGN_KEY='25000000-0000-4000-8000-000000000003'
STALE_KEY='25000000-0000-4000-8000-000000000004'
FORBIDDEN_KEY='25000000-0000-4000-8000-000000000005'
ROLLBACK_KEY='25000000-0000-4000-8000-000000000006'

work_dir="$(mktemp -d)"
trigger_restore_needed=0
PIDS=()

fail() {
  echo "quote/unassignment integrity gate failed: $*" >&2
  exit 1
}

q() {
  psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 -c "$1" | tr -d '\r' | head -1
}

run_file() {
  local file="$1" log="$2"
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 -f "$file" >"$log" 2>&1
}

claims_sql() {
  local actor="$1"
  printf "%s" "select set_config('request.jwt.claims', json_build_object('sub', '$actor', 'role', 'authenticated', 'iat', floor(extract(epoch from now()))::bigint)::text, true);"
}

rpc_attempt() {
  local actor="$1" statement="$2" label="$3"
  local sql="$work_dir/attempt.sql" log="$work_dir/attempt.log"
  {
    echo '\set VERBOSITY verbose'
    echo 'begin;'
    claims_sql "$actor"
    echo
    echo 'set local role authenticated;'
    echo "$statement"
    echo 'commit;'
  } >"$sql"
  : >"$log"
  psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 \
    -f "$sql" >"$log" 2>&1 || true
  local err
  err="$(sed -n 's/.*ERROR:  \([0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z]\): \(.*\)$/err|\1|\2/p' "$log" | head -1)"
  if [ -n "$err" ]; then
    printf '%s\n' "$err"
  else
    printf 'ok|%s\n' "$(tr -d '\r' <"$log" | tr '\n' ' ')"
  fi
}

expect_error() {
  local got="$1" needle="$2" label="$3"
  case "$got" in
    err\|*\|*"$needle"*) ;;
    *) fail "$label: expected an error containing '$needle', got '$got'" ;;
  esac
}

cleanup_rows() {
  cat >"$work_dir/cleanup.sql" <<SQL
begin;
delete from public.notifications where related_id in ('$LEAD_A', '$LEAD_B', '$LEAD_C');
delete from public.transfer_history where lead_id in ('$LEAD_A', '$LEAD_B', '$LEAD_C');
delete from public.activities where lead_id in ('$LEAD_A', '$LEAD_B', '$LEAD_C');
delete from public.business_events where lead_id in ('$LEAD_A', '$LEAD_B', '$LEAD_C');
delete from public.audit_logs where target_id in ('$LEAD_A', '$LEAD_B', '$LEAD_C');
delete from public.lead_mutation_requests where lead_id in ('$LEAD_A', '$LEAD_B', '$LEAD_C');
delete from public.quotations where id in ('$QUOTE_HIGH', '$QUOTE_POISON', '$QUOTE_REENTRY', '$QUOTE_A', '$QUOTE_B');
delete from public.leads where id in ('$LEAD_A', '$LEAD_B', '$LEAD_C');
commit;
SQL
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 -f "$work_dir/cleanup.sql" >/dev/null 2>&1 || true
}

cleanup() {
  local status=$?
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && wait "$pid" 2>/dev/null || true
  done
  if [ "$trigger_restore_needed" = 1 ]; then
    psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction \
      -f "$MIGRATION" >/dev/null 2>&1 || \
      echo "quote/unassignment gate: COULD NOT RESTORE migration after failure" >&2
  fi
  cleanup_rows
  case "$work_dir" in
    /tmp/*) rm -rf -- "$work_dir" ;;
    *) echo "quote/unassignment gate: refusing to remove unexpected temp path $work_dir" >&2 ;;
  esac
  return "$status"
}
trap cleanup EXIT

command -v psql >/dev/null 2>&1 || fail 'psql not found on PATH'
[ -f "$MIGRATION" ] || fail "missing $MIGRATION"
[ "$(q 'show server_version_num')" -ge 170000 ] || fail 'this gate requires PostgreSQL 17'

for routine in \
  'public.reassign_lead_atomic(uuid,uuid,timestamptz,uuid,text)' \
  'public.unassign_lead_atomic(uuid,timestamptz,uuid,text)' \
  'public.allocate_quote_no()' \
  'public.quotations_assign_quote_no()'; do
  [ "$(q "select count(*) from pg_proc where oid = to_regprocedure('$routine')")" = 1 ] \
    || fail "$routine is not installed"
done
for actor in "$ADMIN" "$OWNER" "$TARGET"; do
  [ "$(q "select count(*) from public.profiles where id='$actor' and coalesce(is_active,false)")" = 1 ] \
    || fail "required synthetic profile $actor is missing or inactive"
done
cleanup_rows

# ---------------------------------------------------------------------------
# Re-entry and initialization lock. The writer inserts a valid high suffix and a
# numeric suffix too large for bigint while holding RowExclusiveLock. Re-applying
# the migration must wait, then include only the valid committed suffix.
# ---------------------------------------------------------------------------
last="$(q "select last_value from public.quotation_number_seq")"
# Exercise the safe 19-digit bigint path as well as ordinary re-entry. Subsequent
# runs keep moving from the already-established floor.
if [ "$last" -lt 1000000000000000000 ]; then
  high=1000000000000000000
else
  high=$((last + 1000))
fi
high_no="NM-2099-$high"
poison_no='NM-2099-9999999999999999999999999999999999999999'

psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 \
  -c 'drop trigger aa_quotations_assign_quote_no on public.quotations' >/dev/null
trigger_restore_needed=1

cat >"$work_dir/init-writer.sql" <<SQL
set application_name = 'quote_integrity_init_writer';
begin;
insert into public.quotations (id, lead_id, quote_no, status, subtotal, total_amount, created_by)
values
  ('$QUOTE_HIGH', '$FIXTURE_LEAD', '$high_no', 'draft', 1, 1, '$ADMIN'),
  ('$QUOTE_POISON', '$FIXTURE_LEAD', '$poison_no', 'draft', 1, 1, '$ADMIN');
select pg_sleep(4);
commit;
SQL
run_file "$work_dir/init-writer.sql" "$work_dir/init-writer.log" &
writer_pid=$!
PIDS+=("$writer_pid")

ready=0
for _ in $(seq 1 100); do
  if [ "$(q "select count(*) from pg_stat_activity where application_name='quote_integrity_init_writer' and state='active'")" = 1 ]; then
    ready=1
    break
  fi
  sleep 0.05
done
[ "$ready" = 1 ] || fail 'the initialization writer never reached its open transaction'

PGAPPNAME=quote_integrity_reentry psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 \
  --single-transaction -f "$MIGRATION" >"$work_dir/reentry.log" 2>&1 &
reentry_pid=$!
PIDS+=("$reentry_pid")

blocked=0
for _ in $(seq 1 100); do
  if [ "$(q "select count(*) from pg_stat_activity where application_name='quote_integrity_reentry' and wait_event_type='Lock'")" = 1 ]; then
    blocked=1
    break
  fi
  sleep 0.05
done
[ "$blocked" = 1 ] || fail 'migration re-entry did not wait on the in-flight quotation INSERT'

wait "$writer_pid" || { cat "$work_dir/init-writer.log" >&2; fail 'initialization writer failed'; }
wait "$reentry_pid" || { cat "$work_dir/reentry.log" >&2; fail 'migration re-entry failed after the writer committed'; }
PIDS=()
trigger_restore_needed=0

[ "$(q "select count(*) from public.quotations where id='$QUOTE_POISON' and quote_no='$poison_no'")" = 1 ] \
  || fail 'the malformed stored suffix fixture did not survive to exercise re-entry'
[ "$(q "select count(*) from pg_trigger where tgrelid='public.quotations'::regclass and tgname='aa_quotations_assign_quote_no' and tgenabled='O'")" = 1 ] \
  || fail 'migration re-entry did not restore the quote allocator trigger'

generated="$(q "insert into public.quotations (id,lead_id,quote_no,status,subtotal,total_amount,created_by) values ('$QUOTE_REENTRY','$FIXTURE_LEAD','caller-value','draft',1,1,'$ADMIN') returning quote_no")"
case "$generated" in NM-[0-9][0-9][0-9][0-9]-[0-9]*) ;; *) fail "re-entry generated malformed quote number '$generated'" ;; esac
suffix="${generated##*-}"
[ "$suffix" -gt "$high" ] || fail "re-entry allocated suffix $suffix at or below committed floor $high"

# ---------------------------------------------------------------------------
# Two overlapping INSERT transactions. Caller-provided values must be replaced
# and the committed numbers must be distinct.
# ---------------------------------------------------------------------------
cat >"$work_dir/quote-a.sql" <<SQL
begin;
insert into public.quotations (id,lead_id,quote_no,status,subtotal,total_amount,created_by)
values ('$QUOTE_A','$FIXTURE_LEAD','submitted-a','draft',1,1,'$ADMIN');
select pg_sleep(2);
commit;
SQL
cat >"$work_dir/quote-b.sql" <<SQL
begin;
insert into public.quotations (id,lead_id,quote_no,status,subtotal,total_amount,created_by)
values ('$QUOTE_B','$FIXTURE_LEAD','submitted-b','draft',1,1,'$ADMIN');
commit;
SQL
run_file "$work_dir/quote-a.sql" "$work_dir/quote-a.log" & qa=$!; PIDS+=("$qa")
sleep 0.2
run_file "$work_dir/quote-b.sql" "$work_dir/quote-b.log" & qb=$!; PIDS+=("$qb")
wait "$qa" || { cat "$work_dir/quote-a.log" >&2; fail 'concurrent quote A failed'; }
wait "$qb" || { cat "$work_dir/quote-b.log" >&2; fail 'concurrent quote B failed'; }
PIDS=()
[ "$(q "select count(distinct quote_no) from public.quotations where id in ('$QUOTE_A','$QUOTE_B')")" = 2 ] \
  || fail 'overlapping quotation INSERTs did not receive two unique numbers'
[ "$(q "select count(*) from public.quotations where id in ('$QUOTE_A','$QUOTE_B') and quote_no ~ '^NM-[0-9]{4}-[0-9]+$' and quote_no not in ('submitted-a','submitted-b')")" = 2 ] \
  || fail 'quotation INSERT preserved caller-controlled or malformed numbers'
if psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 \
  -c "update public.quotations set quote_no='rewritten-by-caller' where id='$QUOTE_A'" \
  >"$work_dir/quote-update.log" 2>&1; then
  fail 'quotation quote_no remained caller-writable after INSERT'
fi
grep -q 'QUOTE_NUMBER_IS_DATABASE_OWNED' "$work_dir/quote-update.log" \
  || { cat "$work_dir/quote-update.log" >&2; fail 'quotation quote_no rewrite failed for an unrelated reason'; }
[ "$(q "select count(*) from public.quotations where id='$QUOTE_A' and quote_no <> 'rewritten-by-caller'")" = 1 ] \
  || fail 'failed quote_no rewrite changed the stored database-owned number'

# Synthetic leads for the RPC probes.
psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into public.leads (id,assigned_to,stage,customer_name,source,transfer_candidate)
values
  ('$LEAD_A','$OWNER','new','Replay DB integrity A','other',true),
  ('$LEAD_B','$OWNER','new','Replay DB integrity B','other',true),
  ('$LEAD_C','$OWNER','new','Replay DB integrity C','other',true);
SQL
token_a="$(q "select updated_at from public.leads where id='$LEAD_A'")"

got="$(rpc_attempt "$ADMIN" "select public.reassign_lead_atomic('$LEAD_A','$TARGET',null,'$NULL_KEY','null token');" 'reassign NULL token')"
expect_error "$got" 'MISSING_EXPECTED_UPDATED_AT' 'reassign NULL token'
[ "$(q "select count(*) from public.lead_mutation_requests where idempotency_key='$NULL_KEY'")" = 0 ] \
  || fail 'NULL-token reassignment recorded an idempotency row'

# Concurrent same-key reassignment. A sleeps after the function while holding the
# advisory lock; B must wait and then return the recorded response.
cat >"$work_dir/reassign-a.sql" <<SQL
begin;
$(claims_sql "$ADMIN")
set local role authenticated;
select public.reassign_lead_atomic('$LEAD_A','$TARGET','$token_a','$REASSIGN_KEY','concurrent reassign');
select pg_sleep(2);
commit;
SQL
cat >"$work_dir/reassign-b.sql" <<SQL
begin;
$(claims_sql "$ADMIN")
set local role authenticated;
select public.reassign_lead_atomic('$LEAD_A','$TARGET','$token_a','$REASSIGN_KEY','concurrent reassign');
commit;
SQL
run_file "$work_dir/reassign-a.sql" "$work_dir/reassign-a.log" & ra=$!; PIDS+=("$ra")
sleep 0.2
run_file "$work_dir/reassign-b.sql" "$work_dir/reassign-b.log" & rb=$!; PIDS+=("$rb")
wait "$ra" || { cat "$work_dir/reassign-a.log" >&2; fail 'concurrent reassignment A failed'; }
wait "$rb" || { cat "$work_dir/reassign-b.log" >&2; fail 'concurrent reassignment B failed'; }
PIDS=()
grep -q '"idempotent_replay": true' "$work_dir/reassign-b.log" \
  || { cat "$work_dir/reassign-b.log" >&2; fail 'second same-key reassignment was not an idempotent replay'; }
[ "$(q "select count(*) from public.transfer_history where lead_id='$LEAD_A'")" = 1 ] || fail 'reassignment transfer history is not exactly-once'
[ "$(q "select count(*) from public.activities where lead_id='$LEAD_A' and type='transfer'")" = 1 ] || fail 'reassignment activity is not exactly-once'
[ "$(q "select count(*) from public.business_events where lead_id='$LEAD_A' and event_type='transfer'")" = 1 ] || fail 'reassignment business event is not exactly-once'
[ "$(q "select count(*) from public.notifications where related_id='$LEAD_A' and type='lead_assigned'")" = 1 ] || fail 'reassignment notification is not exactly-once'
[ "$(q "select count(*) from public.lead_mutation_requests where lead_id='$LEAD_A' and operation='lead_reassignment'")" = 1 ] || fail 'reassignment request record is not exactly-once'

token_a_after="$(q "select updated_at from public.leads where id='$LEAD_A'")"
got="$(rpc_attempt "$ADMIN" "select public.reassign_lead_atomic('$LEAD_A','$OWNER','$token_a_after','$REASSIGN_KEY','concurrent reassign');" 'reassign key binding')"
expect_error "$got" 'IDEMPOTENCY_KEY_REUSED_FOR_DIFFERENT_REQUEST' 'reassign key binding'

# A sales caller has EXECUTE but not the product role required by the function.
got="$(rpc_attempt "$OWNER" "select public.unassign_lead_atomic('$LEAD_A','$token_a_after','$FORBIDDEN_KEY','forbidden');" 'unassign role')"
expect_error "$got" 'FORBIDDEN_UNASSIGNMENT' 'unassign role'

# Concurrent same-key unassignment, then replay/binding and audit counts.
cat >"$work_dir/unassign-a.sql" <<SQL
begin;
$(claims_sql "$ADMIN")
set local role authenticated;
select public.unassign_lead_atomic('$LEAD_A','$token_a_after','$UNASSIGN_KEY','concurrent unassign');
select pg_sleep(2);
commit;
SQL
cat >"$work_dir/unassign-b.sql" <<SQL
begin;
$(claims_sql "$ADMIN")
set local role authenticated;
select public.unassign_lead_atomic('$LEAD_A','$token_a_after','$UNASSIGN_KEY','concurrent unassign');
commit;
SQL
run_file "$work_dir/unassign-a.sql" "$work_dir/unassign-a.log" & ua=$!; PIDS+=("$ua")
sleep 0.2
run_file "$work_dir/unassign-b.sql" "$work_dir/unassign-b.log" & ub=$!; PIDS+=("$ub")
wait "$ua" || { cat "$work_dir/unassign-a.log" >&2; fail 'concurrent unassignment A failed'; }
wait "$ub" || { cat "$work_dir/unassign-b.log" >&2; fail 'concurrent unassignment B failed'; }
PIDS=()
grep -q '"idempotent_replay": true' "$work_dir/unassign-b.log" \
  || { cat "$work_dir/unassign-b.log" >&2; fail 'second same-key unassignment was not an idempotent replay'; }
[ "$(q "select count(*) from public.leads where id='$LEAD_A' and assigned_to is null")" = 1 ] || fail 'unassignment did not clear assigned_to'
[ "$(q "select count(*) from public.audit_logs where target_id='$LEAD_A' and action='lead_unassigned'")" = 1 ] || fail 'unassignment audit_logs row is not exactly-once'
[ "$(q "select count(*) from public.activities where lead_id='$LEAD_A' and type='transfer' and content like 'Lead unassigned from %'")" = 1 ] || fail 'unassignment activity row is not exactly-once'
[ "$(q "select count(*) from public.business_events where lead_id='$LEAD_A' and description='Lead unassigned'")" = 1 ] || fail 'unassignment business event is not exactly-once'
[ "$(q "select count(*) from public.lead_mutation_requests where lead_id='$LEAD_A' and operation='lead_unassignment'")" = 1 ] || fail 'unassignment request record is not exactly-once'
[ "$(q "select count(*) from public.transfer_history where lead_id='$LEAD_A'")" = 1 ] || fail 'unassignment forged a transfer_history target'

token_a_final="$(q "select updated_at from public.leads where id='$LEAD_A'")"
got="$(rpc_attempt "$ADMIN" "select public.unassign_lead_atomic('$LEAD_A','$token_a_final','$UNASSIGN_KEY','different reason');" 'unassign key binding')"
expect_error "$got" 'IDEMPOTENCY_KEY_REUSED_FOR_DIFFERENT_REQUEST' 'unassign key binding'

# CAS refusal after a committed concurrent update, with no audit/request residue.
token_b="$(q "select updated_at from public.leads where id='$LEAD_B'")"
psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 -c "update public.leads set transfer_candidate=false where id='$LEAD_B'" >/dev/null
got="$(rpc_attempt "$ADMIN" "select public.unassign_lead_atomic('$LEAD_B','$token_b','$STALE_KEY','stale token');" 'unassign stale token')"
expect_error "$got" 'CONCURRENT_LEAD_UPDATE' 'unassign stale token'
[ "$(q "select count(*) from public.leads where id='$LEAD_B' and assigned_to='$OWNER'")" = 1 ] || fail 'stale-token refusal changed the lead owner'
[ "$(q "select count(*) from public.lead_mutation_requests where idempotency_key='$STALE_KEY'")" = 0 ] || fail 'stale-token refusal recorded a request'
[ "$(q "select count(*) from public.audit_logs where target_id='$LEAD_B' and action='lead_unassigned'")" = 0 ] || fail 'stale-token refusal wrote audit evidence'

# The RPC participates in the caller transaction: rolling the transaction back
# must undo lead, audit and idempotency writes together.
token_c="$(q "select updated_at from public.leads where id='$LEAD_C'")"
cat >"$work_dir/rollback.sql" <<SQL
begin;
$(claims_sql "$ADMIN")
set local role authenticated;
select public.unassign_lead_atomic('$LEAD_C','$token_c','$ROLLBACK_KEY','rollback probe');
rollback;
SQL
run_file "$work_dir/rollback.sql" "$work_dir/rollback.log" \
  || { cat "$work_dir/rollback.log" >&2; fail 'rollback probe call failed before ROLLBACK'; }
[ "$(q "select count(*) from public.leads where id='$LEAD_C' and assigned_to='$OWNER'")" = 1 ] || fail 'rolled-back unassignment changed the lead owner'
[ "$(q "select count(*) from public.lead_mutation_requests where idempotency_key='$ROLLBACK_KEY'")" = 0 ] || fail 'rolled-back unassignment retained its request key'
[ "$(q "select count(*) from public.audit_logs where target_id='$LEAD_C' and action='lead_unassigned'")" = 0 ] || fail 'rolled-back unassignment retained audit_logs'
[ "$(q "select count(*) from public.activities where lead_id='$LEAD_C' and content like 'Lead unassigned from %'")" = 0 ] || fail 'rolled-back unassignment retained activities'
[ "$(q "select count(*) from public.business_events where lead_id='$LEAD_C' and description='Lead unassigned'")" = 0 ] || fail 'rolled-back unassignment retained business_events'

echo '  quote allocation: initialization lock, poison tolerance, re-entry and concurrent uniqueness OK'
echo '  reassignment: mandatory token, request binding and concurrent idempotency OK'
echo '  unassignment: role/CAS, request binding, exact audit writes and rollback OK'
