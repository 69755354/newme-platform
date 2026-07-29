\set ON_ERROR_STOP on

DO $$
DECLARE
  remaining_tables integer;
  remaining_functions integer;
  remaining_columns integer;
  remaining_policies integer;
  remaining_triggers integer;
BEGIN
  SELECT count(*) INTO remaining_tables
  FROM pg_class relation
  JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND relation.relname IN (
      'organizations',
      'memberships',
      'platform_staff',
      'support_sessions',
      'audit_events'
    );

  SELECT count(*) INTO remaining_functions
  FROM pg_proc procedure
  JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname = 'public'
    AND procedure.proname IN (
      'requested_organization_id',
      'enforce_lead_organization_context',
      'enforce_lead_child_organization_context'
    );

  SELECT count(*) INTO remaining_columns
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'leads'
    AND column_name = 'organization_id';

  SELECT count(*) INTO remaining_policies
  FROM pg_policies
  WHERE schemaname = 'public'
    AND policyname LIKE 'sam20_%_organization_boundary';

  SELECT count(*) INTO remaining_triggers
  FROM pg_trigger trigger
  JOIN pg_class relation ON relation.oid = trigger.tgrelid
  JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND NOT trigger.tgisinternal
    AND trigger.tgname IN (
      'sam20_enforce_lead_organization_context',
      'sam20_enforce_lead_child_organization_context'
    );

  IF remaining_tables <> 0
    OR remaining_functions <> 0
    OR remaining_columns <> 0
    OR remaining_policies <> 0
    OR remaining_triggers <> 0
  THEN
    RAISE EXCEPTION
      'SAM-20 rollback residue tables=% functions=% columns=% policies=% triggers=%',
      remaining_tables,
      remaining_functions,
      remaining_columns,
      remaining_policies,
      remaining_triggers;
  END IF;
END
$$;

SET ROLE authenticated;
SET request.jwt.claim.sub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
SET request.headers = '{}';

DO $$
DECLARE
  visible_count integer;
  inserted_id uuid;
BEGIN
  SELECT count(*) INTO visible_count FROM public.leads;
  IF visible_count <> 1 THEN
    RAISE EXCEPTION 'rollback old Lead read contract count %, expected 1', visible_count;
  END IF;

  UPDATE public.leads
  SET notes = 'rollback-old-contract'
  WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollback old Lead update contract failed';
  END IF;

  INSERT INTO public.leads(source, assigned_to, notes)
  VALUES (
    'offline',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'rollback-write-contract'
  )
  RETURNING id INTO inserted_id;

  INSERT INTO public.activities(lead_id, content)
  VALUES (inserted_id, 'rollback-child-write-contract');

  DELETE FROM public.activities WHERE lead_id = inserted_id;
  DELETE FROM public.leads WHERE id = inserted_id;
END
$$;

RESET ROLE;

SELECT 'SAM-20 rollback residue and old Lead read/write contract passed' AS result;
