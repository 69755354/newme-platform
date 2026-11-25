-- S43 database behaviour test, local PostgreSQL only, never production.
--   PGDATABASE=<replayed database> psql -v ON_ERROR_STOP=1 -q -f tests/database/s43-leave-cover.sql
-- Runs in one transaction that is rolled back. The replay floor already holds the accounts used here
-- (admin aaaa..., sales eeee... and cccc..., finance ffff...); nothing else is inserted.
-- Covers: the three profile columns, both check constraints, set_leave_cover posture (definer, pinned search_path,
-- grants), admin-only access, validation (self, dates, inactive cover), set and clear.
begin;

create or replace function pg_temp.expect(p_ok boolean, p_name text) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'S43 ASSERT_FAIL %', p_name; end if;
  raise notice 'S43 ASSERT_OK %', p_name;
end $$;

create or replace function pg_temp.sqlstate_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end $$;

\ir ../../supabase/migrations/20261124300000_s43_leave_cover.sql
\ir ../../supabase/migrations/20261124300000_s43_leave_cover.sql

-- posture
select pg_temp.expect((select count(*) = 3 from information_schema.columns
  where table_schema = 'public' and table_name = 'profiles' and column_name in ('cover_user_id', 'cover_start', 'cover_end')), 'columns-present');
select pg_temp.expect((select p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public, pg_temp']::text[]
  from pg_proc p where p.oid = to_regprocedure('public.set_leave_cover(uuid,uuid,date,date)')), 'definer-with-pinned-search-path');
select pg_temp.expect(has_function_privilege('authenticated', to_regprocedure('public.set_leave_cover(uuid,uuid,date,date)'), 'EXECUTE')
  and not has_function_privilege('anon', to_regprocedure('public.set_leave_cover(uuid,uuid,date,date)'), 'EXECUTE'), 'grants');

-- constraints hold regardless of the routine
select pg_temp.expect(pg_temp.sqlstate_of($q$update public.profiles set cover_user_id = id where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'$q$) = '23514', 'constraint-not-self');
select pg_temp.expect(pg_temp.sqlstate_of($q$update public.profiles set cover_start = '2026-12-05', cover_end = '2026-12-01' where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'$q$) = '23514', 'constraint-dates-ordered');
select pg_temp.expect(pg_temp.sqlstate_of($q$update public.profiles set cover_start = '2026-12-01', cover_end = null where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'$q$) = '23514', 'constraint-both-dates-or-none');

-- nobody signed in
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.set_leave_cover('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '2026-12-01', '2026-12-05')$q$) = '42501', 'anonymous-refused');

-- a salesperson may not set covers
select set_config('request.jwt.claims', '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee","role":"authenticated","iat":' || (extract(epoch from now())::bigint + 5) || '}', true);
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.set_leave_cover('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '2026-12-01', '2026-12-05')$q$) = '42501', 'sales-refused');
-- finance neither
select set_config('request.jwt.claims', '{"sub":"ffffffff-ffff-ffff-ffff-ffffffffffff","role":"authenticated","iat":' || (extract(epoch from now())::bigint + 5) || '}', true);
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.set_leave_cover('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '2026-12-01', '2026-12-05')$q$) = '42501', 'finance-refused');

-- admin: validation, set, clear
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated","iat":' || (extract(epoch from now())::bigint + 5) || '}', true);
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.set_leave_cover('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '2026-12-01', '2026-12-05')$q$) = '22023', 'self-cover-refused');
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.set_leave_cover('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '2026-12-05', '2026-12-01')$q$) = '22023', 'reversed-dates-refused');
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.set_leave_cover('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '43000000-0000-4000-8000-000000000099', '2026-12-01', '2026-12-05')$q$) = '22023', 'unknown-cover-refused');
update public.profiles set is_active = false where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.set_leave_cover('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '2026-12-01', '2026-12-05')$q$) = '22023', 'inactive-cover-refused');
update public.profiles set is_active = true where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.set_leave_cover('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '2026-12-01', '2026-12-05')$q$) = 'ok', 'admin-sets-cover');
select pg_temp.expect((select cover_user_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc' and cover_start = '2026-12-01' and cover_end = '2026-12-05'
  from public.profiles where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'), 'cover-stored');
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.set_leave_cover('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', null, null, null)$q$) = 'ok', 'admin-clears-cover');
select pg_temp.expect((select cover_user_id is null and cover_start is null and cover_end is null
  from public.profiles where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'), 'cover-cleared');

rollback;
