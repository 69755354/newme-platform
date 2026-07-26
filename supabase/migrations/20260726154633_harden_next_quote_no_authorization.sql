-- SAM-61: keep the quote-number RPC callable by the quotation workflow while
-- enforcing the same active-role boundary as the /quotes page.

CREATE OR REPLACE FUNCTION public.next_quote_no()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_year text := pg_catalog.to_char(pg_catalog.now(), 'YYYY');
  v_max integer;
  v_next integer;
BEGIN
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  SELECT role
  INTO v_actor_role
  FROM public.profiles
  WHERE id = v_actor_id
    AND is_active = true;

  IF NOT FOUND OR coalesce(v_actor_role, '') NOT IN ('admin', 'boss', 'sales') THEN
    RAISE EXCEPTION 'FORBIDDEN_QUOTE_NUMBER';
  END IF;

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
  'Returns the next quote number to active admin, boss, or sales callers.';
