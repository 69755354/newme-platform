#!/usr/bin/env bash
# PG17 behavior gate for 20260817220000_notification_event_idempotency.sql.
#
# Requires a throwaway replay database with the release floor and migration
# applied. It stages a real two-session unique-index race using pg_locks, verifies
# rollback/reentry, verifies that legacy NULL-key inserts remain repeatable, and
# checks the RPC ACL. It is intentionally not wired into replay-migrations.sh in
# this change; the release-baseline owner binds new gates to the manifest/harness.
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=postgres}"
export PGHOST PGPORT PGUSER PGDATABASE

RECIPIENT='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
OTHER_RECIPIENT='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
RELATED='55555555-5555-4555-8555-555555555555'
RACE_KEY="lead_created:${RELATED}:pg17-race"
ROLLBACK_KEY="lead_created:${RELATED}:rollback"
MARK_HI=918274
MARK_LO=648
BARRIER_TIMEOUT="${BARRIER_TIMEOUT:-60}"
MIGRATION_FILE="${MIGRATION_FILE:-supabase/migrations/20260817220000_notification_event_idempotency.sql}"

work_dir="$(mktemp -d)"
fifo_a="$work_dir/session_a.in"
out_a="$work_dir/session_a.log"
out_b="$work_dir/session_b.log"
pid_a=
pid_b=

fail() {
  echo "notification idempotency gate failed: $*" >&2
  for log in "$out_a" "$out_b"; do
    if [[ -f "$log" ]]; then
      echo "--- $(basename "$log") ---" >&2
      cat "$log" >&2
    fi
  done
  exit 1
}

q() {
  psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 -c "$1" | tr -d '[:space:]'
}

cleanup() {
  set +e
  if [[ -n "$pid_b" ]]; then kill "$pid_b" 2>/dev/null; fi
  if [[ -n "$pid_a" ]]; then kill "$pid_a" 2>/dev/null; fi
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 -c "
    delete from public.notifications
     where event_key in ('$RACE_KEY', '$ROLLBACK_KEY')
        or (event_key is null and title like 'PG17 repeatable reminder%');
    select pg_advisory_unlock($MARK_HI, $MARK_LO);
  " >/dev/null 2>&1
  rm -rf "$work_dir"
}
trap cleanup EXIT

[[ -f "$MIGRATION_FILE" ]] || fail "migration file not found: $MIGRATION_FILE"

version="$(q "select current_setting('server_version')")"
[[ "$version" == 17.* ]] || fail "expected PostgreSQL 17.x, got $version"

# Re-entry: the additive migration must be safe when evaluated a second time.
psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 -f "$MIGRATION_FILE" >"$work_dir/reentry.log" 2>&1 \
  || { cat "$work_dir/reentry.log" >&2; fail "migration re-entry"; }

shape="$(q "
  select concat_ws(':',
    (select is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'notifications' and column_name = 'event_key'),
    (select i.indisunique::text
       from pg_catalog.pg_class c
       join pg_catalog.pg_index i on i.indexrelid = c.oid
      where c.oid = 'public.ux_notifications_user_event_key'::regclass),
    has_function_privilege('service_role', 'public.insert_notifications_atomic(jsonb)', 'EXECUTE')::text,
    has_function_privilege('authenticated', 'public.insert_notifications_atomic(jsonb)', 'EXECUTE')::text,
    has_function_privilege('anon', 'public.insert_notifications_atomic(jsonb)', 'EXECUTE')::text,
    has_column_privilege('authenticated', 'public.notifications', 'user_id', 'INSERT')::text,
    has_column_privilege('authenticated', 'public.notifications', 'event_key', 'INSERT')::text,
    has_column_privilege('authenticated', 'public.notifications', 'event_key', 'UPDATE')::text,
    has_column_privilege('service_role', 'public.notifications', 'event_key', 'INSERT')::text
  )
")"
[[ "$shape" == "YES:true:true:false:false:true:false:false:true" ]] || fail "column/index/ACL shape was $shape"

# An actual denied call, not only an ACL catalog reading.
if psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 -c \
  "set role authenticated; select public.insert_notifications_atomic('[]'::jsonb);" \
  >"$work_dir/authenticated.log" 2>&1; then
  fail "authenticated executed the service-only RPC"
fi
grep -qi 'permission denied for function insert_notifications_atomic' "$work_dir/authenticated.log" \
  || fail "authenticated refusal did not name the function permission"

q "delete from public.notifications where event_key in ('$RACE_KEY', '$ROLLBACK_KEY')" >/dev/null

# A inserts one occurrence but remains uncommitted. Its session-level advisory
# marker tells the coordinator that the INSERT finished before B starts.
mkfifo "$fifo_a"
PGAPPNAME='notification-race-a' psql --no-psqlrc --quiet --no-align --tuples-only \
  -v ON_ERROR_STOP=1 <"$fifo_a" >"$out_a" 2>&1 &
pid_a=$!
exec 3>"$fifo_a"
cat >&3 <<SQL
begin;
set local role service_role;
select (r->>'created') || ':' || (r->>'skipped')
  from (select public.insert_notifications_atomic(jsonb_build_array(jsonb_build_object(
    'user_id', '$RECIPIENT', 'type', 'lead_created', 'title', 'PG17 race',
    'body', 'same occurrence', 'related_id', '$RELATED', 'related_type', 'lead',
    'event_key', '$RACE_KEY'))) as r) s;
select pg_advisory_lock($MARK_HI, $MARK_LO);
SQL

deadline=$((SECONDS + BARRIER_TIMEOUT))
while [[ "$(q "select count(*) from pg_catalog.pg_locks where locktype = 'advisory' and classid = $MARK_HI and objid = $MARK_LO and granted")" != "1" ]]; do
  (( SECONDS < deadline )) || fail "session A never reached its committed-write barrier"
  sleep 0.05
done

# B reaches the same unique key and must wait on A's transaction rather than
# inserting a second row. pg_stat_activity is the barrier; no timing asserts it.
PGAPPNAME='notification-race-b' psql --no-psqlrc --quiet --no-align --tuples-only \
  -v ON_ERROR_STOP=1 >"$out_b" 2>&1 <<SQL &
begin;
set local role service_role;
select (r->>'created') || ':' || (r->>'skipped')
  from (select public.insert_notifications_atomic(jsonb_build_array(jsonb_build_object(
    'user_id', '$RECIPIENT', 'type', 'lead_created', 'title', 'PG17 race',
    'body', 'same occurrence', 'related_id', '$RELATED', 'related_type', 'lead',
    'event_key', '$RACE_KEY'))) as r) s;
commit;
SQL
pid_b=$!

deadline=$((SECONDS + BARRIER_TIMEOUT))
while [[ "$(q "select count(*) from pg_catalog.pg_stat_activity where application_name = 'notification-race-b' and wait_event_type = 'Lock'")" != "1" ]]; do
  (( SECONDS < deadline )) || fail "session B was never observed waiting on the unique occurrence"
  sleep 0.05
done

printf '%s\n' 'commit;' '\q' >&3
exec 3>&-
wait "$pid_a" || fail "session A"
pid_a=
wait "$pid_b" || fail "session B"
pid_b=

grep -qx '1:0' <(tr -d '\r' <"$out_a" | grep -E '^[0-9]+:[0-9]+$') \
  || fail "session A did not create exactly one row"
grep -qx '0:1' <(tr -d '\r' <"$out_b" | grep -E '^[0-9]+:[0-9]+$') \
  || fail "session B did not report one atomic replay"
[[ "$(q "select count(*) from public.notifications where user_id = '$RECIPIENT' and event_key = '$RACE_KEY'")" == "1" ]] \
  || fail "concurrent occurrence count was not one"

# The same occurrence is independent per recipient.
other="$(q "
  set role service_role;
  select (r->>'created') || ':' || (r->>'skipped')
    from (select public.insert_notifications_atomic(jsonb_build_array(jsonb_build_object(
      'user_id', '$OTHER_RECIPIENT', 'type', 'lead_created', 'title', 'PG17 race',
      'related_id', '$RELATED', 'related_type', 'lead', 'event_key', '$RACE_KEY'))) as r) s;
")"
[[ "$other" == "1:0" ]] || fail "second recipient result was $other"

# Interruption and re-entry: a rolled-back key leaves no ghost, the next call
# creates it, and a replay skips it.
interrupted="$(q "
  begin;
  set local role service_role;
  select (r->>'created') || ':' || (r->>'skipped')
    from (select public.insert_notifications_atomic(jsonb_build_array(jsonb_build_object(
      'user_id', '$RECIPIENT', 'type', 'lead_created', 'title', 'PG17 rollback',
      'event_key', '$ROLLBACK_KEY'))) as r) s;
  rollback;
  select count(*) from public.notifications where event_key = '$ROLLBACK_KEY';
")"
[[ "$interrupted" == "1:00" ]] || fail "rollback probe was $interrupted"

reentry="$(q "
  set role service_role;
  select (r->>'created') || ':' || (r->>'skipped')
    from (select public.insert_notifications_atomic(jsonb_build_array(jsonb_build_object(
      'user_id', '$RECIPIENT', 'type', 'lead_created', 'title', 'PG17 rollback',
      'event_key', '$ROLLBACK_KEY'))) as r) s;
  select (r->>'created') || ':' || (r->>'skipped')
    from (select public.insert_notifications_atomic(jsonb_build_array(jsonb_build_object(
      'user_id', '$RECIPIENT', 'type', 'lead_created', 'title', 'PG17 rollback',
      'event_key', '$ROLLBACK_KEY'))) as r) s;
")"
[[ "$reentry" == "1:00:1" ]] || fail "re-entry probe was $reentry"

# Application rollback and legitimate repeats: the old INSERT shape omits the
# additive column and remains valid; two NULL-key reminders stay two rows.
legacy="$(q "
  set role service_role;
  insert into public.notifications (user_id, type, title, related_id, related_type)
  values
    ('$RECIPIENT', 'payment_overdue', 'PG17 repeatable reminder 1', '$RELATED', 'payment'),
    ('$RECIPIENT', 'payment_overdue', 'PG17 repeatable reminder 1', '$RELATED', 'payment');
  select count(*) || ':' || count(event_key)
    from public.notifications where title = 'PG17 repeatable reminder 1';
")"
[[ "$legacy" == "INSERT02" || "$legacy" == "2:0" ]] || {
  # psql --tuples-only can still print the INSERT command tag on some builds.
  [[ "$legacy" == *"2:0" ]] || fail "legacy/repeatable probe was $legacy"
}

echo "notification idempotency PG17 OK: one concurrent occurrence, rollback/reentry, nullable repeats, service-only ACL"
