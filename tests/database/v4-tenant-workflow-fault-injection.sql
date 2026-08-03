\set ON_ERROR_STOP on

CREATE FUNCTION public.sam78_fail_contract_workflow_stage()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = current_setting('sam78.fail_table', true) THEN
    RAISE EXCEPTION 'sam78_injected_failure:%', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER sam78_fail_contracts BEFORE INSERT ON public.contracts
  FOR EACH ROW EXECUTE FUNCTION public.sam78_fail_contract_workflow_stage();
CREATE TRIGGER sam78_fail_installments BEFORE INSERT ON public.installment_plans
  FOR EACH ROW EXECUTE FUNCTION public.sam78_fail_contract_workflow_stage();
CREATE TRIGGER sam78_fail_approvals BEFORE INSERT ON public.contract_approvals
  FOR EACH ROW EXECUTE FUNCTION public.sam78_fail_contract_workflow_stage();
CREATE TRIGGER sam78_fail_quotations BEFORE UPDATE ON public.quotations
  FOR EACH ROW EXECUTE FUNCTION public.sam78_fail_contract_workflow_stage();
CREATE TRIGGER sam78_fail_leads BEFORE UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.sam78_fail_contract_workflow_stage();
CREATE TRIGGER sam78_fail_projects BEFORE INSERT ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.sam78_fail_contract_workflow_stage();
CREATE TRIGGER sam78_fail_activities BEFORE INSERT ON public.activities
  FOR EACH ROW EXECUTE FUNCTION public.sam78_fail_contract_workflow_stage();

CREATE FUNCTION public.sam78_assert_contract_workflow_rollback(
  p_operation text,
  p_stage text,
  p_before_sequence integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.contract_workflow_requests
    WHERE organization_id = '78000000-9090-4000-8000-000000000090'
      AND request_id = CASE p_operation
        WHEN 'create' THEN 'sam78.fault.create.' || p_stage
        ELSE 'sam78.fault.quote.' || p_stage
      END
  ) OR (SELECT next_value FROM public.organization_document_sequences
    WHERE organization_id = '78000000-9090-4000-8000-000000000090'
      AND document_kind = 'contract' AND document_date = current_date)
    IS DISTINCT FROM p_before_sequence
  THEN RAISE EXCEPTION '% fault left partial state:%', p_operation, p_stage; END IF;

  IF p_operation = 'quote' AND (
    NOT EXISTS (
      SELECT 1 FROM public.quotations
      WHERE id = '78000000-9391-4000-8000-000000000091'
        AND status = 'accepted' AND contract_id IS NULL
    ) OR NOT EXISTS (
      SELECT 1 FROM public.leads
      WHERE id = '78000000-9292-4000-8000-000000000092'
        AND final_status IS NULL
    )
  ) THEN RAISE EXCEPTION 'quotation fault left canonical state:%', p_stage; END IF;
END
$$;
REVOKE ALL ON FUNCTION public.sam78_assert_contract_workflow_rollback(
  text, text, integer
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sam78_assert_contract_workflow_rollback(
  text, text, integer
) TO authenticated;

SELECT set_config(
  'sam78.before_sequence',
  (SELECT next_value::text FROM public.organization_document_sequences
    WHERE organization_id = '78000000-9090-4000-8000-000000000090'
      AND document_kind = 'contract' AND document_date = current_date),
  false
);

SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0090-4000-8000-000000000090';
SET request.headers = '{"x-newme-organization-id":"78000000-9090-4000-8000-000000000090"}';
DO $$
DECLARE stage_name text;
BEGIN
  PERFORM set_config('sam78.fail_table', '', true);
  BEGIN
    PERFORM public.v4_create_contract_for_organization(
      '78000000-9090-4000-8000-000000000090',
      jsonb_build_object(
        'lead_id', '78000000-9293-4000-8000-000000000093',
        'amount', 100,
        'installments', jsonb_build_array(jsonb_build_object(
          'seq', 1, 'amount', 99.99, 'due_date', (current_date + 30)::text
        ))
      ),
      'sam78.invalid.total.0001'
    );
    RAISE EXCEPTION 'contract accepted mismatched installment total';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'contract_installments_total_mismatch' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.v4_create_contract_for_organization(
      '78000000-9090-4000-8000-000000000090',
      jsonb_build_object(
        'lead_id', '78000000-9293-4000-8000-000000000093',
        'amount', 100,
        'installments', jsonb_build_array(jsonb_build_object(
          'seq', 1, 'amount', 100, 'due_date', (current_date + 30)::text
        ))
      ),
      'short-key'
    );
    RAISE EXCEPTION 'contract accepted malformed idempotency key';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'contract_request_id_required' THEN RAISE; END IF;
  END;
  FOREACH stage_name IN ARRAY ARRAY[
    'contracts', 'installment_plans', 'contract_approvals', 'activities'
  ]
  LOOP
    PERFORM set_config('sam78.fail_table', stage_name, true);
    BEGIN
      PERFORM public.v4_create_contract_for_organization(
        '78000000-9090-4000-8000-000000000090',
        jsonb_build_object(
          'lead_id', '78000000-9293-4000-8000-000000000093',
          'amount', 100,
          'installments', jsonb_build_array(jsonb_build_object(
            'seq', 1, 'amount', 100, 'due_date', (current_date + 30)::text
          ))
        ),
        'sam78.fault.create.' || stage_name
      );
      RAISE EXCEPTION 'contract fault injection did not fail:%', stage_name;
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM NOT LIKE 'sam78_injected_failure:%' THEN RAISE; END IF;
    END;
    PERFORM public.sam78_assert_contract_workflow_rollback(
      'create', stage_name, current_setting('sam78.before_sequence')::integer
    );
  END LOOP;

  FOREACH stage_name IN ARRAY ARRAY[
    'contracts', 'installment_plans', 'contract_approvals',
    'quotations', 'leads', 'projects', 'activities'
  ]
  LOOP
    PERFORM set_config('sam78.fail_table', stage_name, true);
    BEGIN
      PERFORM public.v4_convert_quotation_for_organization(
        '78000000-9090-4000-8000-000000000090',
        '78000000-9391-4000-8000-000000000091',
        jsonb_build_object(
          'installments', jsonb_build_array(jsonb_build_object(
            'seq', 1, 'amount', 300, 'due_date', (current_date + 30)::text
          ))
        ),
        'sam78.fault.quote.' || stage_name
      );
      RAISE EXCEPTION 'quotation fault injection did not fail:%', stage_name;
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM NOT LIKE 'sam78_injected_failure:%' THEN RAISE; END IF;
    END;
    PERFORM public.sam78_assert_contract_workflow_rollback(
      'quote', stage_name, current_setting('sam78.before_sequence')::integer
    );
  END LOOP;
END
$$;
RESET ROLE;

DROP TRIGGER sam78_fail_contracts ON public.contracts;
DROP TRIGGER sam78_fail_installments ON public.installment_plans;
DROP TRIGGER sam78_fail_approvals ON public.contract_approvals;
DROP TRIGGER sam78_fail_quotations ON public.quotations;
DROP TRIGGER sam78_fail_leads ON public.leads;
DROP TRIGGER sam78_fail_projects ON public.projects;
DROP TRIGGER sam78_fail_activities ON public.activities;
DROP FUNCTION public.sam78_fail_contract_workflow_stage();
DROP FUNCTION public.sam78_assert_contract_workflow_rollback(text, text, integer);
