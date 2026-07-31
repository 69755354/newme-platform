-- SAM-23 staging/test-only rollback.
-- Refuses to remove organization ownership while any non-legacy organization
-- or provisioning request remains.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  environment_name text := current_setting('newme.environment', true);
  legacy_organization_id constant uuid :=
    '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1'::uuid;
  table_name text;
  foreign_rows bigint;
BEGIN
  IF environment_name IS NULL
    OR environment_name NOT IN ('staging', 'test')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'sam23_rollback_requires_staging_or_test';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.organizations
    WHERE id <> legacy_organization_id
  ) THEN
    RAISE EXCEPTION 'sam23_rollback_nonlegacy_organizations_not_clean';
  END IF;
  IF EXISTS (SELECT 1 FROM public.organization_provisioning_requests) THEN
    RAISE EXCEPTION 'sam23_rollback_provisioning_requests_not_clean';
  END IF;

  FOREACH table_name IN ARRAY ARRAY[
    'quotations',
    'contracts',
    'contract_approvals',
    'installment_plans',
    'payments',
    'payment_allocations',
    'projects',
    'tasks',
    'lead_documents'
  ]
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM public.%I WHERE organization_id <> $1',
      table_name
    )
    INTO foreign_rows
    USING legacy_organization_id;
    IF foreign_rows <> 0 THEN
      RAISE EXCEPTION
        'sam23_rollback_nonlegacy_rows_not_clean:%:%',
        table_name,
        foreign_rows;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT quote_no
    FROM public.quotations
    GROUP BY quote_no
    HAVING count(*) > 1
  ) OR EXISTS (
    SELECT contract_no
    FROM public.contracts
    GROUP BY contract_no
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'sam23_rollback_global_number_collision';
  END IF;
END
$$;

DROP VIEW IF EXISTS public.v_sam23_organization_commercial_summary;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'quotations',
    'contracts',
    'contract_approvals',
    'installment_plans',
    'payments',
    'payment_allocations',
    'projects',
    'tasks',
    'lead_documents'
  ]
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS sam23_assign_commercial_organization
         ON public.%I',
      table_name
    );
    EXECUTE format(
      'DROP POLICY IF EXISTS sam23_%I_organization_boundary ON public.%I',
      table_name,
      table_name
    );
  END LOOP;
END
$$;

DROP FUNCTION IF EXISTS public.sam23_assign_commercial_organization();

ALTER TABLE public.lead_documents
  DROP CONSTRAINT IF EXISTS lead_documents_organization_lead_fkey;
ALTER TABLE public.tasks
  DROP CONSTRAINT IF EXISTS tasks_organization_lead_fkey;
ALTER TABLE public.projects
  DROP CONSTRAINT IF EXISTS projects_organization_contract_fkey,
  DROP CONSTRAINT IF EXISTS projects_organization_lead_fkey,
  DROP CONSTRAINT IF EXISTS projects_organization_parent_required;
ALTER TABLE public.payment_allocations
  DROP CONSTRAINT IF EXISTS payment_allocations_organization_plan_fkey,
  DROP CONSTRAINT IF EXISTS payment_allocations_organization_payment_fkey;
ALTER TABLE public.contract_approvals
  DROP CONSTRAINT IF EXISTS contract_approvals_organization_contract_fkey;
ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_organization_installment_fkey,
  DROP CONSTRAINT IF EXISTS payments_organization_contract_fkey;
ALTER TABLE public.installment_plans
  DROP CONSTRAINT IF EXISTS installment_plans_organization_contract_fkey;
ALTER TABLE public.contracts
  DROP CONSTRAINT IF EXISTS contracts_organization_quotation_fkey,
  DROP CONSTRAINT IF EXISTS contracts_organization_lead_fkey;
ALTER TABLE public.quotations
  DROP CONSTRAINT IF EXISTS quotations_organization_contract_fkey,
  DROP CONSTRAINT IF EXISTS quotations_organization_lead_fkey;

DROP INDEX IF EXISTS public.installment_plans_organization_contract_seq_unique;
DROP INDEX IF EXISTS public.contracts_organization_contract_no_unique;
DROP INDEX IF EXISTS public.quotations_organization_quote_no_unique;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'lead_documents',
    'tasks',
    'projects',
    'payment_allocations',
    'payments',
    'installment_plans',
    'contract_approvals',
    'contracts',
    'quotations'
  ]
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I',
      table_name,
      table_name || '_organization_id_fkey'
    );
    EXECUTE format(
      'DROP INDEX IF EXISTS public.%I',
      table_name || '_organization_lookup_idx'
    );
    EXECUTE format(
      'DROP INDEX IF EXISTS public.%I',
      table_name || '_organization_id_id_unique'
    );
    EXECUTE format(
      'ALTER TABLE public.%I DROP COLUMN IF EXISTS organization_id',
      table_name
    );
  END LOOP;
END
$$;

UPDATE public.contract_approvals
SET tenant_id = '00000000-0000-0000-0000-000000000000'::uuid;
UPDATE public.payment_allocations
SET tenant_id = '00000000-0000-0000-0000-000000000000'::uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.quotations'::regclass
      AND conname = 'quotations_quote_no_key'
  ) THEN
    ALTER TABLE public.quotations
      ADD CONSTRAINT quotations_quote_no_key UNIQUE (quote_no);
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.contracts'::regclass
      AND conname = 'contracts_contract_no_key'
  ) THEN
    ALTER TABLE public.contracts
      ADD CONSTRAINT contracts_contract_no_key UNIQUE (contract_no);
  END IF;
END
$$;

DROP TRIGGER IF EXISTS sam23_membership_role_scope
  ON public.membership_roles;
DROP TRIGGER IF EXISTS sam23_membership_role_seat_limit
  ON public.membership_roles;
DROP TRIGGER IF EXISTS sam23_membership_seat_limit
  ON public.memberships;

DROP FUNCTION IF EXISTS public.initialize_organization(
  text, text, text, text, text, integer, uuid
);
DROP FUNCTION IF EXISTS public.sam23_enforce_membership_role_scope();
DROP FUNCTION IF EXISTS public.sam23_enforce_billable_seat_limit();
DROP FUNCTION IF EXISTS public.organization_billable_seat_count(uuid);

DROP TABLE IF EXISTS public.organization_provisioning_requests;
DROP TABLE IF EXISTS public.membership_roles;
DROP TABLE IF EXISTS public.roles;

ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS organizations_billable_seat_limit_check,
  DROP CONSTRAINT IF EXISTS organizations_plan_key_check,
  DROP COLUMN IF EXISTS billable_seat_limit,
  DROP COLUMN IF EXISTS plan_key;

NOTIFY pgrst, 'reload schema';

COMMIT;
