-- ============================================================
-- next_quote_no() — atomic, RLS-proof quote number generator
-- 2026-06-24
-- ============================================================

CREATE OR REPLACE FUNCTION public.next_quote_no()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_year TEXT := to_char(now(), 'YYYY');
  v_max INT;
  v_next INT;
BEGIN
  -- Serialize allocation for this year so concurrent callers cannot receive
  -- the same number while RLS remains bypassed only inside this function.
  PERFORM pg_advisory_xact_lock(hashtext('newme:quote-no:' || v_year));

  SELECT COALESCE(
    MAX(CAST(split_part(quote_no, '-', 3) AS INT)),
    0
  ) INTO v_max
  FROM public.quotations
  WHERE quote_no LIKE 'NM-' || v_year || '-%';

  v_next := v_max + 1;
  RETURN 'NM-' || v_year || '-' || LPAD(v_next::text, 4, '0');
END;
$$;

REVOKE ALL ON FUNCTION public.next_quote_no() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.next_quote_no() TO authenticated;
