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
-- Atomicity is proven, not asserted: supabase/replay/10_assert_release_contracts.sql
-- seeds a period, calls this function with a row that violates the target_type
-- CHECK, and requires the pre-existing rows to still be there afterwards.

begin;

create or replace function public.replace_kpi_targets(
  p_period text,
  p_rows   jsonb,
  p_set_by uuid
)
returns setof public.kpi_targets
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_period is null or btrim(p_period) = '' then
    raise exception 'period is required' using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'at least one target row is required' using errcode = '22023';
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
