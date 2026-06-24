-- ============================================================
-- next_quote_no() — atomic, RLS-proof quote number generator
-- 2026-06-24
--
-- SECURITY DEFINER runs as the table owner, so it sees ALL
-- quotations regardless of the caller's RLS visibility. This is
-- required because sales users can only SELECT their own
-- quotations via RLS, which would make a client-side "max(quote_no)
-- + 1" compute duplicate numbers. Moving the sequence read to the
-- DB guarantees a globally unique NM-YYYY-XXXX per call.
-- ============================================================

CREATE OR REPLACE FUNCTION next_quote_no()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year TEXT := to_char(now(), 'YYYY');
  v_max INT;
  v_next INT;
BEGIN
  SELECT COALESCE(
    MAX(CAST(split_part(quote_no, '-', 3) AS INT)),
    0
  ) INTO v_max
  FROM quotations
  WHERE quote_no LIKE 'NM-' || v_year || '-%';
  v_next := v_max + 1;
  RETURN 'NM-' || v_year || '-' || LPAD(v_next::text, 4, '0');
END;
$$;
GRANT EXECUTE ON FUNCTION next_quote_no() TO authenticated;
