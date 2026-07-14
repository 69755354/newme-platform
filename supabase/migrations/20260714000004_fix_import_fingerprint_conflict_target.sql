BEGIN;
DROP INDEX IF EXISTS public.leads_import_fingerprint_unique;
CREATE UNIQUE INDEX leads_import_fingerprint_unique ON public.leads (import_fingerprint);
NOTIFY pgrst, 'reload schema';
COMMIT;
