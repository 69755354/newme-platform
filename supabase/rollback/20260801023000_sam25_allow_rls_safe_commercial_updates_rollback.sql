DO $$
BEGIN
  IF current_setting('newme.environment', true) NOT IN ('staging', 'test') THEN
    RAISE EXCEPTION 'sam25_commercial_update_rollback_requires_staging_or_test';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.sam23_assign_commercial_organization()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  row_data jsonb := to_jsonb(NEW);
  primary_parent_id uuid;
  secondary_parent_id uuid;
  expected_organization_id uuid;
  secondary_organization_id uuid;
  assignee_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  CASE TG_TABLE_NAME
    WHEN 'quotations' THEN
      primary_parent_id := NULLIF(row_data ->> 'lead_id', '')::uuid;
      secondary_parent_id := NULLIF(row_data ->> 'contract_id', '')::uuid;
      SELECT lead_row.organization_id INTO expected_organization_id
      FROM public.leads lead_row WHERE lead_row.id = primary_parent_id;
      IF secondary_parent_id IS NOT NULL THEN
        SELECT contract.organization_id INTO secondary_organization_id
        FROM public.contracts contract
        WHERE contract.id = secondary_parent_id;
      END IF;
    WHEN 'contracts' THEN
      primary_parent_id := NULLIF(row_data ->> 'lead_id', '')::uuid;
      secondary_parent_id := NULLIF(row_data ->> 'quotation_id', '')::uuid;
      SELECT lead_row.organization_id INTO expected_organization_id
      FROM public.leads lead_row WHERE lead_row.id = primary_parent_id;
      IF secondary_parent_id IS NOT NULL THEN
        SELECT quotation.organization_id INTO secondary_organization_id
        FROM public.quotations quotation
        WHERE quotation.id = secondary_parent_id;
      END IF;
    WHEN 'installment_plans', 'contract_approvals' THEN
      primary_parent_id := NULLIF(row_data ->> 'contract_id', '')::uuid;
      SELECT contract.organization_id INTO expected_organization_id
      FROM public.contracts contract WHERE contract.id = primary_parent_id;
    WHEN 'payments' THEN
      primary_parent_id := NULLIF(row_data ->> 'contract_id', '')::uuid;
      secondary_parent_id :=
        NULLIF(row_data ->> 'installment_plan_id', '')::uuid;
      SELECT contract.organization_id INTO expected_organization_id
      FROM public.contracts contract WHERE contract.id = primary_parent_id;
      IF secondary_parent_id IS NOT NULL THEN
        SELECT plan.organization_id INTO secondary_organization_id
        FROM public.installment_plans plan
        WHERE plan.id = secondary_parent_id;
      END IF;
    WHEN 'payment_allocations' THEN
      primary_parent_id := NULLIF(row_data ->> 'payment_id', '')::uuid;
      secondary_parent_id := NULLIF(row_data ->> 'plan_id', '')::uuid;
      SELECT payment.organization_id INTO expected_organization_id
      FROM public.payments payment WHERE payment.id = primary_parent_id;
      SELECT plan.organization_id INTO secondary_organization_id
      FROM public.installment_plans plan WHERE plan.id = secondary_parent_id;
    WHEN 'projects' THEN
      primary_parent_id := NULLIF(row_data ->> 'contract_id', '')::uuid;
      secondary_parent_id := NULLIF(row_data ->> 'lead_id', '')::uuid;
      IF primary_parent_id IS NOT NULL THEN
        SELECT contract.organization_id INTO expected_organization_id
        FROM public.contracts contract WHERE contract.id = primary_parent_id;
      END IF;
      IF secondary_parent_id IS NOT NULL THEN
        SELECT lead_row.organization_id INTO secondary_organization_id
        FROM public.leads lead_row WHERE lead_row.id = secondary_parent_id;
      END IF;
      IF expected_organization_id IS NULL THEN
        expected_organization_id := secondary_organization_id;
        secondary_organization_id := NULL;
      END IF;
    WHEN 'tasks', 'lead_documents' THEN
      primary_parent_id := NULLIF(row_data ->> 'lead_id', '')::uuid;
      SELECT lead_row.organization_id INTO expected_organization_id
      FROM public.leads lead_row WHERE lead_row.id = primary_parent_id;
    ELSE
      RAISE EXCEPTION 'sam23_unsupported_commercial_table:%', TG_TABLE_NAME;
  END CASE;

  IF expected_organization_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'commercial_parent_organization_missing';
  END IF;
  IF secondary_parent_id IS NOT NULL
    AND secondary_organization_id IS NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'commercial_secondary_parent_missing';
  END IF;
  IF secondary_organization_id IS NOT NULL
    AND secondary_organization_id <> expected_organization_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commercial_cross_organization_parent';
  END IF;

  IF NEW.organization_id IS NULL THEN
    NEW.organization_id := expected_organization_id;
  ELSIF NEW.organization_id <> expected_organization_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commercial_organization_parent_mismatch';
  END IF;

  IF TG_OP = 'UPDATE'
    AND NEW.organization_id IS DISTINCT FROM OLD.organization_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'commercial_organization_is_immutable';
  END IF;

  IF TG_TABLE_NAME IN ('contract_approvals', 'payment_allocations') THEN
    NEW.tenant_id := expected_organization_id;
  END IF;

  IF TG_TABLE_NAME = 'tasks' THEN
    assignee_id := NULLIF(row_data ->> 'assignee_id', '')::uuid;
    IF assignee_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM public.memberships membership
      WHERE membership.organization_id = expected_organization_id
        AND membership.user_id = assignee_id
        AND membership.status = 'active'
        AND membership.accepted_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'task_assignee_active_organization_membership_required';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sam23_assign_commercial_organization()
  FROM PUBLIC;

NOTIFY pgrst, 'reload schema';
