\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
  IF to_regprocedure(
      'public.product_saas_is_synthetic_organization(uuid)'
    ) IS NOT NULL
    OR to_regprocedure(
      'public.product_saas_is_synthetic_exit_approval(uuid)'
    ) IS NOT NULL
    OR to_regprocedure(
      'public.product_saas_is_synthetic_audit_log(uuid)'
    ) IS NOT NULL
    OR to_regprocedure(
      'public.product_saas_is_synthetic_audit_event(uuid)'
    ) IS NOT NULL
  THEN
    RAISE EXCEPTION 'SAM-78 Product/SaaS cleanup helpers survived rollback';
  END IF;
  IF pg_get_functiondef('public.v4_reject_mutation()'::regprocedure)
      ILIKE '%product_saas_is_synthetic_%'
    OR pg_get_functiondef(
      'public.v4_guard_platform_action_approval_update()'::regprocedure
    ) ILIKE '%product_saas_is_synthetic_%'
  THEN
    RAISE EXCEPTION 'SAM-78 Product/SaaS cleanup allowance survived rollback';
  END IF;
  IF pg_get_functiondef('public.v4_reject_mutation()'::regprocedure)
      NOT ILIKE '%sam20_is_synthetic_support_approval%'
    OR pg_get_functiondef('public.v4_reject_mutation()'::regprocedure)
      NOT ILIKE '%sam26-staging-uat%'
  THEN
    RAISE EXCEPTION 'SAM-78 rollback did not preserve prior cleanup boundaries';
  END IF;
  IF pg_get_functiondef(
      'public.v4_guard_platform_action_approval_update()'::regprocedure
    ) NOT ILIKE '%sam20_is_synthetic_support_approval%'
  THEN
    RAISE EXCEPTION 'SAM-78 rollback lost the SAM-20 approval boundary';
  END IF;
  IF (
    SELECT count(*) FROM pg_proc
    WHERE oid IN (
      'public.v4_reject_mutation()'::regprocedure,
      'public.v4_guard_platform_action_approval_update()'::regprocedure
    )
      AND proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
  ) <> 2 THEN
    RAISE EXCEPTION 'SAM-78 rollback changed prior trigger search_path';
  END IF;
END
$$;

ROLLBACK;

SELECT 'SAM-78 Product/SaaS cleanup rollback verified' AS result;
