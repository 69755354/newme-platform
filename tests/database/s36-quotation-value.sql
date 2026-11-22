-- S36 database behaviour test, local PostgreSQL only, never production.
--   PGDATABASE=<replayed database> psql -v ON_ERROR_STOP=1 -q -f tests/database/s36-quotation-value.sql
-- Runs in one transaction that is rolled back. Every id below is invented.
-- Covers: leads.quotation_value follows the newest live AED quotation (create, newer quote, void, delete), a clear only when
-- the value was that quotation's, USD ignored, a won lead keeps the amount it was won with, an active contract wins, the
-- backfill fills only empty leads and leaves updated_at and sheet amounts alone, applying twice, and the routine's posture.
begin;

create or replace function pg_temp.expect(p_ok boolean, p_name text) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'S36 ASSERT_FAIL %', p_name; end if;
  raise notice 'S36 ASSERT_OK %', p_name;
end $$;

-- 0. before: nothing exists (the replayed history database has already applied S36, so it is dropped first)
drop trigger if exists trg_quotation_sync_lead_value on public.quotations;
drop trigger if exists trg_contract_sync_lead_value on public.contracts;
drop trigger if exists trg_lead_won_sync_value on public.leads;
drop function if exists public.trg_sync_lead_quotation_value();
drop function if exists public.trg_lead_won_sync_quotation_value();
drop function if exists public.sync_lead_quotation_value(uuid, numeric);
select pg_temp.expect(to_regprocedure('public.sync_lead_quotation_value(uuid,numeric)') is null, 'prior-state-routine-absent');

-- fixtures first, so the first application of the migration runs its backfill over real rows
insert into public.leads (id, source, customer_name, phone, created_at, stage, quality, next_action, next_followup_date) values
  ('36000000-0000-4000-8000-000000000001', 'website', 'S36 backfill me', '+971500000361', now(), 'contacted', 'good', 'call', now() + interval '1 day'),
  ('36000000-0000-4000-8000-000000000002', 'website', 'S36 sheet amount', '+971500000362', now(), 'contacted', 'good', 'call', now() + interval '1 day'),
  ('36000000-0000-4000-8000-000000000003', 'website', 'S36 live', '+971500000363', now(), 'contacted', 'good', 'call', now() + interval '1 day'),
  ('36000000-0000-4000-8000-000000000004', 'website', 'S36 won no contract', '+971500000364', now(), 'negotiation', 'good', 'call', now() + interval '1 day'),
  ('36000000-0000-4000-8000-000000000005', 'website', 'S36 won with contract', '+971500000365', now(), 'negotiation', 'good', 'call', now() + interval '1 day'),
  ('36000000-0000-4000-8000-000000000006', 'website', 'S36 usd only', '+971500000366', now(), 'contacted', 'good', 'call', now() + interval '1 day');
update public.leads set quotation_value = 777 where id = '36000000-0000-4000-8000-000000000002';

insert into public.quotations (lead_id, quote_no, version, subtotal, tax_rate, tax_amount, total_amount, currency, status, created_at) values
  ('36000000-0000-4000-8000-000000000001', 'ALLOCATED_BY_DATABASE', 1, 1000, 0, 0, 1000, 'AED', 'draft', now() - interval '2 days'),
  ('36000000-0000-4000-8000-000000000001', 'ALLOCATED_BY_DATABASE', 1, 2500, 0, 0, 2500, 'AED', 'draft', now() - interval '1 day'),
  ('36000000-0000-4000-8000-000000000001', 'ALLOCATED_BY_DATABASE', 1, 9000, 0, 0, 9000, 'AED', 'rejected', now()),
  ('36000000-0000-4000-8000-000000000002', 'ALLOCATED_BY_DATABASE', 1, 500, 0, 0, 500, 'AED', 'draft', now());

-- 1. the migration applies, and can be applied a second time
\ir ../../supabase/migrations/20261122200000_quotation_value_follows_quotations.sql
select pg_temp.expect((select quotation_value = 2500 from public.leads where id = '36000000-0000-4000-8000-000000000001'),
  'backfill-fills-empty-lead-with-newest-live-quote');
select pg_temp.expect((select quotation_value = 777 from public.leads where id = '36000000-0000-4000-8000-000000000002'),
  'backfill-never-overwrites-an-existing-amount');
create temp table s36_stamp as select id, updated_at from public.leads where id = '36000000-0000-4000-8000-000000000001';
update public.leads set quotation_value = null where id = '36000000-0000-4000-8000-000000000001';
create temp table s36_stamp2 as select id, updated_at from public.leads where id = '36000000-0000-4000-8000-000000000001';
\ir ../../supabase/migrations/20261122200000_quotation_value_follows_quotations.sql
select pg_temp.expect((select l.quotation_value = 2500 and l.updated_at = s.updated_at from public.leads l join s36_stamp2 s using (id)),
  'second-application-refills-and-keeps-updated_at');

-- 2. after: the posture the gate pins
select pg_temp.expect((select count(*) = 3 from pg_trigger where tgname in ('trg_quotation_sync_lead_value','trg_contract_sync_lead_value','trg_lead_won_sync_value') and not tgisinternal),
  'present-state-three-triggers');
select pg_temp.expect((select count(*) = 1 and bool_and(p.prosecdef)
    and bool_and(p.proconfig @> array['search_path=pg_catalog, public, pg_temp']::text[])
    and bool_and(not has_function_privilege('anon', p.oid, 'EXECUTE'))
    and bool_and(not has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  from pg_catalog.pg_proc p where p.oid = to_regprocedure('public.sync_lead_quotation_value(uuid,numeric)')),
  'present-state-definer-pinned-no-client-execute');

-- 3. a new quotation sets the value; a newer one replaces it; a voided newest one falls back to the previous
select pg_temp.expect((select quotation_value = 2500 from public.leads where id = '36000000-0000-4000-8000-000000000003') is not true, 'precondition-empty');
insert into public.quotations (lead_id, quote_no, version, subtotal, tax_rate, tax_amount, total_amount, currency, status, created_at)
  values ('36000000-0000-4000-8000-000000000003', 'ALLOCATED_BY_DATABASE', 1, 1000, 0, 0, 1000, 'AED', 'draft', now() - interval '1 hour');
select pg_temp.expect((select quotation_value = 1000 from public.leads where id = '36000000-0000-4000-8000-000000000003'), 'new-quote-sets-value');
insert into public.quotations (id, lead_id, quote_no, version, subtotal, tax_rate, tax_amount, total_amount, currency, status, created_at)
  values ('36100000-0000-4000-8000-000000000001', '36000000-0000-4000-8000-000000000003', 'ALLOCATED_BY_DATABASE', 1, 4000, 0, 0, 4000, 'AED', 'draft', now());
select pg_temp.expect((select quotation_value = 4000 from public.leads where id = '36000000-0000-4000-8000-000000000003'), 'newer-quote-replaces-value');
update public.quotations set status = 'rejected' where id = '36100000-0000-4000-8000-000000000001';
select pg_temp.expect((select quotation_value = 1000 from public.leads where id = '36000000-0000-4000-8000-000000000003'), 'voided-newest-falls-back-to-previous');
update public.quotations set status = 'draft', total_amount = 4100 where id = '36100000-0000-4000-8000-000000000001';
select pg_temp.expect((select quotation_value = 4100 from public.leads where id = '36000000-0000-4000-8000-000000000003'), 'edited-total-follows');
delete from public.quotations where id = '36100000-0000-4000-8000-000000000001';
select pg_temp.expect((select quotation_value = 1000 from public.leads where id = '36000000-0000-4000-8000-000000000003'), 'deleted-newest-falls-back');
update public.quotations set status = 'expired' where lead_id = '36000000-0000-4000-8000-000000000003';
select pg_temp.expect((select quotation_value is null from public.leads where id = '36000000-0000-4000-8000-000000000003'), 'last-live-voided-clears-its-own-amount');

-- 4. an amount that did not come from the voided quotation is left alone (the sheet's 777 vs a 500 quotation)
update public.quotations set status = 'rejected' where lead_id = '36000000-0000-4000-8000-000000000002';
select pg_temp.expect((select quotation_value = 777 from public.leads where id = '36000000-0000-4000-8000-000000000002'), 'foreign-amount-not-cleared');

-- 5. a USD quotation never becomes an AED amount
insert into public.quotations (lead_id, quote_no, version, subtotal, tax_rate, tax_amount, total_amount, currency, status)
  values ('36000000-0000-4000-8000-000000000006', 'ALLOCATED_BY_DATABASE', 1, 3000, 0, 0, 3000, 'USD', 'draft');
select pg_temp.expect((select quotation_value is null from public.leads where id = '36000000-0000-4000-8000-000000000006'), 'usd-quote-ignored');

-- 6. a won lead keeps the amount it was won with when a quotation is added later
update public.leads set quotation_value = 999 where id = '36000000-0000-4000-8000-000000000004';
update public.leads set final_status = 'won', stage = 'won' where id = '36000000-0000-4000-8000-000000000004';
insert into public.quotations (lead_id, quote_no, version, subtotal, tax_rate, tax_amount, total_amount, currency, status)
  values ('36000000-0000-4000-8000-000000000004', 'ALLOCATED_BY_DATABASE', 1, 5000, 0, 0, 5000, 'AED', 'draft');
select pg_temp.expect((select quotation_value = 999 from public.leads where id = '36000000-0000-4000-8000-000000000004'), 'won-lead-keeps-won-amount');

-- 7. a won lead with an active contract takes the contract amount, whatever the quotations say
-- (won with no amount here, so the lead-won trigger does not create its own draft contract first)
update public.leads set final_status = 'won', stage = 'won' where id = '36000000-0000-4000-8000-000000000005';
insert into public.contracts (lead_id, contract_no, contract_amount, party_a_name, status)
  values ('36000000-0000-4000-8000-000000000005', 'S36-TEST-0001', 4200, 'S36 won with contract', 'active');
select pg_temp.expect((select quotation_value = 4200 from public.leads where id = '36000000-0000-4000-8000-000000000005'), 'active-contract-amount-wins');
update public.contracts set contract_amount = 4300 where contract_no = 'S36-TEST-0001';
select pg_temp.expect((select quotation_value = 4300 from public.leads where id = '36000000-0000-4000-8000-000000000005'), 'contract-amount-edit-follows');

-- 8. a refused lead write never blocks the quotation: a lead whose follow-up rule would refuse the update still gets its quote
alter table public.leads disable trigger trg_enforce_followup;
update public.leads set next_action = null where id = '36000000-0000-4000-8000-000000000006';
alter table public.leads enable trigger trg_enforce_followup;
do $$
begin
  insert into public.quotations (lead_id, quote_no, version, subtotal, tax_rate, tax_amount, total_amount, currency, status)
    values ('36000000-0000-4000-8000-000000000006', 'ALLOCATED_BY_DATABASE', 1, 800, 0, 0, 800, 'AED', 'draft');
  raise notice 'S36 ASSERT_OK quote-saved-even-if-lead-refuses-the-update';
exception when others then
  raise exception 'S36 ASSERT_FAIL quote-saved-even-if-lead-refuses-the-update: %', sqlerrm;
end $$;
select pg_temp.expect((select count(*) = 2 from public.quotations where lead_id = '36000000-0000-4000-8000-000000000006'), 'quote-row-exists');

rollback;
