-- S46 database behaviour test, local PostgreSQL only, never production.
--   PGDATABASE=<replayed database> psql -v ON_ERROR_STOP=1 -q -f tests/database/s46-leads-delete-policy.sql
-- Runs in one transaction that is rolled back. Every id below is invented; the profiles are the replay fixtures.
-- Covers: before the migration a salesperson can delete their own lead (the gap), after it only admin and boss can,
-- the migration applies twice, and admin keeps every delete right boss has.
begin;

create or replace function pg_temp.expect(p_ok boolean, p_name text) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'S46 ASSERT_FAIL %', p_name; end if;
  raise notice 'S46 ASSERT_OK %', p_name;
end $$;

-- 0a. put the database back in the state before S46 (the replayed database already carries the migration)
drop policy if exists policy_leads_delete_sales on public.leads;
create policy policy_leads_delete_sales on public.leads for delete to authenticated using (assigned_to = auth.uid());

insert into public.leads (id, source, customer_name, phone, created_at, stage, quality, next_action, next_followup_date, assigned_to) values
  ('46000000-0000-4000-8000-000000000001', 'website', 'S46 sales own',   '+971500004601', now(), 'contacted', 'good', 'call', current_date + 1, 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
  ('46000000-0000-4000-8000-000000000002', 'website', 'S46 boss del',    '+971500004602', now(), 'contacted', 'good', 'call', current_date + 1, 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
  ('46000000-0000-4000-8000-000000000003', 'website', 'S46 admin del',   '+971500004603', now(), 'contacted', 'good', 'call', current_date + 1, 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
  ('46000000-0000-4000-8000-000000000004', 'website', 'S46 sales own 2', '+971500004604', now(), 'contacted', 'good', 'call', current_date + 1, 'cccccccc-cccc-cccc-cccc-cccccccccccc');

-- 0. before: the policy that lets a salesperson delete their own lead is live, and the delete goes through
select pg_temp.expect(exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'leads' and policyname = 'policy_leads_delete_sales'), 'prior-state-sales-delete-policy-present');
savepoint before_fix;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated","iat":' || (extract(epoch from now())::bigint + 5) || '}', true);
with d as (delete from public.leads where id = '46000000-0000-4000-8000-000000000004' returning 1)
select pg_temp.expect((select count(*) = 1 from d), 'prior-state-sales-can-delete-own-lead');
rollback to savepoint before_fix;

-- 1. the migration applies, twice
\ir ../../supabase/migrations/20261126000100_s46_leads_delete_admin_boss_only.sql
\ir ../../supabase/migrations/20261126000100_s46_leads_delete_admin_boss_only.sql
select pg_temp.expect(not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'leads' and policyname = 'policy_leads_delete_sales'), 'sales-delete-policy-dropped');
select pg_temp.expect((select count(*) = 1 from pg_policies where schemaname = 'public' and tablename = 'leads' and cmd = 'DELETE'), 'one-delete-policy-left');
select pg_temp.expect((select qual like '%admin%' and qual like '%boss%' from pg_policies where schemaname = 'public' and tablename = 'leads' and policyname = 'policy_leads_delete_admin'), 'admin-and-boss-delete-policy-kept');

-- 2. a salesperson can no longer delete their own lead
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated","iat":' || (extract(epoch from now())::bigint + 5) || '}', true);
with d as (delete from public.leads where id = '46000000-0000-4000-8000-000000000001' returning 1)
select pg_temp.expect((select count(*) = 0 from d), 'sales-cannot-delete-own-lead');

-- 3. boss and admin still can
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated","iat":' || (extract(epoch from now())::bigint + 5) || '}', true);
with d as (delete from public.leads where id = '46000000-0000-4000-8000-000000000002' returning 1)
select pg_temp.expect((select count(*) = 1 from d), 'boss-can-delete');
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated","iat":' || (extract(epoch from now())::bigint + 5) || '}', true);
with d as (delete from public.leads where id = '46000000-0000-4000-8000-000000000003' returning 1)
select pg_temp.expect((select count(*) = 1 from d), 'admin-can-delete');
reset role;

-- 4. the routine the leads list and board call (SECURITY DEFINER, bypasses row-level security) follows the same rule
insert into public.leads (id, source, customer_name, phone, created_at, stage, quality, next_action, next_followup_date, assigned_to) values
  ('46000000-0000-4000-8000-000000000005', 'website', 'S46 rpc sales',  '+971500004605', now(), 'contacted', 'good', 'call', current_date + 1, 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
  ('46000000-0000-4000-8000-000000000006', 'website', 'S46 rpc boss',   '+971500004606', now(), 'contacted', 'good', 'call', current_date + 1, 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
  ('46000000-0000-4000-8000-000000000007', 'website', 'S46 rpc admin',  '+971500004607', now(), 'contacted', 'good', 'call', current_date + 1, 'cccccccc-cccc-cccc-cccc-cccccccccccc');
create or replace function pg_temp.sqlstate_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlerrm;
end $$;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated","iat":' || (extract(epoch from now())::bigint + 5) || '}', true);
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.delete_lead_atomic('46000000-0000-4000-8000-000000000005', gen_random_uuid())$q$) = 'FORBIDDEN_LEAD_DELETE', 'rpc-sales-cannot-delete-own-lead');
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated","iat":' || (extract(epoch from now())::bigint + 5) || '}', true);
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.delete_lead_atomic('46000000-0000-4000-8000-000000000006', gen_random_uuid())$q$) = 'ok', 'rpc-boss-can-delete');
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated","iat":' || (extract(epoch from now())::bigint + 5) || '}', true);
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.delete_lead_atomic('46000000-0000-4000-8000-000000000007', gen_random_uuid())$q$) = 'ok', 'rpc-admin-can-delete');
reset role;
select pg_temp.expect((select count(*) = 1 from public.leads where id = '46000000-0000-4000-8000-000000000005')
  and (select count(*) = 0 from public.leads where id in ('46000000-0000-4000-8000-000000000006', '46000000-0000-4000-8000-000000000007')), 'rpc-only-the-sales-lead-survives');
select pg_temp.expect((select count(*) = 1 and bool_and(p.prosecdef) and bool_and(p.proconfig @> array['search_path=pg_catalog, public, pg_temp']::text[])
    and bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE')) and bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE'))
    and bool_and(not has_function_privilege('anon', p.oid, 'EXECUTE')) and bool_and(p.prosrc not like '%''sales''%')
  from pg_proc p where p.oid = to_regprocedure('public.delete_lead_atomic(uuid,uuid)')), 'rpc-posture');

select pg_temp.expect((select count(*) = 2 from public.leads where id in ('46000000-0000-4000-8000-000000000001', '46000000-0000-4000-8000-000000000004')), 'sales-leads-still-exist');

rollback;
