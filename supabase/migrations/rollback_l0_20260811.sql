-- Rollback companion for the five L0 audit migrations dated 20260811.
--
-- Not a migration: the Supabase CLI only applies files whose name begins with a
-- 14-digit timestamp, so this file is inert until an operator runs it
-- explicitly. Same convention as rollback_crm_v3.sql and rollback_p0_10.sql.
--
-- Covers, newest first:
--   20260811100500_kpi_targets_atomic_replace.sql
--   20260811100400_f09_money_authorization_phase1.sql
--   20260811100300_f02_remove_default_credential_admin.sql
--   20260811100200_f10_meta_tokens_drop_permissive_select.sql
--   20260811100100_f06_profiles_revocation_columns.sql
--   20260811100000_f08_audit_logs_actor_identity.sql
--
-- Every one is reversible by construction: no DROP TABLE, no DROP COLUMN, no
-- DELETE. The only data change in the set is a two-column UPDATE on a single
-- profiles row, restored below.
--
-- NOT covered, deliberately:
--   20260630210000_baseline_undeclared_production_objects.sql — every statement
--   in it is CREATE/ADD ... IF NOT EXISTS against objects that already exist in
--   production, so it has nothing to revert. Dropping meta_tokens or the two
--   profiles columns would destroy production data, not undo a change.
--
-- Executed by scripts/replay-migrations.sh after a successful forward replay, so
-- "reversible" here is a tested property, not a claim in a comment.
--
-- Sections are independent — run the whole file, or only the section for the
-- migration being reverted.

begin;

-- ── KPI atomic replace ──────────────────────────────────────────────────────
-- Only safe together with reverting src/app/api/kpi/targets/route.ts, which is
-- the function's only caller; reverting the route restores the delete-then-insert
-- pair, and with it the data-loss window this migration closed.
drop function if exists public.replace_kpi_targets(text, jsonb, uuid);

-- ── F-09 ────────────────────────────────────────────────────────────────────
-- Restore the pre-migration ACL: EXECUTE held through PUBLIC, plus the anon
-- grant. This deliberately re-opens anonymous execution of the money routines;
-- only run it if the explicit role grants are what broke something.
grant execute on function public.confirm_payment(uuid, uuid)               to public;
grant execute on function public.approve_contract(uuid, uuid, text, text)  to public;
grant execute on function public.allocate_payment(uuid, jsonb, uuid)       to public;
grant execute on function public.confirm_payment(uuid, uuid)               to anon;
grant execute on function public.approve_contract(uuid, uuid, text, text)  to anon;
grant execute on function public.allocate_payment(uuid, jsonb, uuid)       to anon;
revoke execute on function public.confirm_payment(uuid, uuid)              from authenticated, service_role;
revoke execute on function public.approve_contract(uuid, uuid, text, text) from authenticated, service_role;
revoke execute on function public.allocate_payment(uuid, jsonb, uuid)      from authenticated, service_role;

-- ── F-02 ────────────────────────────────────────────────────────────────────
-- Re-enable dev@newme.ae. Restores the account to the state the forward
-- migration found it in: active, no forced password change. This re-arms a
-- published credential — do not run it without a replacement plan.
do $$
declare
  dev_id uuid;
begin
  select id into dev_id from auth.users where email = 'dev@newme.ae';
  if dev_id is null then
    raise notice 'dev@newme.ae absent - nothing to restore';
    return;
  end if;
  update public.profiles
     set is_active             = true,
         force_password_change = false,
         updated_at            = now()
   where id = dev_id;
  raise notice 'dev@newme.ae re-enabled - published credential is live again';
end $$;

-- ── F-10 ────────────────────────────────────────────────────────────────────
-- Restore the table grants and the permissive SELECT policy. This makes the
-- plaintext Meta Ads token readable by every authenticated user again.
grant select, insert, update, delete on public.meta_tokens to authenticated;
grant select on public.meta_tokens to anon;
drop policy if exists policy_meta_tokens_select_authenticated on public.meta_tokens;
create policy policy_meta_tokens_select_authenticated
  on public.meta_tokens for select to authenticated
  using (true);

-- ── F-06 ────────────────────────────────────────────────────────────────────
-- Restore the table-level UPDATE grant. This re-opens self-writable
-- password_changed_at / is_active / force_password_change / email.
revoke update on public.profiles from authenticated;
grant update on public.profiles to authenticated;

-- ── F-08 ────────────────────────────────────────────────────────────────────
-- Restore the unconstrained audit INSERT policy, i.e. actor forgery, and remove
-- the server-only policies the forward migration guarantees. Reverting this also
-- requires reverting the src/proxy.ts change in the same commit, which is what
-- reintroduces the caller-scoped PAGE_VISIT write that needed the permissive
-- policy in the first place.
drop policy if exists policy_audit_logs_insert_server_only on public.audit_logs;
create policy policy_audit_logs_insert_authenticated
  on public.audit_logs for insert to authenticated
  with check (true);

-- activity_logs and user_session_daily are restored to the server_only policy
-- that 20260723130000_lock_definer_boundaries.sql defines, NOT to a permissive
-- one: `with check (false)` is the state the forward migration found in a
-- fully-migrated database, so recreating anything looser would not be a
-- rollback. Where 20260723130000 has not been applied these tables had no
-- authenticated INSERT policy at all, and dropping is the correct revert; both
-- shapes are covered by leaving the server_only policy in place.
--
-- Nothing to do here — the forward migration's effect on these two tables is
-- either a no-op or a tightening that must not be undone. Left explicit so the
-- omission is visibly deliberate.

commit;
