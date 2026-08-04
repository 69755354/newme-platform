\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, service_role;

CREATE TABLE public.organizations (id uuid PRIMARY KEY, status text NOT NULL DEFAULT 'active');
CREATE TABLE public.products (id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES public.organizations(id), CONSTRAINT products_organization_id_id_unique UNIQUE (organization_id, id));
CREATE TABLE public.quotations (id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES public.organizations(id), CONSTRAINT quotations_organization_id_id_unique UNIQUE (organization_id, id));
CREATE TABLE public.capabilities (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), capability_key text NOT NULL, scope text NOT NULL, description text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT capabilities_scope_key_unique UNIQUE (scope, capability_key));
CREATE TABLE public.roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), role_key text NOT NULL, scope text NOT NULL);
CREATE TABLE public.role_capabilities (role_id uuid NOT NULL REFERENCES public.roles(id), capability_id uuid NOT NULL REFERENCES public.capabilities(id), granted_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (role_id, capability_id));
CREATE FUNCTION public.v4_actor_has_capability(uuid, uuid, text, text DEFAULT 'read') RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$ SELECT true $$;
REVOKE ALL ON FUNCTION public.v4_actor_has_capability(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.v4_actor_has_capability(uuid, uuid, text, text) TO authenticated, service_role;
INSERT INTO public.roles (role_key, scope) VALUES ('org_owner','organization'), ('org_admin','organization'), ('operations','organization'), ('finance','organization'), ('specialist','organization'), ('sales_agent','organization');

\i /work/supabase/migrations/20260805120000_sam82_retail_catalog_inventory_pricing.sql
\i /work/supabase/migrations/20260805130000_sam83_retail_order_procurement_fulfillment_finance.sql

INSERT INTO auth.users (id) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001'), ('aaaaaaaa-0000-0000-0000-000000000002'),
  ('aaaaaaaa-0000-0000-0000-000000000003'), ('aaaaaaaa-0000-0000-0000-000000000004');
INSERT INTO public.organizations (id, status) VALUES
  ('11111111-1111-1111-1111-111111111111', 'active'), ('22222222-2222-2222-2222-222222222222', 'active');
INSERT INTO public.products (id, organization_id) VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111');
INSERT INTO public.quotations (id, organization_id) VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111');
INSERT INTO public.retail_locations (id, organization_id, code, name, location_kind) VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'WH-01', 'Warehouse', 'warehouse');
INSERT INTO public.retail_skus (id, organization_id, product_id, sku, name) VALUES ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'SKU-01', 'Stock item');
INSERT INTO public.retail_inventory_movements (organization_id, location_id, sku_id, idempotency_key, movement_type, on_hand_delta) VALUES ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'opening_balance', 10);

INSERT INTO public.retail_orders (id, organization_id, source_quotation_id, fulfillment_location_id, order_number, total_amount, created_by)
VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '11111111-1111-1111-1111-111111111111', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '33333333-3333-3333-3333-333333333333', 'SO-001', 20, 'aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO public.retail_order_items (id, organization_id, order_id, sku_id, quantity, unit_price)
VALUES ('f1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '44444444-4444-4444-4444-444444444444', 2, 10);
UPDATE public.retail_orders SET status = 'reserved' WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
UPDATE public.retail_orders SET status = 'picking' WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
UPDATE public.retail_orders SET status = 'packed' WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
UPDATE public.retail_orders SET status = 'fulfilled' WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

INSERT INTO public.retail_purchase_orders (id, organization_id, receiving_location_id, purchase_order_number, supplier_name, created_by)
VALUES ('f2222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'PO-001', 'Supplier A', 'aaaaaaaa-0000-0000-0000-000000000002');
INSERT INTO public.retail_purchase_order_items (id, organization_id, purchase_order_id, sku_id, ordered_quantity, unit_cost)
VALUES ('f3333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'f2222222-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444', 4, 6);
INSERT INTO public.retail_goods_receipts (id, organization_id, purchase_order_id, location_id, idempotency_key, received_by)
VALUES ('f4444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', 'f2222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'f5555555-5555-5555-5555-555555555555', 'aaaaaaaa-0000-0000-0000-000000000002');
INSERT INTO public.retail_goods_receipt_items (organization_id, receipt_id, purchase_order_item_id, sku_id, received_quantity)
VALUES ('11111111-1111-1111-1111-111111111111', 'f4444444-4444-4444-4444-444444444444', 'f3333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444', 4);

INSERT INTO public.retail_delivery_handoffs (id, organization_id, order_id, location_id, assigned_driver_id, status, delivered_at)
VALUES ('f6666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '33333333-3333-3333-3333-333333333333', 'aaaaaaaa-0000-0000-0000-000000000002', 'completed', now());
DO $$ BEGIN
  BEGIN INSERT INTO public.retail_cod_events (organization_id,order_id,handoff_id,idempotency_key,event_type,amount,actor_id) VALUES ('11111111-1111-1111-1111-111111111111','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','f6666666-6666-6666-6666-666666666666','fb000000-0000-0000-0000-000000000000','finance_confirmed',10,'aaaaaaaa-0000-0000-0000-000000000003'); RAISE EXCEPTION 'sam83_implicit_finance_confirmation_allowed'; EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
INSERT INTO public.retail_cod_events (organization_id, order_id, handoff_id, idempotency_key, event_type, amount, actor_id)
VALUES ('11111111-1111-1111-1111-111111111111', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'f6666666-6666-6666-6666-666666666666', 'f7777777-7777-7777-7777-777777777777', 'cash_collected', 20, 'aaaaaaaa-0000-0000-0000-000000000002'),
       ('11111111-1111-1111-1111-111111111111', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'f6666666-6666-6666-6666-666666666666', 'f8888888-8888-8888-8888-888888888888', 'cash_handover', 20, 'aaaaaaaa-0000-0000-0000-000000000003'),
       ('11111111-1111-1111-1111-111111111111', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'f6666666-6666-6666-6666-666666666666', 'f9999999-9999-9999-9999-999999999999', 'finance_confirmed', 20, 'aaaaaaaa-0000-0000-0000-000000000004');
INSERT INTO public.retail_finance_allocations (organization_id, order_id, finance_confirmation_id, idempotency_key, allocated_amount, allocated_by)
SELECT '11111111-1111-1111-1111-111111111111', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', id, 'fa000000-0000-0000-0000-000000000000', 20, 'aaaaaaaa-0000-0000-0000-000000000004'
FROM public.retail_cod_events WHERE event_type = 'finance_confirmed';
INSERT INTO public.retail_finance_reconciliations (organization_id, reconciliation_date, collected_amount, allocated_amount, status, completed_by, completed_at)
VALUES ('11111111-1111-1111-1111-111111111111', current_date, 20, 20, 'reconciled', 'aaaaaaaa-0000-0000-0000-000000000004', now());

DO $$ DECLARE available_value numeric; receivable_value numeric; BEGIN
  SELECT available INTO available_value FROM public.retail_inventory_balances WHERE organization_id = '11111111-1111-1111-1111-111111111111' AND sku_id = '44444444-4444-4444-4444-444444444444';
  IF available_value <> 12 THEN RAISE EXCEPTION 'sam83_stock_reconciliation_wrong:%', available_value; END IF;
  SELECT receivable_amount INTO receivable_value FROM public.retail_order_finance_summary WHERE order_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  IF receivable_value <> 0 THEN RAISE EXCEPTION 'sam83_finance_reconciliation_wrong:%', receivable_value; END IF;
END $$;

DO $$ BEGIN
  BEGIN INSERT INTO public.retail_orders (organization_id, source_quotation_id, fulfillment_location_id, order_number, total_amount) VALUES ('11111111-1111-1111-1111-111111111111','cccccccc-cccc-cccc-cccc-cccccccccccc','33333333-3333-3333-3333-333333333333','SO-DUP',20); RAISE EXCEPTION 'sam83_duplicate_quotation_conversion_allowed'; EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN UPDATE public.retail_orders SET status = 'picking' WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'; RAISE EXCEPTION 'sam83_terminal_order_update_allowed'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO public.retail_purchase_orders (organization_id,receiving_location_id,purchase_order_number,supplier_name) VALUES ('22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','PO-CROSS','Supplier B'); RAISE EXCEPTION 'sam83_cross_organization_location_allowed'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $$;

DO $$ BEGIN
  IF has_table_privilege('anon', 'public.retail_orders', 'SELECT') OR has_table_privilege('anon', 'public.retail_finance_allocations', 'INSERT') THEN RAISE EXCEPTION 'sam83_anon_privilege_granted'; END IF;
END $$;
