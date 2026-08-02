\set ON_ERROR_STOP on

DO $$
DECLARE
  product_id uuid;
  stored_tenant uuid;
  stored_organization uuid;
BEGIN
  IF to_regclass('public.capabilities') IS NULL
    OR to_regclass('public.role_capabilities') IS NULL
  THEN
    RAISE EXCEPTION 'V4 expand capability tables missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'products'
      AND column_name = 'organization_id'
      AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'V4 expand organization_id is not compatible nullable';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.products'::regclass
      AND conname = 'products_sku_key'
  ) OR (
    SELECT count(*)
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'products'
      AND policyname LIKE 'v4_products_capability_%'
  ) <> 4 OR to_regprocedure(
    'public.product_organization_context()'
  ) IS NULL OR to_regprocedure(
    'public.create_product_for_organization(uuid,jsonb)'
  ) IS NULL OR to_regprocedure(
    'public.import_products_for_organization(uuid,jsonb)'
  ) IS NULL THEN
    RAISE EXCEPTION 'V4 expand transitional product contract missing';
  END IF;

  IF has_table_privilege('authenticated', 'public.products', 'INSERT')
    OR NOT has_function_privilege(
      'authenticated',
      'public.create_product_for_organization(uuid,jsonb)',
      'EXECUTE'
    )
    OR NOT has_function_privilege(
      'authenticated',
      'public.import_products_for_organization(uuid,jsonb)',
      'EXECUTE'
    )
  THEN
    RAISE EXCEPTION 'V4 bounded product write privilege contract missing';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'products'
      AND policyname IN (
        'policy_products_select_admin',
        'policy_products_select_finance',
        'policy_products_select_designer',
        'policy_products_select_sales',
        'policy_products_insert_admin',
        'policy_products_update_admin',
        'policy_products_delete_admin'
      )
  ) THEN
    RAISE EXCEPTION 'V4 expand legacy global product RLS remained active';
  END IF;

  INSERT INTO public.products(tenant_id, name, sku, unit_price)
  VALUES (
    '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1',
    'V4 tenant-only compatible product',
    'V4-TENANT-ONLY-COMPAT',
    1
  )
  RETURNING id, tenant_id, organization_id
  INTO product_id, stored_tenant, stored_organization;

  IF stored_tenant IS DISTINCT FROM
      '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1'::uuid
    OR stored_organization IS DISTINCT FROM stored_tenant
  THEN
    RAISE EXCEPTION 'V4 tenant-only write compatibility failed';
  END IF;

  DELETE FROM public.products WHERE id = product_id;

  BEGIN
    INSERT INTO public.products(name, sku, unit_price)
    VALUES ('V4 context-free product', 'V4-CONTEXT-FREE', 1);
    RAISE EXCEPTION 'V4 context-free service-role write was accepted';
  EXCEPTION
    WHEN check_violation THEN
      IF SQLERRM <> 'product_organization_context_required' THEN
        RAISE;
      END IF;
  END;

  IF EXISTS (
    SELECT 1 FROM public.products WHERE sku = 'V4-CONTEXT-FREE'
  ) THEN
    RAISE EXCEPTION 'V4 context-free write left a product row';
  END IF;
END
$$;

SELECT 'V4 tenant capability expand compatibility passed' AS result;
