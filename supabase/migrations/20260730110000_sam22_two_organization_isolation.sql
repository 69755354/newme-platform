-- SAM-22: extend the SAM-20 Lead vertical slice to two-organization async,
-- reporting, import-idempotency, and snapshot boundaries.
--
-- The synthetic second organization is deliberately created by the UAT
-- runner, never by this migration. Production data and PII are not copied.

BEGIN;

-- The same workbook row may legitimately be imported by two organizations,
-- while a repeated import inside one organization remains idempotent.
DROP INDEX IF EXISTS public.leads_import_fingerprint_unique;
CREATE UNIQUE INDEX leads_organization_import_fingerprint_unique
  ON public.leads (organization_id, import_fingerprint);

ALTER TABLE public.crm_daily_funnel_snapshot
  ADD COLUMN IF NOT EXISTS organization_id uuid;

UPDATE public.crm_daily_funnel_snapshot
SET organization_id = '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1'::uuid
WHERE organization_id IS NULL;

ALTER TABLE public.crm_daily_funnel_snapshot
  ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE public.crm_daily_funnel_snapshot
  DROP CONSTRAINT IF EXISTS crm_daily_funnel_snapshot_organization_id_fkey;
ALTER TABLE public.crm_daily_funnel_snapshot
  ADD CONSTRAINT crm_daily_funnel_snapshot_organization_id_fkey
  FOREIGN KEY (organization_id)
  REFERENCES public.organizations(id)
  ON DELETE RESTRICT;

DROP INDEX IF EXISTS public.crm_daily_funnel_snapshot_date_milestone_unique;
CREATE UNIQUE INDEX crm_daily_funnel_snapshot_org_date_milestone_unique
  ON public.crm_daily_funnel_snapshot (
    organization_id,
    snapshot_date,
    current_milestone
  );

ALTER TABLE public.crm_daily_funnel_snapshot ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sam22_crm_daily_funnel_snapshot_organization_boundary
  ON public.crm_daily_funnel_snapshot;
CREATE POLICY sam22_crm_daily_funnel_snapshot_organization_boundary
  ON public.crm_daily_funnel_snapshot
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (
    organization_id = public.requested_organization_id()
    AND EXISTS (
      SELECT 1
      FROM public.memberships membership
      WHERE membership.organization_id =
        crm_daily_funnel_snapshot.organization_id
        AND membership.user_id = (SELECT auth.uid())
        AND membership.status = 'active'
    )
  )
  WITH CHECK (
    organization_id = public.requested_organization_id()
    AND EXISTS (
      SELECT 1
      FROM public.memberships membership
      WHERE membership.organization_id =
        crm_daily_funnel_snapshot.organization_id
        AND membership.user_id = (SELECT auth.uid())
        AND membership.status = 'active'
    )
  );

CREATE INDEX IF NOT EXISTS crm_daily_funnel_snapshot_org_date_idx
  ON public.crm_daily_funnel_snapshot (organization_id, snapshot_date DESC);

NOTIFY pgrst, 'reload schema';

COMMIT;
