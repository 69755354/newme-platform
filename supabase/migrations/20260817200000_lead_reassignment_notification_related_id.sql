-- ============================================================================
-- R6 · normalize reassign_lead_atomic() only when related_id is uuid
-- ============================================================================
-- The historical replay floor models notifications.related_id as uuid and the
-- legacy routine inserts p_lead_id::text. PostgreSQL refuses that assignment with
-- SQLSTATE 42804 after the activities domain is widened. The authenticated
-- production capture is different and authoritative for deployment:
--
--   notifications.related_id = text
--   reassign_lead_atomic() inserts p_lead_id (without ::text)
--
-- Consequently the uuid/text finding is CONFIRMED only on the legacy floor and
-- REFUTED on captured production. This migration is catalog-aware:
--
--   * uuid target + legacy cast: replace exactly one catalog-derived literal;
--   * uuid target + canonical expression: no-op (re-entry);
--   * text target + either recognized expression: strict no-op;
--   * any other type/body: fail closed rather than guess.
--
-- The substitution is derived from pg_get_functiondef(), changes exactly the six
-- bytes of `::text`, and must preserve owner, ACL, SECURITY DEFINER, language,
-- proconfig and the first-statement session boundary.
--
-- NO_ROLLBACK: on captured production this migration is a catalog-proven no-op;
-- on a uuid target the legacy cast makes every real reassignment abort with 42804,
-- so restoring it is not a safe rollback. No table data or signature is changed.
-- ============================================================================

begin;

do $migration$
declare
  v_sig constant text := 'public.reassign_lead_atomic(uuid, uuid, timestamptz, uuid, text)';
  v_bad constant text := 'p_lead_id::text, ''lead''';
  v_good constant text := 'p_lead_id, ''lead''';
  v_oid oid;
  v_def text;
  v_new text;
  v_bad_n integer;
  v_good_n integer;
  v_related_type text;
  v_patched boolean := false;
  v_owner oid;
  v_acl aclitem[];
  v_config text[];
  v_secdef boolean;
  v_lang name;
  v_src text;
begin
  select c.data_type
    into v_related_type
    from information_schema.columns c
   where c.table_schema = 'public'
     and c.table_name = 'notifications'
     and c.column_name = 'related_id';
  if v_related_type not in ('uuid', 'text') then
    raise exception 'public.notifications.related_id has unsupported data_type %; expected uuid or text',
      coalesce(v_related_type, '<missing>');
  end if;

  v_oid := to_regprocedure(v_sig);
  if v_oid is null then
    raise exception '% is not installed', v_sig;
  end if;

  select p.proowner, p.proacl, p.proconfig, p.prosecdef, l.lanname, p.prosrc,
         pg_catalog.pg_get_functiondef(p.oid)
    into v_owner, v_acl, v_config, v_secdef, v_lang, v_src, v_def
    from pg_catalog.pg_proc p
    join pg_catalog.pg_language l on l.oid = p.prolang
   where p.oid = v_oid;

  v_bad_n := (length(v_def) - length(replace(v_def, v_bad, ''))) / length(v_bad);
  v_good_n := (length(v_def) - length(replace(v_def, v_good, ''))) / length(v_good);

  if v_bad_n > 1 then
    raise exception '% carries % legacy cast occurrences; expected at most one', v_sig, v_bad_n;
  end if;
  if v_bad_n = 0 and v_good_n = 0 then
    raise exception '% carries neither the legacy nor canonical notifications INSERT expression', v_sig;
  end if;

  if v_related_type = 'uuid' and v_bad_n = 1 then
    v_new := replace(v_def, v_bad, v_good);
    if length(v_def) - length(v_new) <> 6 then
      raise exception 'normalizing % changed % bytes, not the 6 bytes of ::text',
        v_sig, length(v_def) - length(v_new);
    end if;
    execute v_new;
    v_patched := true;
  end if;

  -- Re-read the installed object. CREATE OR REPLACE must not loosen the routine
  -- boundary or silently drop configuration/ownership/ACL.
  select p.prosecdef, l.lanname, p.prosrc, pg_catalog.pg_get_functiondef(p.oid)
    into v_secdef, v_lang, v_src, v_def
    from pg_catalog.pg_proc p
    join pg_catalog.pg_language l on l.oid = p.prolang
   where p.oid = v_oid;

  if v_related_type = 'uuid'
     and position('p_lead_id::text, ''lead''' in v_def) > 0 then
    raise exception '% still casts the lead id to text for a uuid related_id target', v_sig;
  end if;
  if position(v_good in v_def) = 0 and position(v_bad in v_def) = 0 then
    raise exception '% no longer carries the recognized notifications INSERT', v_sig;
  end if;
  if not v_secdef or v_lang <> 'plpgsql' then
    raise exception '% changed execution posture (security_definer %, language %)',
      v_sig, v_secdef, v_lang;
  end if;
  if v_src !~* '(^|\n)[ \t]*begin[ \t]*\r?\n[ \t]*perform[ \t]+public[.]assert_current_session_at_entry[(][)];' then
    raise exception '% no longer asserts the current session as its first executable statement', v_sig;
  end if;
  if (select p.proowner from pg_catalog.pg_proc p where p.oid = v_oid) is distinct from v_owner
     or (select p.proacl from pg_catalog.pg_proc p where p.oid = v_oid) is distinct from v_acl
     or (select p.proconfig from pg_catalog.pg_proc p where p.oid = v_oid) is distinct from v_config then
    raise exception '% owner, ACL or proconfig changed during normalization', v_sig;
  end if;

  if has_function_privilege('public', v_oid, 'execute')
     or (exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
         and has_function_privilege('anon', v_oid, 'execute')) then
    raise exception '% is executable by PUBLIC or anon', v_sig;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated')
     or not has_function_privilege('authenticated', v_oid, 'execute') then
    raise exception '% is not executable by authenticated', v_sig;
  end if;

  if v_patched then
    perform pg_catalog.pg_notify('pgrst', 'reload schema');
    raise notice 'R6 normalized legacy uuid target: removed one ::text cast and preserved owner/ACL/config/session boundary';
  else
    raise notice 'R6 no-op: related_id type %, routine already uses a recognized compatible expression', v_related_type;
  end if;
end
$migration$;

commit;
