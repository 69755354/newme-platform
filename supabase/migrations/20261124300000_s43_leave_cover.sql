-- NO_ROLLBACK: additive only (three nullable profile columns, two check constraints, one index, two routines, one trigger); manual undo at the end of the file.
-- ============================================================================
-- OS fix S43 - leave cover (B13): a salesperson on leave names a colleague who receives the new-lead
-- assignment notifications and reminders for the leave period.
-- ============================================================================
-- profiles.cover_user_id   the colleague who covers (another active profile, never oneself)
-- profiles.cover_start     first day of the cover (Dubai calendar date, inclusive)
-- profiles.cover_end       last day of the cover (inclusive); both dates or neither
-- set_leave_cover(...)     admin / boss only; validates and writes the three columns in one call.
-- profiles_cover_admin_only  trigger: a signed-in non-admin/boss cannot write the three columns directly
--                          (policy_profiles_update_self lets anyone update their own row); service role / no session passes.
-- The application reads the columns through src/lib/leave-cover.mjs and only routes notifications to the
-- cover when NEWME_LEAVE_COVER_ENABLED=true (default off): storing a cover is harmless on its own.
-- Safe to run twice.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.profiles add column if not exists cover_user_id uuid references public.profiles(id) on delete set null;
alter table public.profiles add column if not exists cover_start date;
alter table public.profiles add column if not exists cover_end date;

do $do$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.profiles'::regclass and conname = 'profiles_cover_not_self') then
    alter table public.profiles add constraint profiles_cover_not_self check (cover_user_id is null or cover_user_id <> id);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.profiles'::regclass and conname = 'profiles_cover_dates') then
    alter table public.profiles add constraint profiles_cover_dates
      check ((cover_start is null) = (cover_end is null) and (cover_end is null or cover_end >= cover_start));
  end if;
end
$do$;

create index if not exists idx_profiles_cover_user on public.profiles (cover_user_id) where cover_user_id is not null;

-- ---------------------------------------------------------------------------
-- set_leave_cover: the only write path the application uses for these columns.
-- p_cover null (or p_start / p_end null) clears the cover.
-- ---------------------------------------------------------------------------
create or replace function public.set_leave_cover(p_user uuid, p_cover uuid, p_start date, p_end date)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set lock_timeout = '5s'
set statement_timeout = '20s'
as $fn$
declare
  v_actor uuid := auth.uid();
  v_role text;
  v_cover_active boolean;
begin
  perform public.assert_current_session_at_entry();
  if v_actor is null then
    raise exception using errcode = '42501', message = 'leave_cover_unauthorized';
  end if;
  select role into v_role from public.profiles where id = v_actor and is_active;
  if v_role is null or v_role not in ('admin', 'boss') then
    raise exception using errcode = '42501', message = 'leave_cover_not_allowed';
  end if;
  if p_user is null or not exists (select 1 from public.profiles where id = p_user) then
    raise exception using errcode = '22023', message = 'leave_cover_unknown_user';
  end if;
  if p_cover is null or p_start is null or p_end is null then
    update public.profiles set cover_user_id = null, cover_start = null, cover_end = null, updated_at = now() where id = p_user;
    return jsonb_build_object('user_id', p_user, 'cover_user_id', null, 'cover_start', null, 'cover_end', null);
  end if;
  if p_cover = p_user then
    raise exception using errcode = '22023', message = 'leave_cover_self';
  end if;
  if p_end < p_start then
    raise exception using errcode = '22023', message = 'leave_cover_dates';
  end if;
  select coalesce(is_active, false) into v_cover_active from public.profiles where id = p_cover;
  if v_cover_active is distinct from true then
    raise exception using errcode = '22023', message = 'leave_cover_inactive';
  end if;
  update public.profiles set cover_user_id = p_cover, cover_start = p_start, cover_end = p_end, updated_at = now() where id = p_user;
  return jsonb_build_object('user_id', p_user, 'cover_user_id', p_cover, 'cover_start', p_start, 'cover_end', p_end);
end
$fn$;

revoke all on function public.set_leave_cover(uuid, uuid, date, date) from public, anon;
grant execute on function public.set_leave_cover(uuid, uuid, date, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The three columns are admin/boss-only also for a direct UPDATE: the self-update policy on profiles would
-- otherwise let any signed-in user name a cover for themselves. set_leave_cover runs with the admin's
-- auth.uid() and passes; the service role (no auth.uid()) passes.
-- ---------------------------------------------------------------------------
create or replace function public.trg_profiles_cover_admin_only()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
begin
  if (new.cover_user_id is distinct from old.cover_user_id
      or new.cover_start is distinct from old.cover_start
      or new.cover_end is distinct from old.cover_end)
     and auth.uid() is not null
     and not exists (select 1 from public.profiles where id = auth.uid() and is_active and role in ('admin', 'boss')) then
    raise exception using errcode = '42501', message = 'leave_cover_not_allowed';
  end if;
  return new;
end
$fn$;

revoke all on function public.trg_profiles_cover_admin_only() from public, anon, authenticated;

drop trigger if exists profiles_cover_admin_only on public.profiles;
create trigger profiles_cover_admin_only
  before update of cover_user_id, cover_start, cover_end on public.profiles
  for each row execute function public.trg_profiles_cover_admin_only();

-- Manual undo (nothing else depends on these objects):
--   drop trigger if exists profiles_cover_admin_only on public.profiles;
--   drop function if exists public.trg_profiles_cover_admin_only();
--   drop function if exists public.set_leave_cover(uuid, uuid, date, date);
--   drop index if exists public.idx_profiles_cover_user;
--   alter table public.profiles drop constraint if exists profiles_cover_dates, drop constraint if exists profiles_cover_not_self;
--   alter table public.profiles drop column if exists cover_end, drop column if exists cover_start, drop column if exists cover_user_id;
