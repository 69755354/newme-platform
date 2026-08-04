\set ON_ERROR_STOP on

DO $$
BEGIN
  IF to_regclass('public.organization_subscriptions') IS NOT NULL
    OR to_regclass('public.commercial_plan_versions') IS NOT NULL
    OR to_regclass('public.commercial_action_requests') IS NOT NULL
    OR to_regprocedure('public.v4_record_commercial_usage(uuid,text,bigint,text,text,timestamp with time zone,timestamp with time zone,jsonb)') IS NOT NULL
  THEN RAISE EXCEPTION 'sam79_rollback_objects_remain'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint constraint_row
    JOIN pg_class relation ON relation.oid = constraint_row.conrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public' AND relation.relname = 'organizations'
      AND constraint_row.conname = 'organizations_billable_seat_limit_check'
      AND pg_get_constraintdef(constraint_row.oid) NOT LIKE '%billable_seat_limit >= 3%'
  ) THEN RAISE EXCEPTION 'sam79_rollback_seat_constraint_not_restored'; END IF;
END
$$;

SELECT 'sam79_commercial_control_plane_rollback_verified' AS result;
