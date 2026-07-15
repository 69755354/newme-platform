-- Make import_fingerprint a valid PostgREST ON CONFLICT target.
-- A partial unique index cannot be inferred by ON CONFLICT (import_fingerprint).
DROP INDEX IF EXISTS public.leads_import_fingerprint_unique;

CREATE UNIQUE INDEX leads_import_fingerprint_unique
  ON public.leads (import_fingerprint);