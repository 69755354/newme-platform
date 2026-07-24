-- Make CRM workbook imports idempotent without changing legacy rows.

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS import_fingerprint text;

CREATE UNIQUE INDEX IF NOT EXISTS leads_import_fingerprint_unique
  ON public.leads (import_fingerprint)
  WHERE import_fingerprint IS NOT NULL;

COMMENT ON COLUMN public.leads.import_fingerprint IS
  'SHA-256 fingerprint of a normalized source workbook row; prevents repeat-upload duplicates.';

NOTIFY pgrst, 'reload schema';
