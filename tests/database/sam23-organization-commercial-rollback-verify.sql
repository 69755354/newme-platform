\set ON_ERROR_STOP on

DO $$
BEGIN
  IF to_regclass('public.roles') IS NOT NULL
    OR to_regclass('public.membership_roles') IS NOT NULL
    OR to_regclass('public.organization_provisioning_requests') IS NOT NULL
    OR to_regclass('public.v_sam23_organization_commercial_summary') IS NOT NULL
  THEN
    RAISE EXCEPTION 'SAM-23 rollback left new relations';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns column_info
    WHERE column_info.table_schema = 'public'
      AND (
        (column_info.table_name = 'organizations'
          AND column_info.column_name IN ('plan_key', 'billable_seat_limit'))
        OR (
          column_info.table_name IN (
            'quotations',
            'contracts',
            'contract_approvals',
            'installment_plans',
            'payments',
            'payment_allocations',
            'projects',
            'tasks',
            'lead_documents'
          )
          AND column_info.column_name = 'organization_id'
        )
      )
  ) THEN
    RAISE EXCEPTION 'SAM-23 rollback left organization columns';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.quotations'::regclass
      AND conname = 'quotations_quote_no_key'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.contracts'::regclass
      AND conname = 'contracts_contract_no_key'
  ) THEN
    RAISE EXCEPTION 'SAM-23 rollback did not restore global number constraints';
  END IF;

  IF to_regclass('public.organizations') IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM information_schema.columns column_info
      WHERE column_info.table_schema = 'public'
        AND column_info.table_name = 'leads'
        AND column_info.column_name = 'organization_id'
    )
  THEN
    RAISE EXCEPTION 'SAM-23 rollback damaged SAM-20 schema';
  END IF;
END
$$;

SELECT 'SAM-23 rollback restored SAM-20 contract' AS result;
