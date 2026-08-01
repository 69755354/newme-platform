BEGIN;

-- notifications.related_id is uuid in the canonical schema. The original
-- customer snapshot compared text-cast business IDs with that uuid column,
-- which made every export fail before a snapshot could be produced.
DO $migration$
DECLARE
  function_oid oid := to_regprocedure(
    'public.organization_customer_snapshot(uuid)'
  )::oid;
  function_sql text;
  corrected_sql text;
  old_token constant text := '::text = notification.related_id';
  new_token constant text := ' = notification.related_id';
  old_token_count integer;
  new_token_count integer;
  owner_before oid;
  acl_before aclitem[];
  config_before text[];
  owner_after oid;
  acl_after aclitem[];
  config_after text[];
BEGIN
  IF function_oid IS NULL THEN
    RAISE EXCEPTION 'organization_customer_snapshot_missing';
  END IF;

  SELECT pg_get_functiondef(function_oid), proowner, proacl, proconfig
  INTO function_sql, owner_before, acl_before, config_before
  FROM pg_proc
  WHERE oid = function_oid;

  old_token_count := (
    length(function_sql) - length(replace(function_sql, old_token, ''))
  ) / length(old_token);
  IF old_token_count <> 6 THEN
    RAISE EXCEPTION
      'organization_customer_snapshot_notification_contract_drift:%',
      old_token_count;
  END IF;

  corrected_sql := replace(function_sql, old_token, new_token);
  EXECUTE corrected_sql;

  function_oid := to_regprocedure(
    'public.organization_customer_snapshot(uuid)'
  )::oid;
  SELECT pg_get_functiondef(function_oid), proowner, proacl, proconfig
  INTO function_sql, owner_after, acl_after, config_after
  FROM pg_proc
  WHERE oid = function_oid;

  old_token_count := (
    length(function_sql) - length(replace(function_sql, old_token, ''))
  ) / length(old_token);
  new_token_count := (
    length(function_sql) - length(replace(function_sql, new_token, ''))
  ) / length(new_token);
  IF old_token_count <> 0 OR new_token_count <> 6 THEN
    RAISE EXCEPTION
      'organization_customer_snapshot_notification_fix_incomplete:%:%',
      old_token_count, new_token_count;
  END IF;
  IF owner_after IS DISTINCT FROM owner_before
    OR acl_after IS DISTINCT FROM acl_before
    OR config_after IS DISTINCT FROM config_before
  THEN
    RAISE EXCEPTION 'organization_customer_snapshot_security_metadata_drift';
  END IF;
END
$migration$;

NOTIFY pgrst, 'reload schema';

COMMIT;
