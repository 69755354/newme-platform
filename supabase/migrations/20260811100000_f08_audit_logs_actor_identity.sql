-- F-08 · P1 · Any authenticated user can forge audit / session records
--
-- Live evidence (docs/rls-explorer.md:42, regenerated from production):
--   policy_audit_logs_insert_authenticated  INSERT {authenticated}  WITH CHECK (true)
-- Any of the 7 users could POST /rest/v1/audit_logs with an arbitrary actor_id,
-- fabricating an admin action or burying a real one under noise.
--
-- REVISED TWICE. Recording both corrections because each one was a different
-- class of mistake and the second was only visible from a full replay.
--
-- Revision 1 also CREATED authenticated INSERT policies on public.activity_logs
-- and public.user_session_daily, described as "the same forgeable shape on the
-- two sibling append-only tables". That was backwards: neither table had such a
-- policy, and no code path writes either one with a caller-scoped client. Adding
-- a constrained policy where none existed does not narrow a grant, it hands
-- `authenticated` an INSERT path it never had.
--
-- Revision 2 (this one) fixes a worse error. Revision 1 narrowed audit_logs to
-- `with check (actor_id = auth.uid())` on the premise that INSERT must stay
-- permissive for src/proxy.ts:281, which wrote PAGE_VISIT rows with the caller's
-- own RLS client. But 20260723130000_lock_definer_boundaries.sql:119-124 already
-- dropped policy_audit_logs_insert_authenticated on all three tables and
-- replaced it with `..._insert_server_only ... WITH CHECK (false)`, under the
-- heading "Audit/session records are server-owned evidence, never
-- browser-submitted facts". Production still shows the permissive `true` policy,
-- so that migration is not reflected there — but in any database where it HAS
-- run, RLS policies are permissive and OR together, so creating an
-- `actor_id = auth.uid()` policy REOPENS caller-side inserts that were already
-- closed. A remediation that widens access in the fully-migrated schema is not a
-- remediation.
--
-- This revision converges both states onto the tighter one:
--   * drop the permissive `..._insert_authenticated` policy if it is present
--     (production), and
--   * ensure `..._insert_server_only ... WITH CHECK (false)` exists on all three
--     tables (idempotent where 20260723130000 already ran).
-- After this, `authenticated` has no INSERT path to any of the three tables, and
-- service_role — which does not consult RLS — keeps writing them as it does now.
--
-- The one caller-scoped writer is removed in the same change: src/proxy.ts no
-- longer inserts PAGE_VISIT rows. That row is browser-triggered page telemetry,
-- not evidence; it is precisely what 20260723130000 meant by "never
-- browser-submitted facts", nothing in the product reads it (grep PAGE_VISIT →
-- only this file, the proxy, an old deploy backup and a docs plan), and
-- profiles.last_active_at still carries the activity signal the dashboard uses.
-- If page-visit telemetry is wanted back it has to be written server-side.
--
-- Verified before this revision: zero other caller-scoped writers for any of the
-- three tables. Every .from("audit_logs" | "activity_logs" |
-- "user_session_daily") followed by insert/update/upsert in src/ goes through
-- supabaseAdmin.
--
-- Guarded by supabase/replay/10_assert_release_contracts.sql (executed against a
-- real replayed schema by scripts/replay-migrations.sh) and
-- tests/security/audit-insert-policy.test.mjs.
--
-- Rollback: supabase/migrations/rollback_l0_20260811.sql

begin;

-- audit_logs
drop policy if exists policy_audit_logs_insert_authenticated on public.audit_logs;
drop policy if exists policy_audit_logs_insert_server_only  on public.audit_logs;
create policy policy_audit_logs_insert_server_only
  on public.audit_logs for insert to authenticated
  with check (false);

-- activity_logs
drop policy if exists policy_activity_logs_insert_authenticated on public.activity_logs;
drop policy if exists policy_activity_logs_insert_server_only  on public.activity_logs;
create policy policy_activity_logs_insert_server_only
  on public.activity_logs for insert to authenticated
  with check (false);

-- user_session_daily
drop policy if exists policy_user_session_daily_insert_authenticated on public.user_session_daily;
drop policy if exists policy_user_session_daily_insert_server_only  on public.user_session_daily;
create policy policy_user_session_daily_insert_server_only
  on public.user_session_daily for insert to authenticated
  with check (false);

commit;
