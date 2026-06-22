-- P1: Race-safe quote number generation
-- Replaces app-level SELECT MAX+1 pattern with advisory-locked atomic increment.
-- Uses pg_advisory_xact_lock to serialize per-year quote_no allocation.
CREATE OR REPLACE FUNCTION generate_quote_no(year_param integer)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  next_seq integer;
  year_str text;
BEGIN
  -- Serialize all quote_no generation with a transaction-level advisory lock
  PERFORM pg_advisory_xact_lock(42);

  year_str := year_param::text;

  SELECT COALESCE(
    (SELECT MAX(NULLIF(regexp_replace(quote_no, '^NM-\d{4}-', ''), ''))
     FROM quotations
     WHERE quote_no LIKE 'NM-' || year_str || '-%')::integer,
    0
  ) + 1 INTO next_seq;

  RETURN 'NM-' || year_str || '-' || lpad(next_seq::text, 4, '0');
END;
$$;
