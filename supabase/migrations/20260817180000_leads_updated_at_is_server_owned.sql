-- ============================================================================
-- R6 · ensure leads.updated_at is server-owned without duplicating production
-- ============================================================================
-- `updated_at` is the compare-and-set token used by reassign_lead_atomic(). A
-- writable environment therefore needs an unconditional server-clock stamp on
-- every row UPDATE. The authenticated production catalog capture proves that
-- production already has exactly such a guard:
--
--   trg_set_updated_at BEFORE UPDATE FOR EACH ROW
--   public.set_updated_at(): NEW.updated_at = now(); RETURN NEW;
--
-- The historical replay floor did not model that object. This migration is a
-- cross-environment backstop, not a claim that production lacks the guard:
--
--   * if an enabled, unconditional BEFORE UPDATE ROW trigger on public.leads
--     invokes a SECURITY INVOKER trigger function whose complete body is the
--     unconditional server-clock assignment plus RETURN NEW, this file changes no
--     trigger, function or ACL and emits no schema-reload notification;
--   * only when no such guard exists does it create the repository-owned
--     public.leads_stamp_updated_at()/zz_leads_stamp_updated_at pair;
--   * re-entry sees the created pair as an existing valid guard and is a no-op.
--
-- The catalog test deliberately requires no UPDATE OF list and no WHEN clause.
-- A conditional stamp would leave some lead mutations on the old token. The
-- function-body match is strict after whitespace removal, so a function that only
-- sometimes assigns NEW.updated_at cannot satisfy the guard by containing a
-- convenient substring.
--
-- The application routes are separately moved to audited/CAS routines. This
-- database boundary remains necessary for direct PostgREST or service-role writes
-- and for fresh environments whose historical schema lacks production's trigger.
--
-- NO_ROLLBACK: on production this migration is a catalog-proven no-op; on an
-- environment where it creates the missing guard, removing it would make the CAS
-- token client-pinnable again. The additive trigger/function pair has no data
-- backfill and is compatible with applications that omit updated_at.
-- ============================================================================

begin;

do $migration$
declare
  v_valid_count integer;
  v_valid_names text;
  v_zz_valid boolean;
  v_zz_exists boolean;
  v_role name;
begin
  if to_regclass('public.leads') is null then
    raise exception 'public.leads is absent; cannot establish an updated_at CAS token';
  end if;
  if not exists (
    select 1
      from pg_catalog.pg_attribute a
     where a.attrelid = 'public.leads'::regclass
       and a.attname = 'updated_at'
       and not a.attisdropped
       and a.atttypid = 'timestamp with time zone'::regtype
  ) then
    raise exception 'public.leads.updated_at is absent or is not timestamptz';
  end if;

  select count(*), string_agg(t.tgname, ', ' order by t.tgname),
         coalesce(bool_or(t.tgname = 'zz_leads_stamp_updated_at'), false)
    into v_valid_count, v_valid_names, v_zz_valid
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_proc p on p.oid = t.tgfoid
   where t.tgrelid = 'public.leads'::regclass
     and not t.tgisinternal
     and t.tgenabled = 'O'
     and (t.tgtype & 1) = 1             -- row
     and (t.tgtype & 2) = 2             -- before
     and (t.tgtype & 16) = 16           -- update
     and t.tgattr::text = ''            -- every UPDATE, not UPDATE OF ...
     and t.tgqual is null                -- unconditional
     and not p.prosecdef                 -- trigger executes as invoker
     and pg_catalog.regexp_replace(p.prosrc, '[[:space:]]+', '', 'g')
           ~* '^beginnew[.]updated_at(:=|=)(pg_catalog[.])?now[(][)];returnnew;end;?$';

  select exists (
    select 1 from pg_catalog.pg_trigger t
     where t.tgrelid = 'public.leads'::regclass
       and not t.tgisinternal
       and t.tgname = 'zz_leads_stamp_updated_at'
  ) into v_zz_exists;

  if v_valid_count > 0 then
    if v_zz_exists and not v_zz_valid then
      raise exception 'zz_leads_stamp_updated_at exists but is not a valid unconditional server-clock stamp';
    end if;
    raise notice 'R6 no-op: leads.updated_at already has % valid server-clock stamp trigger(s): %',
      v_valid_count, v_valid_names;
    return;
  end if;

  -- No valid guard exists. A stale object under this migration's reserved name
  -- is replaced; unrelated triggers are never dropped or rewritten.
  execute $ddl$
    create or replace function public.leads_stamp_updated_at()
    returns trigger
    language plpgsql
    security invoker
    set search_path = pg_catalog, public, pg_temp
    as $fn$
    begin
      new.updated_at := pg_catalog.now();
      return new;
    end
    $fn$
  $ddl$;
  execute 'revoke all on function public.leads_stamp_updated_at() from public, anon, authenticated, service_role';
  execute 'drop trigger if exists zz_leads_stamp_updated_at on public.leads';
  execute $ddl$
    create trigger zz_leads_stamp_updated_at
      before update on public.leads
      for each row
      execute function public.leads_stamp_updated_at()
  $ddl$;

  select count(*), string_agg(t.tgname, ', ' order by t.tgname),
         coalesce(bool_or(t.tgname = 'zz_leads_stamp_updated_at'), false)
    into v_valid_count, v_valid_names, v_zz_valid
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_proc p on p.oid = t.tgfoid
   where t.tgrelid = 'public.leads'::regclass
     and not t.tgisinternal
     and t.tgenabled = 'O'
     and (t.tgtype & 1) = 1
     and (t.tgtype & 2) = 2
     and (t.tgtype & 16) = 16
     and t.tgattr::text = ''
     and t.tgqual is null
     and not p.prosecdef
     and pg_catalog.regexp_replace(p.prosrc, '[[:space:]]+', '', 'g')
           ~* '^beginnew[.]updated_at(:=|=)(pg_catalog[.])?now[(][)];returnnew;end;?$';
  if v_valid_count < 1 or not v_zz_valid then
    raise exception 'the fallback leads.updated_at server-clock stamp was not established';
  end if;

  if has_function_privilege('public', 'public.leads_stamp_updated_at()'::regprocedure, 'execute') then
    raise exception 'public.leads_stamp_updated_at() is executable by PUBLIC';
  end if;
  for v_role in
    select r.rolname from pg_catalog.pg_roles r
     where r.rolname in ('anon', 'authenticated', 'service_role')
  loop
    if has_function_privilege(v_role, 'public.leads_stamp_updated_at()'::regprocedure, 'execute') then
      raise exception 'public.leads_stamp_updated_at() is executable by %', v_role;
    end if;
  end loop;

  perform pg_catalog.pg_notify('pgrst', 'reload schema');
  raise notice 'R6 created fallback: leads.updated_at is stamped by zz_leads_stamp_updated_at';
end
$migration$;

commit;
