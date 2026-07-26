-- SAM-61 live cleanroom gate.
-- Expected result: zero rows. Run against cleanroom-2 before staging promotion.
WITH expected(regprocedure) AS (
  -- BEGIN AUTHENTICATED_SECURITY_DEFINER_ALLOWLIST
  VALUES
    ('delete_lead_atomic(uuid,uuid)'),
    ('get_my_role()'),
    ('next_quote_no()'),
    ('reassign_lead_atomic(uuid,uuid,timestamp with time zone,uuid,text)'),
    ('recomplete_lead_milestone(uuid,text,text)'),
    ('record_lead_contact_atomic(uuid,text,timestamp with time zone,text,text,text,uuid)'),
    ('record_lead_note_atomic(uuid,text,uuid)'),
    ('reopen_lead_milestone(uuid,text,text)'),
    ('transition_lead_stage(uuid,text,text,text,uuid)')
  -- END AUTHENTICATED_SECURITY_DEFINER_ALLOWLIST
),
actual AS (
  SELECT
    p.oid,
    p.oid::regprocedure::text AS regprocedure,
    p.proconfig,
    pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
    pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute
  FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosecdef
),
violations AS (
  SELECT
    'unexpected_authenticated'::text AS violation,
    a.regprocedure
  FROM actual AS a
  LEFT JOIN expected AS e USING (regprocedure)
  WHERE a.authenticated_execute
    AND e.regprocedure IS NULL

  UNION ALL

  SELECT
    'missing_expected'::text,
    e.regprocedure
  FROM expected AS e
  LEFT JOIN actual AS a USING (regprocedure)
  WHERE a.oid IS NULL
    OR NOT a.authenticated_execute

  UNION ALL

  SELECT
    'anon_execute'::text,
    a.regprocedure
  FROM actual AS a
  WHERE a.anon_execute

  UNION ALL

  SELECT
    'unsafe_search_path'::text,
    a.regprocedure
  FROM actual AS a
  JOIN expected AS e USING (regprocedure)
  WHERE NOT (
    COALESCE(a.proconfig, ARRAY[]::text[])
    @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
  )
)
SELECT violation, regprocedure
FROM violations
ORDER BY violation, regprocedure;
