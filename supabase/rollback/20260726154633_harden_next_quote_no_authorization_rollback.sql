-- Controlled cleanroom rollback for 20260726154633.
-- This restores the previous authenticated-only boundary while retaining the
-- fixed search_path and explicit grants.

CREATE OR REPLACE FUNCTION public.next_quote_no()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_year text := pg_catalog.to_char(pg_catalog.now(), 'YYYY');
  v_max integer;
  v_next integer;
BEGIN
  SELECT coalesce(
    max(
      CAST(split_part(quote_no, '-', 3) AS integer)
    ),
    0
  )
  INTO v_max
  FROM public.quotations
  WHERE quote_no LIKE 'NM-' || v_year || '-%';

  v_next := v_max + 1;
  RETURN 'NM-' || v_year || '-' || lpad(v_next::text, 4, '0');
END;
$$;

REVOKE EXECUTE ON FUNCTION public.next_quote_no() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.next_quote_no() TO authenticated;

COMMENT ON FUNCTION public.next_quote_no() IS
  'Returns the next quote number to authenticated callers.';
