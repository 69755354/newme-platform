-- S24 dispatch backfill: evaluates every existing, non-archived lead once, in batches, so the dispatch workbench
-- starts complete. Run by the release gate after the S24 batch is provisioned; it is NOT part of the application and
-- no button starts it. The routine it calls writes only dispatch rows (lead_dispatch_state, duplicate_reviews,
-- lead_dispatch_events); it never writes a lead, sends no message, creates no notification and touches no Meta data.
--
--   dry run (default): psql -v ON_ERROR_STOP=1 -f scripts/s24-dispatch-backfill.sql
--   apply:             psql -v ON_ERROR_STOP=1 -v apply=1 -f scripts/s24-dispatch-backfill.sql
--
-- Safe to run twice: leads that already have a current state are skipped, decided duplicate reviews stay decided.
\set ON_ERROR_STOP on
\if :{?apply}
\echo applying the S24 dispatch backfill
do $backfill$
declare
  v_batch jsonb;
  v_total integer := 0;
  v_changed integer := 0;
  v_round integer := 0;
begin
  loop
    v_round := v_round + 1;
    exit when v_round > 500;
    v_batch := public.sweep_lead_dispatch('1970-01-01', 200);
    exit when coalesce((v_batch->>'evaluated')::integer, 0) = 0;
    v_total := v_total + (v_batch->>'evaluated')::integer;
    v_changed := v_changed + (v_batch->>'changed')::integer;
    perform pg_sleep(0.2);
  end loop;
  raise notice 'S24 backfill: % leads evaluated, % states written or changed', v_total, v_changed;
end
$backfill$;
select status, count(*) as leads from public.lead_dispatch_state group by status order by status;
\else
\echo dry run: nothing is written. Pass -v apply=1 to apply.
select count(*) as leads_without_state
  from public.leads l
 where not l.archived and not exists (select 1 from public.lead_dispatch_state s where s.lead_id = l.id);
select status, count(*) as leads_with_state from public.lead_dispatch_state group by status order by status;
\endif
