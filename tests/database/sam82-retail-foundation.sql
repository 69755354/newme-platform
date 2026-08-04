\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
GRANT USAGE ON SCHEMA auth TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, service_role;

CREATE TABLE public.organizations (
  id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'active'
);
CREATE TABLE public.products (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  CONSTRAINT products_organization_id_id_unique UNIQUE (organization_id, id)
);
CREATE TABLE public.capabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capability_key text NOT NULL,
  scope text NOT NULL,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT capabilities_scope_key_unique UNIQUE (scope, capability_key)
);
CREATE TABLE public.roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_key text NOT NULL,
  scope text NOT NULL
);
CREATE TABLE public.role_capabilities (
  role_id uuid NOT NULL REFERENCES public.roles(id),
  capability_id uuid NOT NULL REFERENCES public.capabilities(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, capability_id)
);
CREATE FUNCTION public.v4_actor_has_capability(uuid, uuid, text, text DEFAULT 'read')
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT true $$;
REVOKE ALL ON FUNCTION public.v4_actor_has_capability(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.v4_actor_has_capability(uuid, uuid, text, text)
  TO authenticated, service_role;

INSERT INTO public.roles (role_key, scope)
VALUES
  ('org_owner', 'organization'), ('org_admin', 'organization'),
  ('operations', 'organization'), ('finance', 'organization'),
  ('specialist', 'organization'), ('sales_agent', 'organization');

\i /work/supabase/migrations/20260805120000_sam82_retail_catalog_inventory_pricing.sql

INSERT INTO public.organizations (id, status) VALUES
  ('11111111-1111-1111-1111-111111111111', 'active'),
  ('22222222-2222-2222-2222-222222222222', 'active');
INSERT INTO public.products (id, organization_id) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111');

INSERT INTO public.retail_locations (id, organization_id, code, name, location_kind)
VALUES ('33333333-3333-3333-3333-333333333333',
  '11111111-1111-1111-1111-111111111111', 'DXB-01', 'Dubai store', 'store');
INSERT INTO public.retail_skus (id, organization_id, product_id, sku, name, barcode)
VALUES ('44444444-4444-4444-4444-444444444444',
  '11111111-1111-1111-1111-111111111111',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'SKU-001', 'Retail SKU', '1234567890123');
INSERT INTO public.retail_price_books (id, organization_id, name, currency, vat_rate)
VALUES ('55555555-5555-5555-5555-555555555555',
  '11111111-1111-1111-1111-111111111111', 'Retail UAE', 'AED', 5);
INSERT INTO public.retail_price_book_items (
  organization_id, price_book_id, sku_id, unit_price, max_discount_percent, effective_from
) VALUES (
  '11111111-1111-1111-1111-111111111111',
  '55555555-5555-5555-5555-555555555555',
  '44444444-4444-4444-4444-444444444444', 10, 15, now() - interval '1 minute'
);
INSERT INTO public.retail_inventory_movements (
  organization_id, location_id, sku_id, idempotency_key, movement_type, on_hand_delta, reserved_delta
) VALUES (
  '11111111-1111-1111-1111-111111111111',
  '33333333-3333-3333-3333-333333333333',
  '44444444-4444-4444-4444-444444444444',
  '66666666-6666-6666-6666-666666666666', 'receive', 12, 0
), (
  '11111111-1111-1111-1111-111111111111',
  '33333333-3333-3333-3333-333333333333',
  '44444444-4444-4444-4444-444444444444',
  '77777777-7777-7777-7777-777777777777', 'reserve', -2, 2
);

DO $$
DECLARE
  available_value numeric;
  price_value numeric;
BEGIN
  SELECT available INTO available_value FROM public.retail_inventory_balances
  WHERE organization_id = '11111111-1111-1111-1111-111111111111'
    AND location_id = '33333333-3333-3333-3333-333333333333'
    AND sku_id = '44444444-4444-4444-4444-444444444444';
  IF available_value <> 8 THEN RAISE EXCEPTION 'sam82_balance_wrong:%', available_value; END IF;
  SELECT unit_price INTO price_value FROM public.retail_effective_prices
  WHERE organization_id = '11111111-1111-1111-1111-111111111111';
  IF price_value <> 10 THEN RAISE EXCEPTION 'sam82_price_wrong:%', price_value; END IF;
END;
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO public.retail_inventory_movements (
      organization_id, location_id, sku_id, idempotency_key, movement_type, on_hand_delta
    ) VALUES (
      '11111111-1111-1111-1111-111111111111',
      '33333333-3333-3333-3333-333333333333',
      '44444444-4444-4444-4444-444444444444',
      '66666666-6666-6666-6666-666666666666', 'receive', 1
    );
    RAISE EXCEPTION 'sam82_duplicate_idempotency_allowed';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.retail_inventory_movements SET on_hand_delta = 99;
    RAISE EXCEPTION 'sam82_mutable_ledger_allowed';
  EXCEPTION WHEN sqlstate '55000' THEN NULL;
  END;
  BEGIN
    INSERT INTO public.retail_skus (organization_id, sku, name)
    VALUES ('22222222-2222-2222-2222-222222222222', 'CROSS-ORG', 'Cross org');
    INSERT INTO public.retail_inventory_movements (
      organization_id, location_id, sku_id, idempotency_key, movement_type, on_hand_delta
    ) VALUES (
      '22222222-2222-2222-2222-222222222222',
      '33333333-3333-3333-3333-333333333333',
      (SELECT id FROM public.retail_skus WHERE organization_id = '22222222-2222-2222-2222-222222222222'),
      '88888888-8888-8888-8888-888888888888', 'receive', 1
    );
    RAISE EXCEPTION 'sam82_cross_organization_location_allowed';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.retail_price_book_items (
      organization_id, price_book_id, sku_id, unit_price
    ) VALUES (
      '11111111-1111-1111-1111-111111111111',
      '55555555-5555-5555-5555-555555555555',
      '44444444-4444-4444-4444-444444444444', 0
    );
    RAISE EXCEPTION 'sam82_zero_price_allowed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$$;

DO $$
BEGIN
  IF has_table_privilege('anon', 'public.retail_skus', 'SELECT')
    OR has_table_privilege('anon', 'public.retail_inventory_movements', 'INSERT') THEN
    RAISE EXCEPTION 'sam82_anon_privilege_granted';
  END IF;
END;
$$;
