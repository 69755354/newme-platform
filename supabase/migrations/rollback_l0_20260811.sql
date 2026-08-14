-- Rollback companion for the six L0 audit migrations dated 20260811.
--
-- ROLLS_BACK: 20260811100000_f08_audit_logs_actor_identity.sql
-- ROLLS_BACK: 20260811100100_f06_profiles_revocation_columns.sql
-- ROLLS_BACK: 20260811100200_f10_meta_tokens_drop_permissive_select.sql
-- ROLLS_BACK: 20260811100300_f02_remove_default_credential_admin.sql
-- ROLLS_BACK: 20260811100400_f09_money_authorization_phase1.sql
-- ROLLS_BACK: 20260811100500_kpi_targets_atomic_replace.sql
--
-- NO_RECONTRACT: the one object this companion can remove is re-created by
-- re-running 20260811100500_kpi_targets_atomic_replace.sql itself, which is
-- idempotent by construction — `create unique index if not exists`,
-- `create or replace function`, then revoke/grant — so an operator re-deploying
-- after a rollback runs that file by hand and the function is back with the
-- definition this tree ships. See supabase/preflight/expand-contract-rollback.md
-- §5.1. A separate recontract_*.sql artifact would be a second copy of one
-- function body, i.e. a second definition that can drift from the migration. The
-- money contract phase needs a real one for the opposite reason: re-entering
-- 'strict' must be REFUSED unless the guards that enforce it are present and
-- enabled, and its forward migration does not check that.
--
-- Round-4 C4-2: "can remove" is now literal. The KPI section below reverts
-- 20260811100500 only while the live public.replace_kpi_targets(text, jsonb, uuid)
-- is still the one that migration created; once 20260817000000 has redefined it,
-- dropping it would remove the round-4 B7 carry-forward guard rather than revert a
-- round-1 migration, and would leave a strict database with no KPI save path and
-- no forward artifact able to restore one. The reasoning is at the section itself.
--
-- Not a migration: the Supabase CLI only applies files whose name begins with a
-- 14-digit timestamp, so this file is inert until an operator runs it
-- explicitly. Same convention as rollback_crm_v3.sql and rollback_p0_10.sql.
--
-- ============================================================================
-- A rollback does not reopen a vulnerability
-- ============================================================================
-- The reviewed revision of this file did. It executed cleanly, the replay gate
-- went green, and what it actually did was:
--
--   * re-enable dev@newme.ae — a credential published in a public git history —
--     by setting is_active = true, force_password_change = false;
--   * re-grant select/insert/update/delete on meta_tokens to authenticated and
--     select to anon, and recreate `using (true)`, making the plaintext Meta Ads
--     token readable by every logged-in user again;
--   * re-grant UPDATE on all of public.profiles to authenticated, restoring
--     self-writable is_active / force_password_change / email;
--   * recreate policy_audit_logs_insert_authenticated with `with check (true)`,
--     restoring audit-actor forgery;
--   * grant EXECUTE on the three money routines to PUBLIC and anon.
--
-- Every one of those is a step an operator would take at 3am during an incident,
-- expecting to undo a deployment. None of them is required in order to undo a
-- deployment. The vulnerabilities predate the release; reverting the release does
-- not require restoring them, and a file that restores them is not a rollback,
-- it is a re-exploit with a reassuring filename.
--
-- So this file reverts what can be reverted without weakening the system, and
-- for the rest it says plainly that there is nothing to revert. The result is
-- verified, not asserted: scripts/replay-migrations.sh runs
-- supabase/replay/20_assert_post_rollback.sql immediately after this file and
-- fails the job if the post-rollback state has any of those holes open.
--
-- ============================================================================
-- What an app-only rollback costs, and what to do instead
-- ============================================================================
-- If the application is rolled back to the previous release while the database
-- keeps the tightened grants, two flows behave differently:
--
--   * The old client-side profile writes (email, is_active) fail with 42501
--     instead of succeeding. That is the F-06 fix working; the old UI paths that
--     depended on them are the takeover vector, not a feature.
--   * The old Meta Ads panel reads meta_tokens directly and now gets no rows.
--     The replacement path is the server-side route; if the panel must work
--     during the rollback window, disable it rather than re-granting the table.
--
-- If a security control genuinely has to be lifted — for example the published
-- credential has to be usable for one authenticated operator action because no
-- replacement admin exists yet — that is a separate, individually authorised
-- change with its own approval and its own audit entry. It is deliberately NOT
-- available here as SQL to paste, because the whole failure mode this file now
-- guards against is a hole being reopened by someone following a runbook.
--
-- Sections are independent — run the whole file, or only the section for the
-- migration being reverted.

begin;

-- ── F-09 · money routine ACL ────────────────────────────────────────────────
-- 20260811100400 replaced "EXECUTE held through PUBLIC, plus anon" with explicit
-- grants to authenticated and service_role. Reverting it would mean handing
-- anonymous callers the ability to approve contracts and confirm payments.
--
-- Nothing to do. The forward migration's whole effect was to close that, and the
-- routines' own callers (the Next.js routes) authenticate before calling, so the
-- explicit grants are sufficient for the previous release as well.

-- ── F-02 · dev@newme.ae ─────────────────────────────────────────────────────
-- 20260811100300 set is_active = false and force_password_change = true on the
-- profile of a published credential.
--
-- Nothing to do. Re-enabling it is not part of reverting a deployment. Note also
-- that flipping those two columns never disabled the Auth identity or revoked
-- its sessions — see supabase/preflight/f02-credential-cutover.md — so there is
-- less here to revert than the previous revision of this file implied.

-- ── F-10 · meta_tokens exposure ─────────────────────────────────────────────
-- 20260811100200 dropped the `using (true)` SELECT policy and the table grants
-- that let every authenticated user read a plaintext third-party access token.
--
-- Nothing to do. See "What an app-only rollback costs" above for the panel.

-- ── F-06 · profiles UPDATE grant ────────────────────────────────────────────
-- 20260811100100 added password_changed_at / force_password_change and replaced
-- the table-level UPDATE grant with a column-level one.
--
-- The columns are additive and are left in place: dropping a column destroys
-- data and is not a revert. The grant is left tightened.

-- ── F-08 · audit actor identity ─────────────────────────────────────────────
-- 20260811100000 replaced the `with check (true)` audit INSERT policy with a
-- server-only one.
--
-- Nothing to do. Restoring actor forgery is not a rollback step. activity_logs
-- and user_session_daily keep the server_only policy that
-- 20260723130000_lock_definer_boundaries.sql defines, which is the state a
-- fully-migrated database was already in.

-- ── KPI atomic replace ──────────────────────────────────────────────────────
-- This one IS reverted, but only while the function is still the one
-- 20260811100500 created.
--
-- The original reasoning stands for that case: it is a function, its removal opens
-- nothing, and its only caller is src/app/api/kpi/targets/route.ts. Reverting the
-- route without reverting the function is harmless; reverting the function without
-- reverting the route makes POST /api/kpi/targets fail closed with 42883 rather
-- than silently falling back to the delete-then-insert pair that could lose a
-- period's targets. Failing closed is the intended behaviour of the pair.
--
-- Round-4 C4-2 · why it is now conditional
-- ----------------------------------------
-- 20260817000000 §14 REDEFINES public.replace_kpi_targets(text, jsonb, uuid). The
-- live function is then no longer the object this section reverts: it is the
-- round-4 one, which asserts the session boundary at entry, carries actual_amount
-- forward for every (target_type, assigned_to) pair that survives a replacement,
-- and refuses a payload that drops a pair still holding collected money (B7).
-- Dropping THAT is not a revert of 20260811100500, it is the removal of a round-4
-- integrity fix — the same argument this file already makes one paragraph down
-- about idx_kpi_targets_one_unassigned_per_period_type, and the same argument the
-- header makes about meta_tokens and dev@newme.ae.
--
-- It also produced a measurable dead end. Measured on PG 17.10, floor plus this
-- release's eighteen migrations in two phases: this drop ran, the money companion
-- returned the mode to compat, the re-contract companion returned it to strict —
-- and nothing put the function back, because a recorded migration is never applied
-- again and the re-contract companion touches one row in one table by charter. The
-- database sat in strict with the KPI save path absent while
-- `db-phase-push.mjs --phase deferred_contract --verify-only` reported three of
-- three posture predicates OK.
--
-- The discriminator is the round-4 session boundary: 20260811100500's body does not
-- call public.assert_current_session_at_entry() and 20260817000000's does. Testing
-- the live definition rather than the migration ledger keeps this section correct
-- on a database whose supabase_migrations.schema_migrations an operator has not
-- initialised — which is every replay database that was not built by
-- scripts/db-phase-push.mjs.
-- Round-4 R7 · the drop below took no lock and had no lock_timeout
-- ---------------------------------------------------------------
-- Two separate defects, both about work that is in flight when an operator runs
-- this by hand:
--
--   1 · No period lock. Every writer of public.kpi_targets — replace_kpi_targets,
--       clear_kpi_targets, confirm_payment and void_payment (20260817150000,
--       20260817160000) — serializes on
--           pg_advisory_xact_lock(hashtextextended('public.kpi_targets:' || period, 0))
--       This file wrote nothing to kpi_targets and so took nothing, which means it
--       removed the save path from underneath a save that was mid-transaction: the
--       in-flight call finishes against its resolved definition and commits, and
--       the next one gets 42883. Taking each live period's lock first makes this
--       drop wait for those writers to drain and stops new ones from starting
--       until it commits, which is the same ordering guarantee the money and
--       recontract companions get from the flip lock.
--   2 · No lock_timeout. An operator running a rollback by hand must not be able
--       to hang the transaction indefinitely on a lock while it already holds the
--       DDL locks the sections above took. 15s, the same bound those companions
--       use, and the same fail-fast preference: a rollback that stops with a
--       timeout is recoverable, one that blocks forever is an outage.
--
-- Bounded honestly: the periods are enumerated from kpi_targets, so a save that
-- is creating the FIRST rows of a brand-new period holds a key this scan cannot
-- see. That call still completes — a resolved function survives its own drop —
-- and the transaction it belongs to commits or rolls back on its own. What the
-- lock buys is every period that already exists, which is every period the KPI
-- screen can be editing.
do $do$
declare
  v_def    text;
  v_period text;
  v_locked int := 0;
begin
  if to_regprocedure('public.replace_kpi_targets(text, jsonb, uuid)') is null then
    raise notice 'replace_kpi_targets is already absent; nothing to revert';
    return;
  end if;
  v_def := pg_get_functiondef(to_regprocedure('public.replace_kpi_targets(text, jsonb, uuid)')::oid);
  if v_def like '%assert_current_session_at_entry%' then
    raise notice 'replace_kpi_targets is the 20260817000000 definition (B7 carry-forward); NOT dropping it — reverting below 20260817000000 is a separate, audited step';
    return;
  end if;

  perform set_config('lock_timeout',
                     coalesce(nullif(current_setting('lock_timeout'), '0'), '15s'),
                     true);

  -- Sorted, so two operators running rollbacks concurrently take the same keys in
  -- the same order and queue instead of deadlocking.
  if to_regclass('public.kpi_targets') is not null then
    for v_period in select distinct period from public.kpi_targets order by 1 loop
      perform pg_advisory_xact_lock(hashtextextended('public.kpi_targets:' || v_period, 0));
      v_locked := v_locked + 1;
    end loop;
  end if;

  drop function public.replace_kpi_targets(text, jsonb, uuid);
  raise notice 'dropped replace_kpi_targets (the 20260811100500 definition) with % period lock(s) held', v_locked;
end
$do$;

-- idx_kpi_targets_one_unassigned_per_period_type is NOT dropped. It is an
-- integrity constraint on business data, the old delete-then-insert route does
-- not violate it in normal operation, and dropping it would re-permit the
-- duplicate unassigned targets that make every KPI view double-count. If the old
-- route ever does hit it, it fails with 23505 instead of silently corrupting the
-- period, which is the better of the two outcomes.

commit;
