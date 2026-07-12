-- Tanya source taxonomy: Meta Ads is split into Instagram and Facebook for new leads.
-- Historical Meta Ads rows are explicitly classified as Instagram by business decision.
BEGIN;

UPDATE public.leads
SET source = 'ins'
WHERE source = 'meta_ads';

NOTIFY pgrst, 'reload schema';
COMMIT;
