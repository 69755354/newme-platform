-- SAM-83 rollback is staging/test-only and intentionally has no CASCADE.
-- Any later dependency must stop the rollback before financial facts are removed.

BEGIN;

DO $$
DECLARE environment_name text := current_setting('newme.environment', true);
BEGIN
  IF COALESCE(environment_name, '') NOT IN ('staging', 'test') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'sam83_rollback_requires_staging_or_test';
  END IF;
END;
$$;

DROP VIEW IF EXISTS public.retail_order_finance_summary;
DROP TABLE IF EXISTS public.retail_finance_reconciliations;
DROP TABLE IF EXISTS public.retail_finance_allocations;
DROP TABLE IF EXISTS public.retail_cod_events;
DROP TABLE IF EXISTS public.retail_delivery_handoffs;
DROP TABLE IF EXISTS public.retail_goods_receipt_items;
DROP TABLE IF EXISTS public.retail_goods_receipts;
DROP TABLE IF EXISTS public.retail_purchase_order_items;
DROP TABLE IF EXISTS public.retail_purchase_orders;
DROP TABLE IF EXISTS public.retail_order_items;
DROP TABLE IF EXISTS public.retail_orders;

DROP FUNCTION IF EXISTS public.retail_sam83_validate_reconciliation();
DROP FUNCTION IF EXISTS public.retail_sam83_validate_finance_allocation();
DROP FUNCTION IF EXISTS public.retail_sam83_validate_cod_event();
DROP FUNCTION IF EXISTS public.retail_sam83_post_receipt_item();
DROP FUNCTION IF EXISTS public.retail_sam83_transition_order();
DROP FUNCTION IF EXISTS public.retail_sam83_reject_mutation();

DELETE FROM public.role_capabilities role_capability
USING public.capabilities capability
WHERE capability.id = role_capability.capability_id
  AND capability.scope = 'organization'
  AND capability.capability_key IN (
    'retail.orders.read', 'retail.orders.write',
    'retail.procurement.read', 'retail.procurement.write',
    'retail.delivery.read', 'retail.delivery.write',
    'retail.finance.read', 'retail.finance.write'
  );
DELETE FROM public.capabilities
WHERE scope = 'organization'
  AND capability_key IN (
    'retail.orders.read', 'retail.orders.write',
    'retail.procurement.read', 'retail.procurement.write',
    'retail.delivery.read', 'retail.delivery.write',
    'retail.finance.read', 'retail.finance.write'
  );

NOTIFY pgrst, 'reload schema';
COMMIT;
