-- Restore the final lead-detail field consumed by the application contract.

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS circuit_diagrams BOOLEAN;

NOTIFY pgrst, 'reload schema';
