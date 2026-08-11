-- ============================================================================
-- Rollback companion: return to the compatibility window
-- ============================================================================
-- ROLLS_BACK: 20260815000000_money_direct_write_contract_phase.sql
--
-- The name deliberately does not match ^[0-9]{14}_ so the Supabase CLI will never
-- apply it. It is run by hand, by an operator, at a rollback.
--
-- What it does: puts public.money_release_mode back to 'compat', which is the
-- state 20260814000000 seeded. The column and insert guards stand down for direct
-- end-user writes again, so the PREVIOUS release (f37c203 / 81956f2) can create
-- contracts, installment plans and approvals and confirm payments through
-- PostgREST exactly as it does in production today.
--
-- What it does NOT do, and this is the part that matters
-- -----------------------------------------------------
-- The reviewed round-2 rollback companion re-enabled the published credential's
-- profile, re-granted meta_tokens to authenticated, re-granted profiles UPDATE
-- and recreated the with_check(true) audit-insert policy: it rolled the security
-- fixes back along with the schema, and the gate was green because SQL that opens
-- a hole runs as cleanly as SQL that closes one. This companion touches exactly
-- one row in one table. Everything else stays closed:
--
--   * money_actor() still binds the actor to the session's JWT subject, still
--     refuses a NULL role, and still calls assert_current_session()
--   * the class-28 session boundary and trg_require_current_session stay on every
--     table, so revoked, banned, stale-token and password-change-owing sessions
--     are still refused inside every SECURITY DEFINER RPC
--   * DELETE on contracts, payments, installment_plans, contract_approvals and
--     payment_allocations stays refused and stays un-granted — no release has
--     ever issued it from a session, so it is not part of the compatibility story
--   * the contract transition graph, lead ownership in create_contract(), the
--     installment invariant in convert_quotation_to_contract(), the plan locking
--     in allocate_payment() and the admin/boss/finance payment rule are all
--     unaffected: they live in the routines, not in the mode
--   * F-02, F-06, F-08, F-09 and F-10 are untouched
--
-- The honest cost, stated rather than buried: while the mode is 'compat' a
-- browser session can write contracts.status and payments.confirmed directly.
-- That is the posture production has today. Reverting to it is a return to the
-- status quo, not a new hole — and it is the only thing that makes an
-- application-only rollback a rollback rather than a rename for roll-forward.
--
-- supabase/replay/20_assert_post_rollback.sql asserts both halves at the
-- behaviour level after this file runs.
-- ============================================================================

begin;

do $do$
declare
  v_mode text;
begin
  if to_regclass('public.money_release_mode') is null then
    raise exception 'public.money_release_mode does not exist; there is no contract phase to roll back'
      using errcode = '42P01';
  end if;

  update public.money_release_mode
     set direct_write_mode = 'compat',
         reason            = 'rolled back to the compatibility window so the previous '
                             || 'release can write money rows directly',
         changed_at        = now()
   where id = 'only';

  if not found then
    insert into public.money_release_mode (id, direct_write_mode, reason)
    values ('only', 'compat', 'restored the compatibility window at a rollback');
  end if;

  select direct_write_mode into v_mode from public.money_release_mode where id = 'only';
  if v_mode <> 'compat' then
    raise exception 'the rollback did not take effect (mode is %)', coalesce(v_mode, 'null')
      using errcode = '22000';
  end if;
  raise notice 'direct end-user money writes are accepted again (mode=%)', v_mode;
end
$do$;

commit;
