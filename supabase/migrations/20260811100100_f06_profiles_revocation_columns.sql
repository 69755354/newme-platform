-- F-06 · P1 · Session-revocation flag is self-writable
--
-- policy_profiles_update_self (20260701000004_fix_profiles_rls_recursion.sql:68)
-- constrains only `role` in its WITH CHECK. is_active, password_changed_at and
-- force_password_change are plain columns and `authenticated` holds table-level
-- UPDATE, so a holder of a live token can PATCH password_changed_at back to NULL
-- and defeat the src/proxy.ts:237-249 revocation check — i.e. survive an
-- administrator's password reset.
--
-- Postgres cannot revoke a single column while a table-level UPDATE grant
-- exists, so drop the table grant and re-grant the permitted columns only.
--
-- REVISED 2026-08-11 after independent review. The previous revision re-granted
-- nine columns, including `email`. That kept open an account-takeover chain:
--   1. sales user PATCHes their own profiles.email to a victim's address
--      (policy_profiles_update_self permits it: id = auth.uid(), role unchanged)
--   2. POST /api/auth/change-password read the address to verify with from that
--      same self-writable row, then reset the password of the SESSION's auth
--      user via the admin API
-- The route half of that chain is fixed separately in
-- src/app/api/auth/change-password/route.ts, which now verifies against
-- user.email from auth.getUser(). The grant half is fixed here. Both are needed:
-- profiles.email is also the address shown in /api/auth/me and used by admin
-- tooling, and no user-facing flow writes it.
--
-- The grant is now the minimum the application actually needs. Every
-- caller-scoped write to public.profiles in the codebase was enumerated; there
-- is exactly one:
--     src/proxy.ts:268   update { last_active_at }   caller client
-- Everything else — /api/users/*, /api/auth/change-password, /api/dev/setup —
-- runs on supabaseAdmin (service_role), which is not affected by grants to
-- `authenticated`.
--
-- Denied by omission, and each for a reason:
--   is_active, force_password_change, password_changed_at  revocation state
--   role                                                   privilege
--   email                                                  identity / takeover
--   id, created_at, joined_at                              immutable identity
--   full_name, phone, avatar_url, manager_id, password_hint
--       no caller-scoped writer exists; re-grant them only together with the
--       self-service profile editor that needs them
--
-- Guarded by tests/security/profiles-grant-coupling.test.mjs, which fails if a
-- caller-scoped write appears for a column this migration does not grant.
--
-- Rollback: supabase/migrations/rollback_l0_20260811.sql

begin;

revoke update on public.profiles from authenticated;

grant update (
  last_active_at,   -- src/proxy.ts:268, the only caller-scoped profiles write
  updated_at        -- audit column, written alongside it
) on public.profiles to authenticated;

commit;
