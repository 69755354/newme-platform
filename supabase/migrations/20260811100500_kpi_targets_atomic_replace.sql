-- KPI targets: make a period replacement atomic.
--
-- POST /api/kpi/targets replaced a period's targets with two independent
-- service_role statements:
--     await supabaseAdmin.from("kpi_targets").delete().eq("period", period);
--     await supabaseAdmin.from("kpi_targets").insert(rows);
-- Two PostgREST calls are two transactions. If the insert failed — a CHECK
-- violation on target_type, a NUMERIC(12,2) overflow on target_amount, a
-- foreign-key miss on assigned_to, a duplicate (period, target_type,
-- assigned_to), a dropped connection — the delete had already committed. The
-- route answered 500 and the period was left EMPTY, with no restore path and no
-- copy of what had been there. Every target for that month was gone, and the
-- dashboards, sales-load and team-performance views that read kpi_targets showed
-- zero targets. A single malformed row from the settings UI destroyed the
-- period's data.
--
-- Delete-then-insert is itself the right strategy — ON CONFLICT cannot be used
-- because assigned_to is nullable and NULL is never equal to NULL in a unique
-- constraint, so an upsert accumulates duplicate unassigned rows. The fix is to
-- put both statements in one transaction, which means one round trip, which
-- means a function.
--
-- Two things one transaction does NOT fix, both raised in review:
--
--   1 · Concurrency. Delete-then-insert inside a transaction is atomic, not
--       serialized. Two administrators saving the same period concurrently both
--       delete (each seeing rows the other has not yet removed, or removing rows
--       the other is about to re-insert) and both insert. Where assigned_to is
--       NOT NULL the unique index makes one of them fail — badly, but visibly.
--       Where assigned_to IS NULL there is no index to fail, because NULL is
--       never equal to NULL, so the period silently ends up holding both saves:
--       two "unassigned signing" targets, and every view that reads kpi_targets
--       double-counts. A period-scoped advisory lock makes the second caller wait
--       for the first to commit, so it deletes what the first actually wrote.
--
--   2 · The same NULL hole inside one call. Nothing stopped a single payload from
--       carrying two rows with the same target_type and no assignee. The index
--       cannot catch it, so it is rejected explicitly, and a partial unique index
--       now covers the unassigned case the full index cannot.
--
-- SECURITY DEFINER with EXECUTE granted to service_role only. `authenticated`
-- gets nothing: the route already checks admin/boss/operator before calling, and
-- exposing a whole-period replacement to any logged-in session would be a
-- destructive primitive reachable over PostgREST. search_path is pinned, as a
-- SECURITY DEFINER function must be.
--
-- Rollback: supabase/migrations/rollback_l0_20260811.sql
--   drop function if exists public.replace_kpi_targets(text, jsonb, uuid);
-- The route falls back to nothing — it is the only caller — so roll the release
-- back together with it.
--
-- Rollback also keeps idx_kpi_targets_one_unassigned_per_period_type — dropping a
-- uniqueness constraint on business data is not a revert.
--
-- Proven, not asserted, in supabase/replay/10_assert_release_contracts.sql: a
-- period is seeded and this function is called with a row that violates the
-- target_type CHECK, with an empty set, and with two rows sharing a
-- (target_type, unassigned) key, and after each the pre-existing rows must still
-- be there; the advisory lock is observed in pg_locks under the key derived from
-- the period; and the partial index is checked for existence, uniqueness and its
-- predicate. supabase/replay/20_assert_post_rollback.sql then requires the index
-- to survive the companion.

begin;

-- ---------------------------------------------------------------------------
-- The index the nullable assigned_to column always needed.
--
-- idx/uniq (period, target_type, assigned_to) does not constrain unassigned rows
-- at all, because NULL <> NULL in a unique index. This partial index covers
-- exactly the rows that one excludes.
--
-- Fail-closed by design: if the table already holds duplicate unassigned rows for
-- a period and type, this migration ABORTS with the count, and the deploy stops.
-- It does not dedupe. Choosing which of two conflicting KPI targets is the real
-- one is an operator decision about business data, not something a migration may
-- guess at — and a migration that silently deleted KPI rows is precisely the kind
-- of thing this release exists to stop shipping. See
-- supabase/preflight/f02-credential-cutover.md for the read-only preflight query
-- that answers "would this abort?" before the deploy is started.
do $$
declare
  v_groups int;
begin
  select count(*) into v_groups
    from (
      select period, target_type
        from public.kpi_targets
       where assigned_to is null
       group by period, target_type
      having count(*) > 1
    ) d;
  if v_groups > 0 then
    raise exception
      'kpi_targets holds % (period, target_type) group(s) with more than one unassigned row; resolve them before deploying — this migration will not choose for you',
      v_groups
      using errcode = '23505';
  end if;
end
$$;

create unique index if not exists idx_kpi_targets_one_unassigned_per_period_type
  on public.kpi_targets (period, target_type)
  where assigned_to is null;

create or replace function public.replace_kpi_targets(
  p_period text,
  p_rows   jsonb,
  p_set_by uuid
)
returns setof public.kpi_targets
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_lock_key bigint;
begin
  if p_period is null or btrim(p_period) = '' then
    raise exception 'period is required' using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'at least one target row is required' using errcode = '22023';
  end if;

  -- Serialize on the period, before the delete. Held to commit or rollback, so a
  -- concurrent save of the SAME period waits and then deletes what this one
  -- actually wrote; a save of a different period is unaffected. The key is
  -- derived from the period text, so it needs no table and no cleanup.
  v_lock_key := hashtextextended('public.kpi_targets:' || p_period, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  -- Rejected here because no index can reject it: two rows with the same
  -- target_type and no assignee are not a unique-index violation.
  if exists (
    select 1
      from jsonb_array_elements(p_rows) as row_in
     group by row_in ->> 'target_type', nullif(row_in ->> 'assigned_to', '')
    having count(*) > 1
  ) then
    raise exception 'the replacement set contains more than one row for the same (target_type, assigned_to)'
      using errcode = '23505';
  end if;

  -- One transaction: the delete is only durable if every row inserts.
  delete from public.kpi_targets where period = p_period;

  return query
  insert into public.kpi_targets (period, target_type, target_amount, assigned_to, notes, set_by)
  select
    p_period,
    row_in->>'target_type',
    (row_in->>'target_amount')::numeric(12,2),
    nullif(row_in->>'assigned_to', '')::uuid,
    nullif(row_in->>'notes', ''),
    p_set_by
  from jsonb_array_elements(p_rows) as row_in
  returning *;
end;
$$;

revoke all on function public.replace_kpi_targets(text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.replace_kpi_targets(text, jsonb, uuid) to service_role;

commit;
