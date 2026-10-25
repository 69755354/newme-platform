-- NO_ROLLBACK: additive nullable column and a new service-only outbox table; no existing row or policy changes.
-- Meta Conversion Leads (CRM) support: remember Meta's leadgen_id per lead and
-- queue one outbound CRM stage event per (lead, stage).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS meta_leadgen_id text;

-- Meta lead ids are numeric strings. A given Meta lead maps to one CRM lead.
CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_meta_leadgen_id
  ON public.leads (meta_leadgen_id) WHERE meta_leadgen_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.meta_crm_stage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  meta_leadgen_id text NOT NULL,
  crm_stage text NOT NULL,
  event_name text NOT NULL,
  event_time bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'delivered', 'failed', 'review_required')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_id uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE (lead_id, crm_stage)
);

-- Server-side only: service_role bypasses RLS; no policy is granted to clients.
ALTER TABLE public.meta_crm_stage_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.meta_crm_stage_events FROM anon, authenticated;
