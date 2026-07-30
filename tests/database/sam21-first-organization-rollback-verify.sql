\set ON_ERROR_STOP on

DO $$
DECLARE
  before_row public.sam21_rehearsal_evidence%ROWTYPE;
  rollback_row public.sam21_rehearsal_evidence%ROWTYPE;
BEGIN
  INSERT INTO public.sam21_rehearsal_evidence
  SELECT
    'rollback'::text,
    metrics.*
  FROM public.sam21_rehearsal_metrics metrics;

  SELECT * INTO STRICT before_row
  FROM public.sam21_rehearsal_evidence
  WHERE phase = 'before';
  SELECT * INTO STRICT rollback_row
  FROM public.sam21_rehearsal_evidence
  WHERE phase = 'rollback';

  IF before_row.aggregate_counts IS DISTINCT FROM rollback_row.aggregate_counts
    OR before_row.quotation_value_total IS DISTINCT FROM
      rollback_row.quotation_value_total
    OR before_row.lead_owner_digest IS DISTINCT FROM
      rollback_row.lead_owner_digest
    OR before_row.history_relationship_digest IS DISTINCT FROM
      rollback_row.history_relationship_digest
    OR before_row.document_ownership_digest IS DISTINCT FROM
      rollback_row.document_ownership_digest
  THEN
    RAISE EXCEPTION 'sam21_rollback_business_contract_changed';
  END IF;

  IF to_regclass('public.organizations') IS NOT NULL
    OR to_regclass('public.memberships') IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'leads'
        AND column_name = 'organization_id'
    )
    OR EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'crm_daily_funnel_snapshot'
        AND column_name = 'organization_id'
    )
  THEN
    RAISE EXCEPTION 'sam21_rollback_schema_not_restored';
  END IF;
END
$$;

UPDATE public.leads
SET notes = 'rollback-read-write-contract'
WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001';
INSERT INTO public.leads(
  id,
  source,
  assigned_to,
  created_by,
  quotation_value,
  current_milestone,
  import_fingerprint,
  notes
)
VALUES (
  'aaaaaaaa-0000-4000-8000-000000000099',
  'offline',
  '11111111-1111-4111-8111-111111111111',
  '11111111-1111-4111-8111-111111111111',
  0,
  'new',
  'sam21-rollback-probe',
  'synthetic-rollback-probe'
);
DELETE FROM public.leads
WHERE id = 'aaaaaaaa-0000-4000-8000-000000000099';

SELECT jsonb_build_object(
  'status', 'rolled_back',
  'before', (
    SELECT to_jsonb(evidence) - 'phase'
    FROM public.sam21_rehearsal_evidence evidence
    WHERE phase = 'before'
  ),
  'rollback', (
    SELECT to_jsonb(evidence) - 'phase'
    FROM public.sam21_rehearsal_evidence evidence
    WHERE phase = 'rollback'
  ),
  'old_lead_read_write_contract', 'verified'
) AS sam21_rollback_evidence;

DROP VIEW public.sam21_rehearsal_metrics;
DROP TABLE public.sam21_rehearsal_evidence;

DO $$
BEGIN
  IF to_regclass('public.sam21_rehearsal_metrics') IS NOT NULL
    OR to_regclass('public.sam21_rehearsal_evidence') IS NOT NULL
  THEN
    RAISE EXCEPTION 'sam21_harness_cleanup_failed';
  END IF;
END
$$;
