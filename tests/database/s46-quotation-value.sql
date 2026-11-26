-- S46 database behaviour test, local PostgreSQL only, never production.
--   PGDATABASE=<replayed database> psql -v ON_ERROR_STOP=1 -q -f tests/database/s46-quotation-value.sql
-- Runs in one transaction that is rolled back. Every id below is invented.
-- Covers the PR #600 follow-ups: a foreign-currency quotation going away never clears an AED lead value that happens to be
-- the same number; a foreign-currency contract never becomes the AED lead value; the recomputation locks the lead row;
-- the ordinary AED behaviour (clear own amount, contract wins) is unchanged; posture unchanged.
begin;

create or replace function pg_temp.expect(p_ok boolean, p_name text) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'S46 ASSERT_FAIL %', p_name; end if;
  raise notice 'S46 ASSERT_OK %', p_name;
end $$;

-- 0a. put the routines and the contract trigger back in the state before S46 (the replayed database already carries the migration)
\ir ../../supabase/migrations/20261122200000_quotation_value_follows_quotations.sql

insert into public.leads (id, source, customer_name, phone, created_at, stage, quality, next_action, next_followup_date) values
  ('46000000-0000-4000-8000-000000000021', 'website', 'S46 usd equal',   '+971500004621', now(), 'contacted', 'good', 'call', now() + interval '1 day'),
  ('46000000-0000-4000-8000-000000000022', 'website', 'S46 usd contract', '+971500004622', now(), 'negotiation', 'good', 'call', now() + interval '1 day'),
  ('46000000-0000-4000-8000-000000000023', 'website', 'S46 aed clear',   '+971500004623', now(), 'contacted', 'good', 'call', now() + interval '1 day'),
  ('46000000-0000-4000-8000-000000000024', 'website', 'S46 aed contract', '+971500004624', now(), 'negotiation', 'good', 'call', now() + interval '1 day');

-- 0. before: a USD quotation whose total equals the lead value clears it when it is deleted (the gap)
update public.leads set quotation_value = 3000 where id = '46000000-0000-4000-8000-000000000021';
insert into public.quotations (id, lead_id, quote_no, version, subtotal, tax_rate, tax_amount, total_amount, currency, status)
  values ('46100000-0000-4000-8000-000000000001', '46000000-0000-4000-8000-000000000021', 'ALLOCATED_BY_DATABASE', 1, 3000, 0, 0, 3000, 'USD', 'draft');
delete from public.quotations where id = '46100000-0000-4000-8000-000000000001';
select pg_temp.expect((select quotation_value is null from public.leads where id = '46000000-0000-4000-8000-000000000021'), 'prior-state-usd-delete-clears-equal-aed-value');
-- and a USD-only contract overwrites the AED value of a won lead
-- (won with no amount first, so the lead-won trigger does not create its own draft contract; then the AED amount it was won with)
update public.leads set final_status = 'won', stage = 'won' where id = '46000000-0000-4000-8000-000000000022';
update public.leads set quotation_value = 1500 where id = '46000000-0000-4000-8000-000000000022';
insert into public.contracts (lead_id, contract_no, contract_amount, currency, party_a_name, status)
  values ('46000000-0000-4000-8000-000000000022', 'S46-TEST-0001', 9000, 'USD', 'S46 usd contract', 'active');
select pg_temp.expect((select quotation_value = 9000 from public.leads where id = '46000000-0000-4000-8000-000000000022'), 'prior-state-usd-contract-became-aed-value');
update public.leads set quotation_value = 3000 where id = '46000000-0000-4000-8000-000000000021';
update public.leads set quotation_value = 1500 where id = '46000000-0000-4000-8000-000000000022';

\ir ../../supabase/migrations/20261126000300_s46_quotation_value_currency_and_lock.sql
\ir ../../supabase/migrations/20261126000300_s46_quotation_value_currency_and_lock.sql

-- 1. posture
select pg_temp.expect((select count(*) = 1 and bool_and(p.prosecdef)
    and bool_and(p.proconfig @> array['search_path=pg_catalog, public, pg_temp']::text[])
    and bool_and(not has_function_privilege('anon', p.oid, 'EXECUTE'))
    and bool_and(not has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    and bool_and(p.prosrc like '%for update%')
    and bool_and(p.prosrc like '%deadlock_detected%')
  from pg_catalog.pg_proc p where p.oid = to_regprocedure('public.sync_lead_quotation_value(uuid,numeric)')), 'sync-routine-posture-and-row-lock');
select pg_temp.expect((select count(*) = 1 and bool_and(p.prosecdef)
    and bool_and(p.proconfig @> array['search_path=pg_catalog, public, pg_temp']::text[])
    and bool_and(not has_function_privilege('anon', p.oid, 'EXECUTE'))
    and bool_and(not has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  from pg_catalog.pg_proc p where p.oid = to_regprocedure('public.trg_sync_lead_quotation_value()')), 'trigger-routine-posture');
select pg_temp.expect((select count(*) = 3 from pg_trigger where tgname in ('trg_quotation_sync_lead_value','trg_contract_sync_lead_value','trg_lead_won_sync_value') and not tgisinternal and tgenabled = 'O'), 'three-triggers-enabled');
select pg_temp.expect((select pg_get_triggerdef(oid) like '%currency%' from pg_trigger where tgname = 'trg_contract_sync_lead_value' and tgrelid = 'public.contracts'::regclass), 'contract-trigger-watches-currency');

-- 2. a USD quotation with the same total as the lead value does not clear it, on delete, void or edit
insert into public.quotations (id, lead_id, quote_no, version, subtotal, tax_rate, tax_amount, total_amount, currency, status)
  values ('46100000-0000-4000-8000-000000000002', '46000000-0000-4000-8000-000000000021', 'ALLOCATED_BY_DATABASE', 1, 3000, 0, 0, 3000, 'USD', 'draft');
delete from public.quotations where id = '46100000-0000-4000-8000-000000000002';
select pg_temp.expect((select quotation_value = 3000 from public.leads where id = '46000000-0000-4000-8000-000000000021'), 'usd-quote-delete-keeps-aed-value');
insert into public.quotations (id, lead_id, quote_no, version, subtotal, tax_rate, tax_amount, total_amount, currency, status)
  values ('46100000-0000-4000-8000-000000000003', '46000000-0000-4000-8000-000000000021', 'ALLOCATED_BY_DATABASE', 1, 3000, 0, 0, 3000, 'USD', 'draft');
update public.quotations set status = 'rejected' where id = '46100000-0000-4000-8000-000000000003';
select pg_temp.expect((select quotation_value = 3000 from public.leads where id = '46000000-0000-4000-8000-000000000021'), 'usd-quote-void-keeps-aed-value');

-- 3. an AED quotation still clears its own amount when the last live one goes away
insert into public.quotations (id, lead_id, quote_no, version, subtotal, tax_rate, tax_amount, total_amount, currency, status)
  values ('46100000-0000-4000-8000-000000000004', '46000000-0000-4000-8000-000000000023', 'ALLOCATED_BY_DATABASE', 1, 2000, 0, 0, 2000, 'AED', 'draft');
select pg_temp.expect((select quotation_value = 2000 from public.leads where id = '46000000-0000-4000-8000-000000000023'), 'aed-quote-sets-value');
delete from public.quotations where id = '46100000-0000-4000-8000-000000000004';
select pg_temp.expect((select quotation_value is null from public.leads where id = '46000000-0000-4000-8000-000000000023'), 'aed-quote-delete-clears-own-amount');

-- 4. a foreign-currency contract stays out of the AED lead value; an AED contract still wins
update public.contracts set contract_amount = 9100 where contract_no = 'S46-TEST-0001';
select pg_temp.expect((select quotation_value = 1500 from public.leads where id = '46000000-0000-4000-8000-000000000022'), 'usd-contract-edit-keeps-aed-value');
update public.leads set final_status = 'won', stage = 'won' where id = '46000000-0000-4000-8000-000000000024';
insert into public.contracts (lead_id, contract_no, contract_amount, currency, party_a_name, status)
  values ('46000000-0000-4000-8000-000000000024', 'S46-TEST-0002', 4200, 'AED', 'S46 aed contract', 'active');
select pg_temp.expect((select quotation_value = 4200 from public.leads where id = '46000000-0000-4000-8000-000000000024'), 'aed-contract-amount-wins');
-- switching that contract to USD takes it out of the value again
update public.contracts set currency = 'USD' where contract_no = 'S46-TEST-0002';
select pg_temp.expect((select quotation_value = 4200 from public.leads where id = '46000000-0000-4000-8000-000000000024'), 'currency-change-to-usd-keeps-won-amount');

rollback;
