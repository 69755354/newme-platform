-- SAM-82 rollback is deliberately limited to a staging/test database. The
-- table drops do not use CASCADE: a later domain dependency must stop here.

BEGIN;

DO $$
DECLARE
  environment_name text := current_setting('newme.environment', true);
BEGIN
  IF COALESCE(environment_name, '') NOT IN ('staging', 'test') THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'sam82_rollback_requires_staging_or_test';
  END IF;
END;
$$;

DROP VIEW IF EXISTS public.retail_effective_prices;
DROP VIEW IF EXISTS public.retail_inventory_balances;

DROP TABLE IF EXISTS public.retail_price_book_items;
DROP TABLE IF EXISTS public.retail_price_books;
DROP TABLE IF EXISTS public.retail_inventory_movements;
DROP TABLE IF EXISTS public.retail_skus;
DROP TABLE IF EXISTS public.retail_locations;

DROP FUNCTION IF EXISTS public.retail_reject_mutable_ledger();
DROP FUNCTION IF EXISTS public.retail_reject_organization_reassignment();

DELETE FROM public.role_capabilities role_capability
USING public.capabilities capability
WHERE capability.id = role_capability.capability_id
  AND capability.scope = 'organization'
  AND capability.capability_key IN (
    'retail.locations.read', 'retail.locations.write',
    'retail.catalog.read', 'retail.catalog.write',
    'retail.inventory.read', 'retail.inventory.write',
    'retail.pricing.read', 'retail.pricing.write'
  );

DELETE FROM public.capabilities
WHERE scope = 'organization'
  AND capability_key IN (
    'retail.locations.read', 'retail.locations.write',
    'retail.catalog.read', 'retail.catalog.write',
    'retail.inventory.read', 'retail.inventory.write',
    'retail.pricing.read', 'retail.pricing.write'
  );

NOTIFY pgrst, 'reload schema';

COMMIT;
