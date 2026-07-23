-- Keep quick-create ownership consistent with application RBAC.
-- Active admins can own Leads they create, just like boss/operator/sales.
create or replace function public.enforce_active_lead_transfer_candidate()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $function$
begin
  if new.assigned_to is not null
    and (tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to)
    and not exists (
      select 1
      from public.profiles
      where id = new.assigned_to
        and is_active = true
        and role in ('sales', 'operator', 'boss', 'admin')
    )
  then
    raise exception 'Lead assignee must be an active transfer candidate'
      using errcode = '23514';
  end if;

  return new;
end;
$function$;
