-- F-02 · P0 · Default-credential admin account live in production
--
-- dev@newme.ae existed as one of only two admins, email-confirmed, unbanned,
-- with a password published in a public repo (src/app/api/dev/setup/route.ts).
--
-- Verified before writing this migration (live catalog, 2026-08-11):
--   * zero business rows reference it (leads/contracts/payments/customers/
--     projects/quotations/kpi_targets/transfer_history all 0)
--   * public.profiles has NO foreign key to auth.users, so deleting the auth
--     user alone would leave an orphaned admin profile row — both must go
--   * NO ACTION foreign keys block the profiles delete until its
--     notifications (14) and user_session_daily (34) rows are removed
--   * audit_logs.actor_id is ON DELETE SET NULL: 1514 rows lose attribution
--     (rows are retained; this is an accepted, documented forensic loss)
--   * 3 other usable privileged accounts survive, so this cannot lock anyone out

do $$
declare
  dev_id uuid;
begin
  select id into dev_id from auth.users where email = 'dev@newme.ae';
  if dev_id is null then
    raise notice 'dev@newme.ae absent - nothing to do';
    return;
  end if;

  -- Interlock: never remove the last usable privileged account.
  if (select count(*) from public.profiles p join auth.users u on u.id = p.id
      where p.role in ('admin','boss','operator') and p.is_active
        and p.id <> dev_id and u.last_sign_in_at is not null
        and (u.banned_until is null or u.banned_until <= now())) < 1 then
    raise exception 'aborted: no surviving usable privileged account';
  end if;

  delete from public.notifications      where user_id = dev_id;
  delete from public.user_session_daily where user_id = dev_id;
  delete from public.profiles           where id      = dev_id;
  delete from auth.users                where id      = dev_id;
end $$;
