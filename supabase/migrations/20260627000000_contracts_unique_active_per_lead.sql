-- Enforce one active contract per lead. Do not silently select or merge
-- duplicates: an existing duplicate is a data incident that needs explicit review.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.contracts
    WHERE status NOT IN ('archived', 'cancelled', 'terminated')
    GROUP BY lead_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot create active-contract uniqueness index: duplicate active contracts exist';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contracts_one_active_per_lead
ON public.contracts (lead_id)
WHERE status NOT IN ('archived', 'cancelled', 'terminated');
