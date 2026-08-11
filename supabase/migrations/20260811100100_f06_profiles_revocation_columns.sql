-- F-06 · P1 · Session-revocation flag is self-writable
--
-- policy_profiles_update_self's WITH CHECK constrains only `role`. is_active,
-- password_changed_at and force_password_change are plain columns and
-- `authenticated` holds table-level UPDATE, so a holder of a live token can
-- PATCH password_changed_at back to NULL and defeat the src/proxy.ts:233-245
-- revocation check — i.e. survive an administrator's password reset.
--
-- Postgres cannot revoke a single column while a table-level UPDATE grant
-- exists, so drop the table grant and re-grant the permitted columns only.
-- Denied: is_active, password_changed_at, force_password_change (privilege and
-- revocation state), plus id/created_at/joined_at (immutable identity).
-- `role` is retained because policy_profiles_update_self already restricts it
-- to admin/boss, and admin flows go through service_role routes regardless.

begin;

revoke update on public.profiles from authenticated;

grant update (
  role,
  full_name,
  phone,
  avatar_url,
  updated_at,
  last_active_at,   -- written by src/proxy.ts:264 with the caller's own client
  manager_id,
  email,
  password_hint
) on public.profiles to authenticated;

commit;
