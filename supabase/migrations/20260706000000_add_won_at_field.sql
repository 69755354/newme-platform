-- DRAFT: pending Hermes audit and GPT approval. Do not apply yet.


ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS won_at timestamptz NULL;

UPDATE public.leads
SET won_at = COALESCE(updated_at, created_at, NOW())
WHERE final_status = 'won'
  AND won_at IS NULL;

CREATE OR REPLACE FUNCTION public.trg_set_won_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.final_status = 'won'
     AND OLD.final_status IS DISTINCT FROM 'won'
     AND NEW.won_at IS NULL THEN
    NEW.won_at := now();
  END IF;

  IF NEW.final_status IS DISTINCT FROM 'won'
     AND OLD.final_status = 'won' THEN
    NEW.won_at := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_leads_set_won_at ON public.leads;

CREATE TRIGGER trg_leads_set_won_at
  BEFORE UPDATE ON public.leads
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_set_won_at();

CREATE INDEX IF NOT EXISTS idx_leads_won_at
  ON public.leads(won_at)
  WHERE won_at IS NOT NULL;
