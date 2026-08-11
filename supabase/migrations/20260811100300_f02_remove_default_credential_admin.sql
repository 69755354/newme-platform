-- F-02 · P0 · Default-credential admin account live in production
--
-- dev@newme.ae exists as one of only two admins, email-confirmed and unbanned,
-- with a password published in a public repo
-- (src/app/api/dev/setup/route.ts: DEV_EMAIL / DEV_PASSWORD).
--
-- REVISED 2026-08-11 after independent review. The previous revision DELETED the
-- account:
--     delete from public.notifications      where user_id = dev_id;
--     delete from public.user_session_daily where user_id = dev_id;
--     delete from public.profiles           where id      = dev_id;
--     delete from auth.users                where id      = dev_id;
-- That is irreversible and destroys evidence. Its own header conceded the cost:
-- audit_logs.actor_id is ON DELETE SET NULL, so 1514 audit rows would silently
-- lose their actor. No down migration can restore a deleted auth identity or a
-- nulled actor_id, which means the change could not be rolled back if it turned
-- out to be wrong — and 48 notifications/session rows would go with it.
--
-- This revision neutralises the credential instead of deleting it. The account
-- stops being usable, every audit attribution survives, and the whole change is
-- reversible from rollback_l0_20260811.sql.
--
-- Why deactivation is sufficient, not cosmetic — the credential is dead at both
-- authentication boundaries:
--   * src/app/api/auth/login/route.ts:198 — isActiveProfile() fails, the route
--     returns 403 inactive_account, AND revokeIssuedToken() revokes upstream the
--     token the password grant just minted, so no session is ever established.
--   * src/proxy.ts:214 — any pre-existing token is rejected on every protected
--     request (401 inactive_account for /api/*, redirect for pages).
--   * src/app/api/auth/me/route.ts:97 — is_active !== true returns 401, so the
--     public refresh path cannot launder an old token either.
-- force_password_change is set as well, so even a future re-activation cannot
-- reach a dashboard on the published password.
--
-- The route that publishes the password cannot recreate the account in
-- production: src/app/api/dev/setup/route.ts:7 returns 403 when
-- NODE_ENV === "production" or NEXT_PUBLIC_DEV_MODE !== "true". Removing the
-- hardcoded credential from the repository is tracked separately as
-- PROD-F02-DEV-SETUP-CREDENTIAL-REMOVAL; it is a source change, not a data
-- change, and does not belong in a migration.
--
-- Deleting the identity outright remains an option once an operator has
-- confirmed out of band that no forensic need for the 1514 attributions
-- remains. It is deliberately NOT automated here.
--
-- Idempotent: re-applying is a no-op. Rollback:
-- supabase/migrations/rollback_l0_20260811.sql

do $$
declare
  dev_id uuid;
  surviving_admins int;
begin
  select id into dev_id from auth.users where email = 'dev@newme.ae';
  if dev_id is null then
    raise notice 'dev@newme.ae absent - nothing to do';
    return;
  end if;

  -- Interlock: never disable the last usable privileged account.
  select count(*) into surviving_admins
    from public.profiles p
    join auth.users u on u.id = p.id
   where p.role in ('admin','boss','operator')
     and p.is_active
     and p.id <> dev_id
     and u.last_sign_in_at is not null
     and (u.banned_until is null or u.banned_until <= now());

  if surviving_admins < 1 then
    raise exception 'aborted: no surviving usable privileged account';
  end if;

  update public.profiles
     set is_active             = false,
         force_password_change = true,
         updated_at            = now()
   where id = dev_id
     and (is_active is distinct from false
          or force_password_change is distinct from true);

  raise notice 'dev@newme.ae neutralised (is_active=false, force_password_change=true); % other usable privileged accounts', surviving_admins;
end $$;
