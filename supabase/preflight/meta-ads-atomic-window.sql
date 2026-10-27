-- NO_ROLLBACK: additive server-only atomic writer; old clients remain compatible.
-- Manual HTTP sync and the disabled scheduler must use this same transaction.
CREATE OR REPLACE FUNCTION public.replace_meta_ad_spend_window(
  p_account_id text, p_since date, p_until date, p_rows jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = ''
SET lock_timeout = '5s'
SET statement_timeout = '20s'
AS $function$
DECLARE
  v_source text;
  v_deleted integer;
  v_inserted integer;
  v_present integer;
  v_amount numeric;
BEGIN
  IF p_account_id IS NULL OR p_account_id !~ '^[0-9]{1,32}$'
    OR p_since IS NULL OR p_until IS NULL OR p_since > p_until OR p_until - p_since >= 92
    OR p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array'
    OR jsonb_array_length(p_rows) > 20000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_ads_window';
  END IF;
  v_source := 'meta_api:' || p_account_id;
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(
      campaign_name text, adset_name text, ad_name text, spend_date date,
      amount numeric, currency text, impressions integer, clicks integer, source text
    ) WHERE x.source IS DISTINCT FROM v_source OR x.currency IS DISTINCT FROM 'AED'
      OR x.spend_date IS NULL OR x.spend_date NOT BETWEEN p_since AND p_until
      OR x.amount IS NULL OR x.amount < 0 OR x.amount >= 10000000000
      OR x.amount::text IN ('NaN', 'Infinity', '-Infinity') OR x.amount <> round(x.amount, 2)
      OR x.impressions < 0 OR x.clicks < 0
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_ads_rows';
  END IF;

  -- Global across accounts/windows, including overlapping sub-windows.
  -- Transaction ownership releases the lock on commit, rollback or disconnect.
  PERFORM pg_catalog.pg_advisory_xact_lock(1313685843, 1);
  IF EXISTS (SELECT 1 FROM public.ad_spend
    WHERE spend_date BETWEEN p_since AND p_until AND source IS DISTINCT FROM v_source) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'overlapping_spend_window';
  END IF;
  IF jsonb_array_length(p_rows) = 0 AND EXISTS (SELECT 1 FROM public.ad_spend
    WHERE source = v_source AND spend_date BETWEEN p_since AND p_until) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'empty_window_requires_review';
  END IF;

  DELETE FROM public.ad_spend
    WHERE source = v_source AND spend_date BETWEEN p_since AND p_until;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  INSERT INTO public.ad_spend
    (campaign_name, adset_name, ad_name, spend_date, amount, currency, impressions, clicks, source)
    SELECT x.campaign_name, x.adset_name, x.ad_name, x.spend_date, x.amount,
      x.currency, x.impressions, x.clicks, x.source
    FROM jsonb_to_recordset(p_rows) AS x(
      campaign_name text, adset_name text, ad_name text, spend_date date,
      amount numeric(12,2), currency text, impressions integer, clicks integer, source text
    );
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  SELECT count(*), coalesce(sum(amount), 0) INTO v_present, v_amount FROM public.ad_spend
    WHERE source = v_source AND spend_date BETWEEN p_since AND p_until;
  IF v_inserted <> jsonb_array_length(p_rows) OR v_present <> v_inserted OR EXISTS (
    WITH expected AS (
      SELECT * FROM jsonb_to_recordset(p_rows) AS x(
        campaign_name text, adset_name text, ad_name text, spend_date date,
        amount numeric(12,2), currency text, impressions integer, clicks integer, source text)
    ), actual AS (
      SELECT campaign_name, adset_name, ad_name, spend_date, amount, currency, impressions, clicks, source
      FROM public.ad_spend WHERE source = v_source AND spend_date BETWEEN p_since AND p_until
    ) SELECT 1 FROM (
      (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
      UNION ALL (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected)
    ) AS mismatch
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'window_row_readback_mismatch';
  END IF;
  RETURN jsonb_build_object('ok', true, 'deleted', v_deleted, 'inserted', v_inserted,
    'present', v_present, 'total_spend_aed', v_amount, 'atomic', true);
END;
$function$;
REVOKE ALL ON FUNCTION public.replace_meta_ad_spend_window(text,date,date,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_meta_ad_spend_window(text,date,date,jsonb) TO service_role;

-- All existing writers, including an import whose prior overlap probe is stale,
-- take the same lock. RowExclusive table locks remain mutually compatible.
CREATE OR REPLACE FUNCTION public.coordinate_ad_spend_writes() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = ''
SET lock_timeout = '5s'
AS $guard$
BEGIN
  IF TG_WHEN = 'BEFORE' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(1313685843, 1);
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM (SELECT DISTINCT spend_date, source FROM new_ad_spend_rows) n
    JOIN public.ad_spend t ON t.spend_date = n.spend_date
    WHERE t.source IS DISTINCT FROM n.source) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'overlapping_spend_window';
  END IF;
  RETURN NULL;
END;
$guard$;
REVOKE ALL ON FUNCTION public.coordinate_ad_spend_writes() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS ad_spend_coordinate_writers ON public.ad_spend;
CREATE TRIGGER ad_spend_coordinate_writers
  BEFORE INSERT OR UPDATE OR DELETE ON public.ad_spend
  FOR EACH STATEMENT EXECUTE FUNCTION public.coordinate_ad_spend_writes();
DROP TRIGGER IF EXISTS ad_spend_insert_source_guard ON public.ad_spend;
CREATE TRIGGER ad_spend_insert_source_guard
  AFTER INSERT ON public.ad_spend REFERENCING NEW TABLE AS new_ad_spend_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.coordinate_ad_spend_writes();
DROP TRIGGER IF EXISTS ad_spend_update_source_guard ON public.ad_spend;
CREATE TRIGGER ad_spend_update_source_guard
  AFTER UPDATE ON public.ad_spend REFERENCING NEW TABLE AS new_ad_spend_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.coordinate_ad_spend_writes();

-- Remove inherited default ACL entries on these newly provisioned functions.
DO $acl$
DECLARE f regprocedure; g record;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.replace_meta_ad_spend_window(text,date,date,jsonb)'::regprocedure,
    'public.coordinate_ad_spend_writes()'::regprocedure
  ] LOOP
    FOR g IN SELECT DISTINCT x.grantee, r.rolname
      FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
      LEFT JOIN pg_roles r ON r.oid=x.grantee
      WHERE p.oid=f AND x.grantee<>p.proowner
    LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s',f,
        CASE WHEN g.grantee=0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END);
    END LOOP;
  END LOOP;
END;
$acl$;
GRANT EXECUTE ON FUNCTION public.replace_meta_ad_spend_window(text,date,date,jsonb) TO service_role;
