-- ============================================================================
-- Contract phase: direct end-user money writes stop being accepted
-- ============================================================================
-- ROLLS_BACK is declared by rollback_money_direct_write_contract_phase.sql.
--
-- This is the second half of the expand/contract sequence described in
-- 20260814000000 §3. Up to here the release has been backwards compatible on
-- purpose: 20260814000000 seeds public.money_release_mode with 'compat', so the
-- column and insert guards stand down for direct end-user writes and BOTH the
-- previous release (f37c203 / PR base 81956f2, which creates contracts,
-- installment plans, approvals and payment confirmations with direct PostgREST
-- writes) and the candidate release (which uses the RPCs) function against the
-- same schema. That is the rollback boundary the previous round did not have.
--
-- This file closes it. After it applies:
--
--   * contracts        direct INSERT refused; status, amount, number, ownership,
--                      dates change only through the routines
--   * payments         direct INSERT of a pre-confirmed row refused; confirmation,
--                      amount and linkage change only through confirm_payment()
--                      and allocate_payment()
--   * installment_plans direct INSERT refused; amount, allocation and status
--                      change only through allocate_payment()
--   * contract_approvals, payment_allocations  definer-only
--
-- and the previous release can no longer write money rows. That is the point of
-- no return for an application-only rollback, which is why it is a separate
-- migration with its own companion rather than a line inside the expand phase.
--
-- Ordering requirement, and how it is enforced
-- --------------------------------------------
-- `supabase db push` applies every pending migration in one run, so pushing this
-- file together with the expand phase collapses the compatibility window to
-- zero. The window is a deployment procedure, not a property of the SQL, and the
-- procedure is written down in supabase/preflight/expand-contract-rollback.md:
-- apply the expand phase, deploy the candidate release, verify, and only then
-- apply this file. tests/release/expand-contract-rollback-contract.test.mjs holds
-- the two artifacts to each other so the document cannot drift from the SQL.
--
-- The split is executable from this exact tree, with no file moved and no history
-- rewritten: infra/release/release-manifest.json names this file as the release's
-- one `deferred_contract` migration and every other pending file as
-- `required_for_app`, and scripts/db-phase-push.mjs applies one named phase after
-- checking each file's SHA-256 against that manifest. This file therefore carries
-- the HIGHEST version in the release, so the expand phase is also a contiguous
-- prefix of the pending set and no ordering hazard is left for an operator who
-- reaches for the CLI instead. scripts/check-release-manifest.mjs is the gate
-- that keeps all of that true as migrations are added.
--
-- The replay harness applies both, because the gate's job is to prove the strict
-- posture is real and that the companion returns to the compatible one. Read
-- supabase/replay/10_assert_release_contracts.sql for the compat-mode assertions
-- and supabase/replay/20_assert_post_rollback.sql for the rollback boundary.
-- ============================================================================

begin;

do $do$
declare
  v_mode text;
begin
  if to_regclass('public.money_release_mode') is null then
    raise exception 'public.money_release_mode does not exist; apply 20260814000000 first'
      using errcode = '42P01';
  end if;

  -- Round-4 C4-3 · take the flip lock before anything reads or writes the mode.
  --
  -- Every mode-controlled guard takes this key SHARED for the duration of the
  -- write it is guarding, so acquiring it exclusively here does two things that
  -- the bare `insert … on conflict` did not:
  --
  --   * it WAITS for the direct writes the previous release already has in
  --     flight, so 'strict' is not committed underneath a write that was
  --     admitted under 'compat' and is still going;
  --   * it makes any write that starts from now on wait for this transaction,
  --     and — because the guard is volatile — read the mode after being let
  --     through, so it is judged by the posture this transaction commits rather
  --     than by the one it replaced.
  --
  -- A missing key function means the expand phase is not fully applied, and
  -- flipping without it would be an unserialized flip wearing this file's name.
  if to_regprocedure('public.money_release_mode_lock_key()') is null then
    raise exception 'public.money_release_mode_lock_key() does not exist; apply 20260814000000 first, because without it this flip cannot be serialized against in-flight direct writes'
      using errcode = '42P01';
  end if;

  -- Bounded, so a flip that cannot drain fails loudly instead of parking every
  -- money write behind its own lock request. An operator who set lock_timeout
  -- deliberately keeps theirs; 15s is the default when none is set. Measured on
  -- PG 17.10: lock_timeout does apply to an advisory-lock wait (55P03).
  perform set_config('lock_timeout',
                     coalesce(nullif(current_setting('lock_timeout'), '0'), '15s'),
                     true);
  perform pg_advisory_xact_lock(public.money_release_mode_lock_key());

  insert into public.money_release_mode (id, direct_write_mode, reason, changed_at)
  values ('only', 'strict',
          'contract phase 20260818000000: the candidate release is live and writes '
          || 'money rows only through the RPCs, so direct end-user writes are refused',
          now())
  on conflict (id) do update
     set direct_write_mode = excluded.direct_write_mode,
         reason            = excluded.reason,
         changed_at        = excluded.changed_at;

  select direct_write_mode into v_mode from public.money_release_mode where id = 'only';
  if v_mode <> 'strict' then
    raise exception 'the contract phase did not take effect (mode is %)', coalesce(v_mode, 'null')
      using errcode = '22000';
  end if;
  raise notice 'direct end-user money writes are now refused (mode=%)', v_mode;
end
$do$;

commit;
