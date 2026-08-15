#!/usr/bin/env bash
# PG17 behavior gate for 20260817230000_lead_rebalance_plan_idempotency.sql.
#
# Proves the plan is immutable per actor/batch under a real two-session race,
# rollback leaves no ghost, empty plans replay, invalid callers and shapes fail
# closed, the table is read-only even to service_role, and every fixture/lock is
# removed before the gate returns.
set -euo pipefail

: "${EXPECT:?EXPECT must be 'fixed'}"
[ "$EXPECT" = fixed ] || { echo "rebalance plan gate: EXPECT must be 'fixed', got '$EXPECT'" >&2; exit 1; }

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=postgres}"
export PGHOST PGPORT PGUSER PGDATABASE

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20260817230000_lead_rebalance_plan_idempotency.sql"
ADMIN='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
BOSS='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
SALES='cccccccc-cccc-cccc-cccc-cccccccccccc'
TARGET='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
LEAD_A='27111111-1111-4111-8111-111111111111'
LEAD_B='27222222-2222-4222-8222-222222222222'
BATCH_RACE='27333333-3333-4333-8333-333333333333'
BATCH_ROLLBACK='27444444-4444-4444-8444-444444444444'
BATCH_EMPTY='27555555-5555-4555-8555-555555555555'
BATCH_INVALID='27666666-6666-4666-8666-666666666666'
KEY_A='27777777-7777-4777-8777-777777777777'
KEY_B='27888888-8888-4888-8888-888888888888'
TOKEN_A='2026-08-15T00:00:00+00:00'
TOKEN_B='2026-08-15T00:00:01+00:00'
MARK_HI=927423
MARK_LO=1723
BARRIER_TIMEOUT="${BARRIER_TIMEOUT:-60}"

PLAN_A="{\"updates\":[{\"id\":\"$LEAD_A\",\"assigned_to\":\"$TARGET\",\"expected_updated_at\":\"$TOKEN_A\",\"idempotency_key\":\"$KEY_A\"}],\"untokened_lead_ids\":[],\"source_ids\":[\"$SALES\"],\"target_ids\":[\"$TARGET\"]}"
PLAN_B="{\"updates\":[{\"id\":\"$LEAD_B\",\"assigned_to\":\"$TARGET\",\"expected_updated_at\":\"$TOKEN_B\",\"idempotency_key\":\"$KEY_B\"}],\"untokened_lead_ids\":[],\"source_ids\":[\"$SALES\"],\"target_ids\":[\"$TARGET\"]}"
PLAN_EMPTY='{"updates":[],"untokened_lead_ids":[],"source_ids":[],"target_ids":[]}'

work_dir="$(mktemp -d)"
fifo_a="$work_dir/session_a.in"
out_a="$work_dir/session_a.log"
out_b="$work_dir/session_b.log"
pid_a=
pid_b=

fail() {
  echo "rebalance plan idempotency gate failed: $*" >&2
  for log in "$out_a" "$out_b" "$work_dir"/*.log; do
    if [ -f "$log" ]; then
      echo "--- $(basename "$log") ---" >&2
      cat "$log" >&2
    fi
  done
  exit 1
}

q() {
  psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 -c "$1" \
    | tr -d '\r[:space:]'
}

claims_sql() {
  local actor="$1" iat="${2:-current}"
  if [ "$iat" = current ]; then
    iat='floor(extract(epoch from now()))::bigint'
  fi
  printf "%s" "do \$claims\$ begin perform set_config('request.jwt.claims', json_build_object('sub', '$actor', 'role', 'authenticated', 'iat', $iat)::text, true); end \$claims\$;"
}

cleanup() {
  local status=$?
  set +e
  [ -n "$pid_b" ] && kill "$pid_b" 2>/dev/null
  [ -n "$pid_a" ] && kill "$pid_a" 2>/dev/null
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 -c "
    delete from public.lead_rebalance_batches
     where batch_key in ('$BATCH_RACE', '$BATCH_ROLLBACK', '$BATCH_EMPTY', '$BATCH_INVALID');
    select pg_advisory_unlock($MARK_HI, $MARK_LO);
  " >/dev/null 2>&1
  case "$work_dir" in
    /tmp/*) rm -rf -- "$work_dir" ;;
    *) echo "rebalance plan gate: refusing to remove unexpected temp path $work_dir" >&2 ;;
  esac
  return "$status"
}
trap cleanup EXIT

command -v psql >/dev/null 2>&1 || fail 'psql not found on PATH'
[ -f "$MIGRATION" ] || fail "missing $MIGRATION"
[ "$(q 'show server_version_num')" -ge 170000 ] || fail 'this gate requires PostgreSQL 17'
expected_a="$(q "select md5('$PLAN_A'::jsonb::text)")"

for actor in "$ADMIN" "$BOSS" "$SALES" "$TARGET"; do
  [ "$(q "select count(*) from public.profiles where id='$actor'")" = 1 ] \
    || fail "required synthetic profile $actor is missing"
done

psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 -f "$MIGRATION" >"$work_dir/reentry.log" 2>&1 \
  || fail 'migration re-entry failed'

shape="$(q "
  select concat_ws(':',
    c.relrowsecurity::text,
    c.relforcerowsecurity::text,
    (exists (select 1 from pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) x where x.grantee=0))::text,
    (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert') or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete') or has_table_privilege('anon', c.oid, 'truncate') or has_table_privilege('anon', c.oid, 'references') or has_table_privilege('anon', c.oid, 'trigger') or has_table_privilege('anon', c.oid, 'maintain'))::text,
    (has_table_privilege('authenticated', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'insert') or has_table_privilege('authenticated', c.oid, 'update') or has_table_privilege('authenticated', c.oid, 'delete') or has_table_privilege('authenticated', c.oid, 'truncate') or has_table_privilege('authenticated', c.oid, 'references') or has_table_privilege('authenticated', c.oid, 'trigger') or has_table_privilege('authenticated', c.oid, 'maintain'))::text,
    has_table_privilege('service_role', 'public.lead_rebalance_batches', 'SELECT')::text,
    (has_table_privilege('service_role', c.oid, 'insert') or has_table_privilege('service_role', c.oid, 'update') or has_table_privilege('service_role', c.oid, 'delete') or has_table_privilege('service_role', c.oid, 'truncate') or has_table_privilege('service_role', c.oid, 'references') or has_table_privilege('service_role', c.oid, 'trigger') or has_table_privilege('service_role', c.oid, 'maintain'))::text,
    has_function_privilege('authenticated', 'public.get_or_create_lead_rebalance_plan(uuid,jsonb)', 'EXECUTE')::text,
    has_function_privilege('anon', 'public.get_or_create_lead_rebalance_plan(uuid,jsonb)', 'EXECUTE')::text,
    has_function_privilege('service_role', 'public.get_or_create_lead_rebalance_plan(uuid,jsonb)', 'EXECUTE')::text,
    (select count(*) = 1 from pg_trigger where tgrelid='public.lead_rebalance_batches'::regclass and tgname='trg_require_current_session' and not tgisinternal and tgenabled='O' and (tgtype & 1)=0 and (tgtype & 2)=2 and (tgtype & 28)=28 and tgattr::text='' and tgqual is null)::text
  )
    from pg_class c where c.oid='public.lead_rebalance_batches'::regclass;
")"
[ "$shape" = 'true:true:false:false:false:true:false:true:false:false:true' ] \
  || fail "catalog/RLS/ACL shape was $shape"

if psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 -c \
  "set role service_role; insert into public.lead_rebalance_batches(actor_id,batch_key,plan) values ('$ADMIN','$BATCH_INVALID','$PLAN_EMPTY'::jsonb);" \
  >"$work_dir/service-write.log" 2>&1; then
  fail 'service_role wrote the immutable plan table'
fi
grep -qi 'permission denied for table lead_rebalance_batches' "$work_dir/service-write.log" \
  || fail 'service_role write refusal did not name table permission'

if psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 -c \
  "set role anon; select public.get_or_create_lead_rebalance_plan('$BATCH_INVALID', null);" \
  >"$work_dir/anon.log" 2>&1; then
  fail 'anon executed the authenticated-only plan RPC'
fi
grep -qi 'permission denied for function get_or_create_lead_rebalance_plan' "$work_dir/anon.log" \
  || fail 'anon refusal did not name function permission'

absent="$(q "begin; $(claims_sql "$ADMIN") set local role authenticated; select public.get_or_create_lead_rebalance_plan('$BATCH_RACE', null)->>'found'; rollback;")"
[ "$absent" = 'false' ] || fail "missing-plan lookup returned $absent"

# Session A stores PLAN_A but keeps its transaction open. Its independent marker
# is the barrier proving the RPC completed before session B starts.
mkfifo "$fifo_a"
PGAPPNAME='rebalance-plan-a' psql --no-psqlrc --quiet --no-align --tuples-only \
  -v ON_ERROR_STOP=1 <"$fifo_a" >"$out_a" 2>&1 &
pid_a=$!
exec 3>"$fifo_a"
cat >&3 <<SQL
begin;
$(claims_sql "$ADMIN")
set local role authenticated;
select md5((public.get_or_create_lead_rebalance_plan('$BATCH_RACE', '$PLAN_A'::jsonb)->'plan')::text);
select pg_advisory_lock($MARK_HI, $MARK_LO);
SQL

deadline=$((SECONDS + BARRIER_TIMEOUT))
while [ "$(q "select count(*) from pg_locks where locktype='advisory' and classid=$MARK_HI and objid=$MARK_LO and granted")" != 1 ]; do
  (( SECONDS < deadline )) || fail 'session A never reached the post-insert barrier'
  sleep 0.05
done

PGAPPNAME='rebalance-plan-b' psql --no-psqlrc --quiet --no-align --tuples-only \
  -v ON_ERROR_STOP=1 >"$out_b" 2>&1 <<SQL &
begin;
$(claims_sql "$ADMIN")
set local role authenticated;
select md5((public.get_or_create_lead_rebalance_plan('$BATCH_RACE', '$PLAN_B'::jsonb)->'plan')::text);
commit;
SQL
pid_b=$!

deadline=$((SECONDS + BARRIER_TIMEOUT))
while [ "$(q "select count(*) from pg_stat_activity where application_name='rebalance-plan-b' and wait_event_type='Lock'")" != 1 ]; do
  (( SECONDS < deadline )) || fail 'session B was never observed waiting on the first plan transaction'
  sleep 0.05
done

printf '%s\n' 'commit;' '\q' >&3
exec 3>&-
wait "$pid_a" || fail 'session A failed'
pid_a=
wait "$pid_b" || fail 'session B failed'
pid_b=

digest_a="$(tr -d '\r' <"$out_a" | grep -E '^[0-9a-f]{32}$' | head -1)"
digest_b="$(tr -d '\r' <"$out_b" | grep -E '^[0-9a-f]{32}$' | head -1)"
[ -n "$digest_a" ] && [ "$digest_a" = "$digest_b" ] \
  || fail "concurrent callers returned different plans: A=$digest_a B=$digest_b"
[ "$digest_a" = "$expected_a" ] \
  || fail "the first caller did not win the concurrent claim: expected=$expected_a actual=$digest_a"
[ "$(q "select count(*) from public.lead_rebalance_batches where actor_id='$ADMIN' and batch_key='$BATCH_RACE'")" = 1 ] \
  || fail 'concurrent callers did not leave exactly one batch row'
[ "$(q "select md5(plan::text) from public.lead_rebalance_batches where actor_id='$ADMIN' and batch_key='$BATCH_RACE'")" = "$digest_a" ] \
  || fail 'stored plan did not match the first caller result'

# The same batch UUID is independent per actor.
boss_digest="$(q "begin; $(claims_sql "$BOSS") set local role authenticated; select md5((public.get_or_create_lead_rebalance_plan('$BATCH_RACE', '$PLAN_B'::jsonb)->'plan')::text); commit;")"
[ -n "$boss_digest" ] && [ "$boss_digest" != "$digest_a" ] \
  || fail 'different actor did not receive an independent plan'
[ "$(q "select count(*) from public.lead_rebalance_batches where batch_key='$BATCH_RACE'")" = 2 ] \
  || fail 'same batch key was not isolated by actor'

# A rolled-back first insert leaves no row; the next attempt can create it.
rolled="$(q "begin; $(claims_sql "$ADMIN") set local role authenticated; select public.get_or_create_lead_rebalance_plan('$BATCH_ROLLBACK', '$PLAN_A'::jsonb)->>'found'; rollback; select count(*) from public.lead_rebalance_batches where actor_id='$ADMIN' and batch_key='$BATCH_ROLLBACK';")"
[ "$rolled" = 'true0' ] || fail "rollback probe was $rolled"
created="$(q "begin; $(claims_sql "$ADMIN") set local role authenticated; select public.get_or_create_lead_rebalance_plan('$BATCH_ROLLBACK', '$PLAN_B'::jsonb)->>'found'; commit;")"
[ "$created" = true ] || fail "post-rollback create returned $created"

# Empty/no-op plans are durable too; otherwise a retry could become work later.
empty="$(q "begin; $(claims_sql "$ADMIN") set local role authenticated; select md5((public.get_or_create_lead_rebalance_plan('$BATCH_EMPTY', '$PLAN_EMPTY'::jsonb)->'plan')::text); select md5((public.get_or_create_lead_rebalance_plan('$BATCH_EMPTY', '$PLAN_A'::jsonb)->'plan')::text); commit;")"
[ "${empty:0:32}" = "${empty:32:32}" ] || fail 'empty plan was replaced on replay'

expect_refusal() {
  local label="$1" sql="$2" needle="$3"
  local log="$work_dir/$label.log"
  if psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 -c "$sql" >"$log" 2>&1; then
    fail "$label unexpectedly succeeded"
  fi
  grep -qi "$needle" "$log" || fail "$label did not contain $needle"
  [ "$(q "select count(*) from public.lead_rebalance_batches where batch_key='$BATCH_INVALID'")" = 0 ] \
    || fail "$label left a plan row"
}

expect_refusal sales_forbidden \
  "begin; $(claims_sql "$SALES") set local role authenticated; select public.get_or_create_lead_rebalance_plan('$BATCH_INVALID', '$PLAN_A'::jsonb);" \
  'FORBIDDEN_REBALANCE'
expect_refusal duplicate_key \
  "begin; $(claims_sql "$ADMIN") set local role authenticated; select public.get_or_create_lead_rebalance_plan('$BATCH_INVALID', jsonb_build_object('updates', jsonb_build_array('$PLAN_A'::jsonb->'updates'->0, jsonb_set('$PLAN_B'::jsonb->'updates'->0, '{idempotency_key}', to_jsonb('$KEY_A'::text))), 'untokened_lead_ids','[]'::jsonb,'source_ids',jsonb_build_array('$SALES'),'target_ids',jsonb_build_array('$TARGET')));" \
  'DUPLICATE_REBALANCE_PLAN_LEAD'
expect_refusal bad_time \
  "begin; $(claims_sql "$ADMIN") set local role authenticated; select public.get_or_create_lead_rebalance_plan('$BATCH_INVALID', jsonb_set('$PLAN_A'::jsonb, '{updates,0,expected_updated_at}', to_jsonb('not-a-time'::text)));" \
  'INVALID_REBALANCE_PLAN_UPDATE'
expect_refusal target_outside_set \
  "begin; $(claims_sql "$ADMIN") set local role authenticated; select public.get_or_create_lead_rebalance_plan('$BATCH_INVALID', jsonb_set('$PLAN_A'::jsonb, '{target_ids}', jsonb_build_array('$SALES')));" \
  'DUPLICATE_REBALANCE_PLAN_LEAD'
expect_refusal oversized \
  "begin; $(claims_sql "$ADMIN") set local role authenticated; select public.get_or_create_lead_rebalance_plan('$BATCH_INVALID', jsonb_build_object('updates','[]'::jsonb,'untokened_lead_ids',(select jsonb_agg(gen_random_uuid()::text) from generate_series(1,501)),'source_ids','[]'::jsonb,'target_ids','[]'::jsonb));" \
  'REBALANCE_PLAN_TOO_LARGE'
expect_refusal inactive_actor \
  "begin; update public.profiles set is_active=false where id='$ADMIN'; $(claims_sql "$ADMIN") set local role authenticated; select public.get_or_create_lead_rebalance_plan('$BATCH_INVALID', '$PLAN_EMPTY'::jsonb);" \
  'account is deactivated'

# Cleanup is part of the gate contract, not an afterthought. Remove exact rows,
# then prove neither fixtures nor transaction-scoped advisory locks survive.
q "delete from public.lead_rebalance_batches where batch_key in ('$BATCH_RACE','$BATCH_ROLLBACK','$BATCH_EMPTY','$BATCH_INVALID')" >/dev/null
[ "$(q "select count(*) from public.lead_rebalance_batches where batch_key in ('$BATCH_RACE','$BATCH_ROLLBACK','$BATCH_EMPTY','$BATCH_INVALID')")" = 0 ] \
  || fail 'fixture rows remained after cleanup'
[ "$(q "select count(*) from pg_locks l join pg_stat_activity a on a.pid=l.pid where l.locktype='advisory' and a.application_name like 'rebalance-plan-%'")" = 0 ] \
  || fail 'rebalance plan advisory locks remained after both sessions ended'

echo 'lead rebalance plan PG17 OK: immutable concurrent winner, rollback/reentry, empty replay, ACL/shape/actor refusals, zero residue'
