-- S37 database behaviour test, local PostgreSQL only, never production.
--   PGDATABASE=<replayed database> psql -v ON_ERROR_STOP=1 -q -f tests/database/s37-new-lead-status.sql
-- Runs in one transaction that is rolled back. Every value below is invented.
-- Covers public.derive_lead_status(): a never-contacted lead created within 48h is 'hot' (it was 'dormant'),
-- a never-contacted lead older than 48h is 'dormant', contacted leads keep the 7/14/30 day rule, won/lost untouched.
begin;

create or replace function pg_temp.expect(p_ok boolean, p_name text) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'S37 ASSERT_FAIL %', p_name; end if;
  raise notice 'S37 ASSERT_OK %', p_name;
end $$;

\ir ../../supabase/migrations/20261122300000_s37_new_lead_not_dormant.sql
\ir ../../supabase/migrations/20261122300000_s37_new_lead_not_dormant.sql

select pg_temp.expect((select count(*) = 1 and bool_and(p.prosecdef)
    and bool_and(p.proconfig @> array['search_path=pg_catalog, public, pg_temp']::text[])
    and bool_and(not has_function_privilege('anon', p.oid, 'EXECUTE'))
    and bool_and(not has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  from pg_proc p where p.oid = 'public.derive_lead_status()'::regprocedure), 'definer-posture-unchanged');

-- The routine is exercised through a temporary table that carries the same columns it reads, so the test needs no
-- lead fixture and cannot trip the other triggers of public.leads.
create temp table s37_probe (id int primary key, stage text, last_contact_date date, created_at timestamptz, lead_status text, metadata jsonb);
create trigger s37_probe_derive before insert or update of last_contact_date, stage on s37_probe
  for each row execute function public.derive_lead_status();

insert into s37_probe (id, stage, last_contact_date, created_at) values
  (1, 'new', null, now() - interval '3 hours'),
  (2, 'new', null, now() - interval '5 days'),
  (3, 'new', current_date - 20, now() - interval '5 days'),
  (4, 'new', current_date - 3, now() - interval '5 days'),
  (5, 'new', current_date - 60, now() - interval '90 days'),
  (6, 'won', null, now() - interval '3 hours');

select pg_temp.expect((select lead_status = 'hot' from s37_probe where id = 1), 'fresh-never-contacted-is-hot');
select pg_temp.expect((select lead_status = 'dormant' from s37_probe where id = 2), 'old-never-contacted-is-dormant');
select pg_temp.expect((select lead_status = 'cold' from s37_probe where id = 3), 'contacted-20-days-is-cold');
select pg_temp.expect((select lead_status = 'hot' from s37_probe where id = 4), 'contacted-3-days-is-hot');
select pg_temp.expect((select lead_status = 'dormant' from s37_probe where id = 5), 'contacted-60-days-is-dormant');
select pg_temp.expect((select lead_status is null from s37_probe where id = 6), 'won-is-left-alone');

rollback;
