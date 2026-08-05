-- Tanya source taxonomy: Meta Ads is split into Instagram and Facebook for new leads.
-- Historical Meta Ads rows are explicitly classified as Instagram by business decision.
BEGIN;

ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_source_check;
ALTER TABLE public.leads ADD CONSTRAINT leads_source_check CHECK (
  source IN (
    'meta_ads', 'whatsapp', 'website', 'offline', 'referral', 'other',
    'instagram', 'unknown_import', 'ins', 'fb', 'show_room', 'unknown'
  )
);

UPDATE public.leads
SET source = 'ins'
WHERE source = 'meta_ads';

NOTIFY pgrst, 'reload schema';
COMMIT;
