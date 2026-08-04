-- SAM-82 / V4-06: retail catalog, inventory and pricing foundation.
-- This is intentionally bounded to tenant-owned operational facts. Orders,
-- procurement, delivery, COD and external POS adapters belong to SAM-83.
-- A ledger row is immutable; balances and active prices are derived views.

BEGIN;

CREATE TABLE public.retail_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES public.organizations(id) ON DELETE RESTRICT,
  code text NOT NULL,
  name text NOT NULL,
  location_kind text NOT NULL
    CHECK (location_kind IN ('store', 'warehouse')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retail_locations_code_nonblank CHECK (btrim(code) <> ''),
  CONSTRAINT retail_locations_name_nonblank CHECK (btrim(name) <> ''),
  CONSTRAINT retail_locations_organization_id_id_unique UNIQUE (organization_id, id)
);

CREATE UNIQUE INDEX retail_locations_organization_code_lower_key
  ON public.retail_locations (organization_id, lower(code));

CREATE TABLE public.retail_skus (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES public.organizations(id) ON DELETE RESTRICT,
  product_id uuid NULL,
  sku text NOT NULL,
  name text NOT NULL,
  barcode text NULL,
  unit text NOT NULL DEFAULT 'each',
  variant_attributes jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(variant_attributes) = 'object'),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retail_skus_sku_nonblank CHECK (btrim(sku) <> ''),
  CONSTRAINT retail_skus_name_nonblank CHECK (btrim(name) <> ''),
  CONSTRAINT retail_skus_unit_nonblank CHECK (btrim(unit) <> ''),
  CONSTRAINT retail_skus_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT retail_skus_organization_product_fkey
    FOREIGN KEY (organization_id, product_id)
    REFERENCES public.products(organization_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX retail_skus_organization_sku_lower_key
  ON public.retail_skus (organization_id, lower(sku));
CREATE UNIQUE INDEX retail_skus_organization_barcode_lower_key
  ON public.retail_skus (organization_id, lower(barcode))
  WHERE barcode IS NOT NULL;

CREATE TABLE public.retail_inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  location_id uuid NOT NULL,
  sku_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  movement_type text NOT NULL CHECK (movement_type IN (
    'opening_balance', 'receive', 'transfer_out', 'transfer_in',
    'adjustment', 'stocktake', 'reserve', 'release', 'block', 'unblock',
    'damage', 'in_transit', 'transit_receive'
  )),
  reference_type text NOT NULL DEFAULT 'manual',
  reference_id text NOT NULL DEFAULT '',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  on_hand_delta numeric(18,3) NOT NULL DEFAULT 0,
  reserved_delta numeric(18,3) NOT NULL DEFAULT 0,
  blocked_delta numeric(18,3) NOT NULL DEFAULT 0,
  damaged_delta numeric(18,3) NOT NULL DEFAULT 0,
  in_transit_delta numeric(18,3) NOT NULL DEFAULT 0,
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retail_inventory_movements_reference_type_nonblank
    CHECK (btrim(reference_type) <> ''),
  CONSTRAINT retail_inventory_movements_some_delta_check CHECK (
    on_hand_delta <> 0 OR reserved_delta <> 0 OR blocked_delta <> 0
    OR damaged_delta <> 0 OR in_transit_delta <> 0
  ),
  CONSTRAINT retail_inventory_movements_no_nan_check CHECK (
    on_hand_delta <> 'NaN'::numeric
    AND reserved_delta <> 'NaN'::numeric
    AND blocked_delta <> 'NaN'::numeric
    AND damaged_delta <> 'NaN'::numeric
    AND in_transit_delta <> 'NaN'::numeric
  ),
  CONSTRAINT retail_inventory_movements_organization_location_fkey
    FOREIGN KEY (organization_id, location_id)
    REFERENCES public.retail_locations(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT retail_inventory_movements_organization_sku_fkey
    FOREIGN KEY (organization_id, sku_id)
    REFERENCES public.retail_skus(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT retail_inventory_movements_organization_id_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT retail_inventory_movements_organization_idempotency_key_unique
    UNIQUE (organization_id, idempotency_key)
);

CREATE INDEX retail_inventory_movements_balance_lookup_idx
  ON public.retail_inventory_movements
    (organization_id, location_id, sku_id, occurred_at, id);

CREATE TABLE public.retail_price_books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES public.organizations(id) ON DELETE RESTRICT,
  name text NOT NULL,
  currency text NOT NULL DEFAULT 'AED'
    CHECK (currency ~ '^[A-Z]{3}$'),
  vat_rate numeric(5,2) NOT NULL DEFAULT 5
    CHECK (vat_rate >= 0 AND vat_rate <= 100 AND vat_rate <> 'NaN'::numeric),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('draft', 'active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retail_price_books_name_nonblank CHECK (btrim(name) <> ''),
  CONSTRAINT retail_price_books_organization_id_id_unique UNIQUE (organization_id, id)
);

CREATE UNIQUE INDEX retail_price_books_organization_name_lower_key
  ON public.retail_price_books (organization_id, lower(name));

CREATE TABLE public.retail_price_book_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  price_book_id uuid NOT NULL,
  sku_id uuid NOT NULL,
  unit_price numeric(18,3) NOT NULL
    CHECK (unit_price > 0 AND unit_price <> 'NaN'::numeric),
  max_discount_percent numeric(5,2) NOT NULL DEFAULT 0
    CHECK (max_discount_percent >= 0 AND max_discount_percent <= 100
      AND max_discount_percent <> 'NaN'::numeric),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_until timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retail_price_book_items_effective_window_check
    CHECK (effective_until IS NULL OR effective_until > effective_from),
  CONSTRAINT retail_price_book_items_organization_price_book_fkey
    FOREIGN KEY (organization_id, price_book_id)
    REFERENCES public.retail_price_books(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT retail_price_book_items_organization_sku_fkey
    FOREIGN KEY (organization_id, sku_id)
    REFERENCES public.retail_skus(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT retail_price_book_items_revision_unique
    UNIQUE (organization_id, price_book_id, sku_id, effective_from)
);

CREATE INDEX retail_price_book_items_resolver_lookup_idx
  ON public.retail_price_book_items
    (organization_id, price_book_id, sku_id, effective_from DESC, id DESC);

CREATE OR REPLACE FUNCTION public.retail_reject_mutable_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000',
    MESSAGE = 'retail_inventory_movement_is_append_only';
END;
$$;

REVOKE ALL ON FUNCTION public.retail_reject_mutable_ledger()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER retail_inventory_movements_append_only
  BEFORE UPDATE OR DELETE ON public.retail_inventory_movements
  FOR EACH ROW EXECUTE FUNCTION public.retail_reject_mutable_ledger();

CREATE OR REPLACE FUNCTION public.retail_reject_organization_reassignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'retail_organization_id_immutable';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.retail_reject_organization_reassignment()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER retail_locations_organization_immutable
  BEFORE UPDATE ON public.retail_locations
  FOR EACH ROW EXECUTE FUNCTION public.retail_reject_organization_reassignment();
CREATE TRIGGER retail_skus_organization_immutable
  BEFORE UPDATE ON public.retail_skus
  FOR EACH ROW EXECUTE FUNCTION public.retail_reject_organization_reassignment();
CREATE TRIGGER retail_price_books_organization_immutable
  BEFORE UPDATE ON public.retail_price_books
  FOR EACH ROW EXECUTE FUNCTION public.retail_reject_organization_reassignment();
CREATE TRIGGER retail_price_book_items_organization_immutable
  BEFORE UPDATE ON public.retail_price_book_items
  FOR EACH ROW EXECUTE FUNCTION public.retail_reject_organization_reassignment();

CREATE VIEW public.retail_inventory_balances
WITH (security_invoker = true)
AS
SELECT
  organization_id,
  location_id,
  sku_id,
  sum(on_hand_delta) AS on_hand,
  sum(reserved_delta) AS reserved,
  sum(blocked_delta) AS blocked,
  sum(damaged_delta) AS damaged,
  sum(in_transit_delta) AS in_transit,
  sum(on_hand_delta - reserved_delta - blocked_delta - damaged_delta) AS available
FROM public.retail_inventory_movements
GROUP BY organization_id, location_id, sku_id;

CREATE VIEW public.retail_effective_prices
WITH (security_invoker = true)
AS
SELECT organization_id, price_book_id, sku_id, unit_price, max_discount_percent,
       currency, vat_rate, effective_from, effective_until
FROM (
  SELECT
    item.organization_id,
    item.price_book_id,
    item.sku_id,
    item.unit_price,
    item.max_discount_percent,
    price_book.currency,
    price_book.vat_rate,
    item.effective_from,
    item.effective_until,
    row_number() OVER (
      PARTITION BY item.organization_id, item.price_book_id, item.sku_id
      ORDER BY item.effective_from DESC, item.id DESC
    ) AS price_revision
  FROM public.retail_price_book_items item
  JOIN public.retail_price_books price_book
    ON price_book.organization_id = item.organization_id
   AND price_book.id = item.price_book_id
  JOIN public.retail_skus sku
    ON sku.organization_id = item.organization_id
   AND sku.id = item.sku_id
  WHERE price_book.status = 'active'
    AND sku.is_active IS TRUE
    AND item.effective_from <= now()
    AND (item.effective_until IS NULL OR item.effective_until > now())
) resolved
WHERE price_revision = 1;

INSERT INTO public.capabilities (capability_key, scope, description)
VALUES
  ('retail.locations.read', 'organization', 'Read retail stores and warehouses.'),
  ('retail.locations.write', 'organization', 'Manage retail stores and warehouses.'),
  ('retail.catalog.read', 'organization', 'Read retail SKUs and barcode resolution.'),
  ('retail.catalog.write', 'organization', 'Manage retail SKUs and variants.'),
  ('retail.inventory.read', 'organization', 'Read retail inventory ledgers and balances.'),
  ('retail.inventory.write', 'organization', 'Record immutable retail inventory movements.'),
  ('retail.pricing.read', 'organization', 'Read retail price books and effective prices.'),
  ('retail.pricing.write', 'organization', 'Manage retail price books and price revisions.')
ON CONFLICT (scope, capability_key) DO UPDATE
SET description = EXCLUDED.description;

INSERT INTO public.role_capabilities (role_id, capability_id)
SELECT role.id, capability.id
FROM public.roles role
JOIN public.capabilities capability
  ON capability.scope = 'organization'
WHERE role.scope = 'organization'
  AND capability.capability_key IN (
    'retail.locations.read', 'retail.catalog.read',
    'retail.inventory.read', 'retail.pricing.read'
  )
  AND role.role_key IN (
    'org_owner', 'org_admin', 'operations', 'finance', 'specialist', 'sales_agent'
  )
ON CONFLICT (role_id, capability_id) DO NOTHING;

INSERT INTO public.role_capabilities (role_id, capability_id)
SELECT role.id, capability.id
FROM public.roles role
JOIN public.capabilities capability
  ON capability.scope = 'organization'
WHERE role.scope = 'organization'
  AND capability.capability_key IN (
    'retail.locations.write', 'retail.catalog.write',
    'retail.inventory.write', 'retail.pricing.write'
  )
  AND role.role_key IN ('org_owner', 'org_admin', 'operations')
ON CONFLICT (role_id, capability_id) DO NOTHING;

INSERT INTO public.role_capabilities (role_id, capability_id)
SELECT role.id, capability.id
FROM public.roles role
JOIN public.capabilities capability
  ON capability.scope = 'organization'
WHERE role.scope = 'organization'
  AND capability.capability_key = 'retail.pricing.write'
  AND role.role_key = 'finance'
ON CONFLICT (role_id, capability_id) DO NOTHING;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'retail_locations', 'retail_skus', 'retail_inventory_movements',
    'retail_price_books', 'retail_price_book_items'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', table_name);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', table_name);
  END LOOP;
END;
$$;

GRANT SELECT ON TABLE public.retail_locations, public.retail_skus,
  public.retail_inventory_movements, public.retail_price_books,
  public.retail_price_book_items, public.retail_inventory_balances,
  public.retail_effective_prices TO authenticated;
GRANT INSERT ON TABLE public.retail_locations, public.retail_skus,
  public.retail_inventory_movements, public.retail_price_books,
  public.retail_price_book_items TO authenticated;
GRANT UPDATE ON TABLE public.retail_locations, public.retail_skus,
  public.retail_price_books, public.retail_price_book_items TO authenticated;

CREATE POLICY retail_locations_read ON public.retail_locations
  FOR SELECT TO authenticated
  USING (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.locations.read'));
CREATE POLICY retail_locations_write ON public.retail_locations
  FOR ALL TO authenticated
  USING (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.locations.write', 'write'))
  WITH CHECK (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.locations.write', 'write'));

CREATE POLICY retail_skus_read ON public.retail_skus
  FOR SELECT TO authenticated
  USING (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.catalog.read'));
CREATE POLICY retail_skus_write ON public.retail_skus
  FOR ALL TO authenticated
  USING (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.catalog.write', 'write'))
  WITH CHECK (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.catalog.write', 'write'));

CREATE POLICY retail_inventory_movements_read ON public.retail_inventory_movements
  FOR SELECT TO authenticated
  USING (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.inventory.read'));
CREATE POLICY retail_inventory_movements_insert ON public.retail_inventory_movements
  FOR INSERT TO authenticated
  WITH CHECK (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.inventory.write', 'write'));

CREATE POLICY retail_price_books_read ON public.retail_price_books
  FOR SELECT TO authenticated
  USING (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.pricing.read'));
CREATE POLICY retail_price_books_write ON public.retail_price_books
  FOR ALL TO authenticated
  USING (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.pricing.write', 'write'))
  WITH CHECK (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.pricing.write', 'write'));

CREATE POLICY retail_price_book_items_read ON public.retail_price_book_items
  FOR SELECT TO authenticated
  USING (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.pricing.read'));
CREATE POLICY retail_price_book_items_write ON public.retail_price_book_items
  FOR ALL TO authenticated
  USING (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.pricing.write', 'write'))
  WITH CHECK (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.pricing.write', 'write'));

NOTIFY pgrst, 'reload schema';

COMMIT;
