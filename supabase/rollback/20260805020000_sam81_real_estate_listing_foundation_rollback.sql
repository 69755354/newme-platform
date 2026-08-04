BEGIN;

DO $$
BEGIN
  IF COALESCE(current_setting('newme.environment', true), '') NOT IN ('staging', 'test') THEN
    RAISE EXCEPTION 'sam81_rollback_requires_staging_or_test';
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.real_estate_viewings)
    OR EXISTS (SELECT 1 FROM public.real_estate_listing_assets)
    OR EXISTS (SELECT 1 FROM public.real_estate_listings)
    OR EXISTS (SELECT 1 FROM public.real_estate_properties)
    OR EXISTS (SELECT 1 FROM public.real_estate_parties)
  THEN
    RAISE EXCEPTION 'sam81_rollback_records_present';
  END IF;
END
$$;

DROP VIEW IF EXISTS public.v_real_estate_listing_publish_readiness;
DROP TABLE IF EXISTS public.real_estate_viewings;
DROP TABLE IF EXISTS public.real_estate_listing_assets;
DROP TABLE IF EXISTS public.real_estate_listings;
DROP TABLE IF EXISTS public.real_estate_properties;
DROP TABLE IF EXISTS public.real_estate_parties;

COMMIT;
