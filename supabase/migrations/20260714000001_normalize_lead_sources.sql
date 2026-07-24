-- Keep Lead source values canonical across UI, imports, webhooks, and analytics.

UPDATE public.leads
SET source = 'ins'
WHERE source IN ('meta_ads', 'instagram');

ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_source_check;
ALTER TABLE public.leads ADD CONSTRAINT leads_source_check CHECK (
  source IN (
    'ins', 'fb', 'show_room', 'whatsapp', 'website', 'offline',
    'referral', 'other', 'unknown_import', 'unknown'
  )
);

NOTIFY pgrst, 'reload schema';
