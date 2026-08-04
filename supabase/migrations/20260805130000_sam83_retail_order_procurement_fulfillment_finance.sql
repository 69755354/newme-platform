-- SAM-83 / V4-07: bounded retail order-to-finance facts.
-- External carrier, payment-gateway and POS adapters remain out of scope.
-- All records are organization-scoped; cash collection, handover and finance
-- confirmation are distinct immutable facts.

BEGIN;

CREATE TABLE public.retail_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  source_quotation_id uuid NOT NULL,
  fulfillment_location_id uuid NOT NULL,
  order_number text NOT NULL,
  status text NOT NULL DEFAULT 'accepted'
    CHECK (status IN ('accepted', 'reserved', 'picking', 'packed', 'fulfilled', 'cancelled', 'returned')),
  currency text NOT NULL DEFAULT 'AED' CHECK (currency ~ '^[A-Z]{3}$'),
  total_amount numeric(18,3) NOT NULL CHECK (total_amount > 0 AND total_amount <> 'NaN'::numeric),
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retail_orders_order_number_nonblank CHECK (btrim(order_number) <> ''),
  CONSTRAINT retail_orders_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT retail_orders_organization_quotation_fkey
    FOREIGN KEY (organization_id, source_quotation_id)
    REFERENCES public.quotations(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT retail_orders_organization_location_fkey
    FOREIGN KEY (organization_id, fulfillment_location_id)
    REFERENCES public.retail_locations(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT retail_orders_organization_quotation_unique UNIQUE (organization_id, source_quotation_id),
  CONSTRAINT retail_orders_organization_number_unique UNIQUE (organization_id, order_number)
);

CREATE TABLE public.retail_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  order_id uuid NOT NULL,
  sku_id uuid NOT NULL,
  quantity numeric(18,3) NOT NULL CHECK (quantity > 0 AND quantity <> 'NaN'::numeric),
  unit_price numeric(18,3) NOT NULL CHECK (unit_price > 0 AND unit_price <> 'NaN'::numeric),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retail_order_items_organization_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES public.retail_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT retail_order_items_organization_sku_fkey
    FOREIGN KEY (organization_id, sku_id)
    REFERENCES public.retail_skus(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT retail_order_items_organization_order_sku_unique UNIQUE (organization_id, order_id, sku_id)
);

CREATE TABLE public.retail_purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  receiving_location_id uuid NOT NULL,
  purchase_order_number text NOT NULL,
  supplier_name text NOT NULL,
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('draft', 'issued', 'closed', 'cancelled')),
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retail_purchase_orders_number_nonblank CHECK (btrim(purchase_order_number) <> ''),
  CONSTRAINT retail_purchase_orders_supplier_nonblank CHECK (btrim(supplier_name) <> ''),
  CONSTRAINT retail_purchase_orders_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT retail_purchase_orders_organization_location_fkey
    FOREIGN KEY (organization_id, receiving_location_id)
    REFERENCES public.retail_locations(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT retail_purchase_orders_organization_number_unique UNIQUE (organization_id, purchase_order_number)
);

CREATE TABLE public.retail_purchase_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  purchase_order_id uuid NOT NULL,
  sku_id uuid NOT NULL,
  ordered_quantity numeric(18,3) NOT NULL CHECK (ordered_quantity > 0 AND ordered_quantity <> 'NaN'::numeric),
  unit_cost numeric(18,3) NOT NULL CHECK (unit_cost >= 0 AND unit_cost <> 'NaN'::numeric),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retail_purchase_order_items_organization_purchase_order_fkey
    FOREIGN KEY (organization_id, purchase_order_id)
    REFERENCES public.retail_purchase_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT retail_purchase_order_items_organization_sku_fkey
    FOREIGN KEY (organization_id, sku_id)
    REFERENCES public.retail_skus(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT retail_purchase_order_items_organization_po_sku_unique
    UNIQUE (organization_id, purchase_order_id, sku_id),
  CONSTRAINT retail_purchase_order_items_organization_id_id_unique UNIQUE (organization_id, id)
);

CREATE TABLE public.retail_goods_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  purchase_order_id uuid NOT NULL,
  location_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'cancelled')),
  received_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retail_goods_receipts_organization_purchase_order_fkey
    FOREIGN KEY (organization_id, purchase_order_id)
    REFERENCES public.retail_purchase_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT retail_goods_receipts_organization_location_fkey
    FOREIGN KEY (organization_id, location_id)
    REFERENCES public.retail_locations(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT retail_goods_receipts_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT retail_goods_receipts_organization_idempotency_unique UNIQUE (organization_id, idempotency_key)
);

CREATE TABLE public.retail_goods_receipt_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  purchase_order_item_id uuid NOT NULL,
  sku_id uuid NOT NULL,
  received_quantity numeric(18,3) NOT NULL CHECK (received_quantity > 0 AND received_quantity <> 'NaN'::numeric),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retail_goods_receipt_items_organization_receipt_fkey
    FOREIGN KEY (organization_id, receipt_id)
    REFERENCES public.retail_goods_receipts(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT retail_goods_receipt_items_organization_purchase_order_item_fkey
    FOREIGN KEY (organization_id, purchase_order_item_id)
    REFERENCES public.retail_purchase_order_items(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT retail_goods_receipt_items_organization_sku_fkey
    FOREIGN KEY (organization_id, sku_id)
    REFERENCES public.retail_skus(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT retail_goods_receipt_items_organization_receipt_po_item_unique
    UNIQUE (organization_id, receipt_id, purchase_order_item_id)
);

CREATE TABLE public.retail_delivery_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  order_id uuid NOT NULL,
  location_id uuid NOT NULL,
  assigned_driver_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned', 'completed', 'returned', 'cancelled')),
  delivered_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retail_delivery_handoffs_organization_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES public.retail_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT retail_delivery_handoffs_organization_location_fkey
    FOREIGN KEY (organization_id, location_id)
    REFERENCES public.retail_locations(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT retail_delivery_handoffs_organization_order_unique UNIQUE (organization_id, order_id),
  CONSTRAINT retail_delivery_handoffs_completed_at_check
    CHECK ((status = 'completed') = (delivered_at IS NOT NULL)),
  CONSTRAINT retail_delivery_handoffs_organization_id_id_unique UNIQUE (organization_id, id)
);

CREATE TABLE public.retail_cod_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  order_id uuid NOT NULL,
  handoff_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('cash_collected', 'cash_handover', 'finance_confirmed')),
  amount numeric(18,3) NOT NULL CHECK (amount > 0 AND amount <> 'NaN'::numeric),
  currency text NOT NULL DEFAULT 'AED' CHECK (currency ~ '^[A-Z]{3}$'),
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retail_cod_events_organization_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES public.retail_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT retail_cod_events_organization_handoff_fkey
    FOREIGN KEY (organization_id, handoff_id)
    REFERENCES public.retail_delivery_handoffs(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT retail_cod_events_organization_idempotency_unique UNIQUE (organization_id, idempotency_key),
  CONSTRAINT retail_cod_events_organization_order_event_unique UNIQUE (organization_id, order_id, event_type),
  CONSTRAINT retail_cod_events_organization_id_id_unique UNIQUE (organization_id, id)
);

CREATE TABLE public.retail_finance_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  order_id uuid NOT NULL,
  finance_confirmation_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  allocated_amount numeric(18,3) NOT NULL CHECK (allocated_amount > 0 AND allocated_amount <> 'NaN'::numeric),
  allocated_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  allocated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retail_finance_allocations_organization_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES public.retail_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT retail_finance_allocations_organization_confirmation_fkey
    FOREIGN KEY (organization_id, finance_confirmation_id)
    REFERENCES public.retail_cod_events(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT retail_finance_allocations_organization_idempotency_unique UNIQUE (organization_id, idempotency_key)
);

CREATE TABLE public.retail_finance_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  reconciliation_date date NOT NULL,
  collected_amount numeric(18,3) NOT NULL CHECK (collected_amount >= 0 AND collected_amount <> 'NaN'::numeric),
  allocated_amount numeric(18,3) NOT NULL CHECK (allocated_amount >= 0 AND allocated_amount <> 'NaN'::numeric),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reconciled', 'exception')),
  completed_by uuid NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  completed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retail_finance_reconciliations_organization_date_unique UNIQUE (organization_id, reconciliation_date),
  CONSTRAINT retail_finance_reconciliations_completed_check CHECK (
    (status = 'reconciled') = (completed_by IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE OR REPLACE FUNCTION public.retail_sam83_reject_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$ BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'retail_sam83_fact_is_append_only';
END; $$;
REVOKE ALL ON FUNCTION public.retail_sam83_reject_mutation() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.retail_sam83_transition_order()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE line record; available_quantity numeric;
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.source_quotation_id IS DISTINCT FROM OLD.source_quotation_id
    OR NEW.fulfillment_location_id IS DISTINCT FROM OLD.fulfillment_location_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'retail_order_scope_is_immutable';
  END IF;
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF OLD.status IN ('cancelled', 'returned') OR NOT (
    (OLD.status = 'accepted' AND NEW.status IN ('reserved', 'cancelled')) OR
    (OLD.status = 'reserved' AND NEW.status IN ('picking', 'cancelled')) OR
    (OLD.status = 'picking' AND NEW.status IN ('packed', 'cancelled')) OR
    (OLD.status = 'packed' AND NEW.status IN ('fulfilled', 'cancelled')) OR
    (OLD.status = 'fulfilled' AND NEW.status = 'returned')
  ) THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'retail_order_transition_denied'; END IF;
  IF NEW.status = 'reserved' THEN
    FOR line IN SELECT * FROM public.retail_order_items WHERE organization_id = NEW.organization_id AND order_id = NEW.id LOOP
      SELECT available INTO available_quantity FROM public.retail_inventory_balances
       WHERE organization_id = NEW.organization_id AND location_id = NEW.fulfillment_location_id AND sku_id = line.sku_id;
      IF COALESCE(available_quantity, 0) < line.quantity THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'retail_order_insufficient_available_inventory';
      END IF;
      INSERT INTO public.retail_inventory_movements (organization_id, location_id, sku_id, idempotency_key, movement_type, reference_type, reference_id, on_hand_delta, reserved_delta)
      VALUES (NEW.organization_id, NEW.fulfillment_location_id, line.sku_id, line.id, 'reserve', 'retail_order', NEW.id::text, -line.quantity, line.quantity);
    END LOOP;
  ELSIF NEW.status = 'fulfilled' THEN
    FOR line IN SELECT * FROM public.retail_order_items WHERE organization_id = NEW.organization_id AND order_id = NEW.id LOOP
      INSERT INTO public.retail_inventory_movements (organization_id, location_id, sku_id, idempotency_key, movement_type, reference_type, reference_id, reserved_delta)
      VALUES (NEW.organization_id, NEW.fulfillment_location_id, line.sku_id, gen_random_uuid(), 'release', 'retail_order_fulfillment', NEW.id::text, -line.quantity);
    END LOOP;
  ELSIF NEW.status = 'cancelled' AND OLD.status <> 'accepted' THEN
    FOR line IN SELECT * FROM public.retail_order_items WHERE organization_id = NEW.organization_id AND order_id = NEW.id LOOP
      INSERT INTO public.retail_inventory_movements (organization_id, location_id, sku_id, idempotency_key, movement_type, reference_type, reference_id, on_hand_delta, reserved_delta)
      VALUES (NEW.organization_id, NEW.fulfillment_location_id, line.sku_id, gen_random_uuid(), 'release', 'retail_order_cancel', NEW.id::text, line.quantity, -line.quantity);
    END LOOP;
  ELSIF NEW.status = 'returned' THEN
    FOR line IN SELECT * FROM public.retail_order_items WHERE organization_id = NEW.organization_id AND order_id = NEW.id LOOP
      INSERT INTO public.retail_inventory_movements (organization_id, location_id, sku_id, idempotency_key, movement_type, reference_type, reference_id, on_hand_delta)
      VALUES (NEW.organization_id, NEW.fulfillment_location_id, line.sku_id, gen_random_uuid(), 'adjustment', 'retail_order_return', NEW.id::text, line.quantity);
    END LOOP;
  END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.retail_sam83_transition_order() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.retail_sam83_post_receipt_item()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE receipt public.retail_goods_receipts%ROWTYPE;
BEGIN
  SELECT * INTO receipt FROM public.retail_goods_receipts WHERE organization_id = NEW.organization_id AND id = NEW.receipt_id;
  IF NOT FOUND OR receipt.status <> 'posted' THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'retail_receipt_must_be_posted'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.retail_purchase_order_items item WHERE item.organization_id = NEW.organization_id AND item.id = NEW.purchase_order_item_id AND item.sku_id = NEW.sku_id AND item.purchase_order_id = receipt.purchase_order_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'retail_receipt_purchase_order_item_mismatch';
  END IF;
  INSERT INTO public.retail_inventory_movements (organization_id, location_id, sku_id, idempotency_key, movement_type, reference_type, reference_id, on_hand_delta, created_by)
  VALUES (NEW.organization_id, receipt.location_id, NEW.sku_id, NEW.id, 'receive', 'retail_goods_receipt', NEW.receipt_id::text, NEW.received_quantity, receipt.received_by);
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.retail_sam83_post_receipt_item() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.retail_sam83_validate_cod_event()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE previous_actor uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.retail_delivery_handoffs handoff WHERE handoff.organization_id = NEW.organization_id AND handoff.id = NEW.handoff_id AND handoff.order_id = NEW.order_id AND handoff.status = 'completed') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'retail_cod_requires_completed_handoff';
  END IF;
  IF NEW.event_type = 'cash_handover' THEN
    SELECT actor_id INTO previous_actor FROM public.retail_cod_events WHERE organization_id = NEW.organization_id AND order_id = NEW.order_id AND event_type = 'cash_collected' AND amount = NEW.amount;
    IF previous_actor IS NULL OR previous_actor = NEW.actor_id THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'retail_cod_handover_requires_separate_collection'; END IF;
  ELSIF NEW.event_type = 'finance_confirmed' THEN
    SELECT actor_id INTO previous_actor FROM public.retail_cod_events WHERE organization_id = NEW.organization_id AND order_id = NEW.order_id AND event_type = 'cash_handover' AND amount = NEW.amount;
    IF previous_actor IS NULL OR previous_actor = NEW.actor_id THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'retail_finance_confirmation_requires_separate_handover'; END IF;
  END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.retail_sam83_validate_cod_event() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.retail_sam83_validate_finance_allocation()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE confirmed_amount numeric; allocated_total numeric;
BEGIN
  SELECT amount INTO confirmed_amount FROM public.retail_cod_events
   WHERE organization_id = NEW.organization_id AND id = NEW.finance_confirmation_id AND order_id = NEW.order_id AND event_type = 'finance_confirmed';
  IF confirmed_amount IS NULL THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'retail_allocation_requires_finance_confirmation'; END IF;
  SELECT COALESCE(sum(allocated_amount), 0) + NEW.allocated_amount INTO allocated_total
    FROM public.retail_finance_allocations WHERE organization_id = NEW.organization_id AND finance_confirmation_id = NEW.finance_confirmation_id;
  IF allocated_total > confirmed_amount THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'retail_allocation_exceeds_confirmed_cash'; END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.retail_sam83_validate_finance_allocation() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.retail_sam83_validate_reconciliation()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$ BEGIN
  IF NEW.status = 'reconciled' AND NEW.collected_amount <> NEW.allocated_amount THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'retail_reconciliation_difference_requires_exception';
  END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.retail_sam83_validate_reconciliation() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER retail_orders_transition BEFORE UPDATE ON public.retail_orders FOR EACH ROW EXECUTE FUNCTION public.retail_sam83_transition_order();
CREATE TRIGGER retail_order_items_append_only BEFORE UPDATE OR DELETE ON public.retail_order_items FOR EACH ROW EXECUTE FUNCTION public.retail_sam83_reject_mutation();
CREATE TRIGGER retail_purchase_order_items_append_only BEFORE UPDATE OR DELETE ON public.retail_purchase_order_items FOR EACH ROW EXECUTE FUNCTION public.retail_sam83_reject_mutation();
CREATE TRIGGER retail_goods_receipt_items_post_inventory AFTER INSERT ON public.retail_goods_receipt_items FOR EACH ROW EXECUTE FUNCTION public.retail_sam83_post_receipt_item();
CREATE TRIGGER retail_goods_receipt_items_append_only BEFORE UPDATE OR DELETE ON public.retail_goods_receipt_items FOR EACH ROW EXECUTE FUNCTION public.retail_sam83_reject_mutation();
CREATE TRIGGER retail_cod_events_validate BEFORE INSERT ON public.retail_cod_events FOR EACH ROW EXECUTE FUNCTION public.retail_sam83_validate_cod_event();
CREATE TRIGGER retail_cod_events_append_only BEFORE UPDATE OR DELETE ON public.retail_cod_events FOR EACH ROW EXECUTE FUNCTION public.retail_sam83_reject_mutation();
CREATE TRIGGER retail_finance_allocations_validate BEFORE INSERT ON public.retail_finance_allocations FOR EACH ROW EXECUTE FUNCTION public.retail_sam83_validate_finance_allocation();
CREATE TRIGGER retail_finance_allocations_append_only BEFORE UPDATE OR DELETE ON public.retail_finance_allocations FOR EACH ROW EXECUTE FUNCTION public.retail_sam83_reject_mutation();
CREATE TRIGGER retail_finance_reconciliations_validate BEFORE INSERT OR UPDATE ON public.retail_finance_reconciliations FOR EACH ROW EXECUTE FUNCTION public.retail_sam83_validate_reconciliation();

CREATE VIEW public.retail_order_finance_summary WITH (security_invoker = true) AS
SELECT order_row.organization_id, order_row.id AS order_id, order_row.fulfillment_location_id, order_row.status,
  order_row.total_amount, COALESCE(cod.confirmed_amount, 0) AS confirmed_cod_amount,
  COALESCE(allocation.allocated_amount, 0) AS allocated_amount,
  order_row.total_amount - COALESCE(allocation.allocated_amount, 0) AS receivable_amount
FROM public.retail_orders order_row
LEFT JOIN LATERAL (
  SELECT sum(amount) AS confirmed_amount FROM public.retail_cod_events
  WHERE organization_id = order_row.organization_id AND order_id = order_row.id AND event_type = 'finance_confirmed'
) cod ON true
LEFT JOIN LATERAL (
  SELECT sum(allocated_amount) AS allocated_amount FROM public.retail_finance_allocations
  WHERE organization_id = order_row.organization_id AND order_id = order_row.id
) allocation ON true;

INSERT INTO public.capabilities (capability_key, scope, description) VALUES
  ('retail.orders.read', 'organization', 'Read retail orders and order lines.'),
  ('retail.orders.write', 'organization', 'Create retail orders and progress fulfilment state.'),
  ('retail.procurement.read', 'organization', 'Read purchase orders and receipts.'),
  ('retail.procurement.write', 'organization', 'Issue purchase orders and post goods receipts.'),
  ('retail.delivery.read', 'organization', 'Read delivery handoffs and COD events.'),
  ('retail.delivery.write', 'organization', 'Assign delivery and record collection or handover.'),
  ('retail.finance.read', 'organization', 'Read retail finance allocations and reconciliation.'),
  ('retail.finance.write', 'organization', 'Confirm cash, allocate and reconcile retail finance.')
ON CONFLICT (scope, capability_key) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO public.role_capabilities (role_id, capability_id)
SELECT role.id, capability.id FROM public.roles role JOIN public.capabilities capability ON capability.scope = 'organization'
WHERE role.scope = 'organization' AND role.role_key IN ('org_owner', 'org_admin', 'operations', 'finance', 'specialist', 'sales_agent')
  AND capability.capability_key IN ('retail.orders.read', 'retail.procurement.read', 'retail.delivery.read', 'retail.finance.read')
ON CONFLICT (role_id, capability_id) DO NOTHING;
INSERT INTO public.role_capabilities (role_id, capability_id)
SELECT role.id, capability.id FROM public.roles role JOIN public.capabilities capability ON capability.scope = 'organization'
WHERE role.scope = 'organization' AND role.role_key IN ('org_owner', 'org_admin', 'operations', 'sales_agent') AND capability.capability_key = 'retail.orders.write'
ON CONFLICT (role_id, capability_id) DO NOTHING;
INSERT INTO public.role_capabilities (role_id, capability_id)
SELECT role.id, capability.id FROM public.roles role JOIN public.capabilities capability ON capability.scope = 'organization'
WHERE role.scope = 'organization' AND role.role_key IN ('org_owner', 'org_admin', 'operations') AND capability.capability_key = 'retail.procurement.write'
ON CONFLICT (role_id, capability_id) DO NOTHING;
INSERT INTO public.role_capabilities (role_id, capability_id)
SELECT role.id, capability.id FROM public.roles role JOIN public.capabilities capability ON capability.scope = 'organization'
WHERE role.scope = 'organization' AND role.role_key IN ('org_owner', 'org_admin', 'operations', 'specialist') AND capability.capability_key = 'retail.delivery.write'
ON CONFLICT (role_id, capability_id) DO NOTHING;
INSERT INTO public.role_capabilities (role_id, capability_id)
SELECT role.id, capability.id FROM public.roles role JOIN public.capabilities capability ON capability.scope = 'organization'
WHERE role.scope = 'organization' AND role.role_key IN ('org_owner', 'org_admin', 'finance') AND capability.capability_key = 'retail.finance.write'
ON CONFLICT (role_id, capability_id) DO NOTHING;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['retail_orders','retail_order_items','retail_purchase_orders','retail_purchase_order_items','retail_goods_receipts','retail_goods_receipt_items','retail_delivery_handoffs','retail_cod_events','retail_finance_allocations','retail_finance_reconciliations'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', table_name);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', table_name);
  END LOOP;
END; $$;

GRANT SELECT ON public.retail_orders, public.retail_order_items TO authenticated;
GRANT INSERT, UPDATE ON public.retail_orders TO authenticated;
GRANT INSERT ON public.retail_order_items TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.retail_purchase_orders TO authenticated;
GRANT SELECT, INSERT ON public.retail_purchase_order_items, public.retail_goods_receipts, public.retail_goods_receipt_items TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.retail_delivery_handoffs TO authenticated;
GRANT SELECT, INSERT ON public.retail_cod_events, public.retail_finance_allocations, public.retail_finance_reconciliations TO authenticated;
GRANT UPDATE ON public.retail_finance_reconciliations TO authenticated;
GRANT SELECT ON public.retail_order_finance_summary TO authenticated;

CREATE POLICY retail_orders_read ON public.retail_orders FOR SELECT TO authenticated USING (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.orders.read'));
CREATE POLICY retail_orders_write ON public.retail_orders FOR ALL TO authenticated USING (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.orders.write', 'write')) WITH CHECK (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.orders.write', 'write'));
CREATE POLICY retail_order_items_read ON public.retail_order_items FOR SELECT TO authenticated USING (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.orders.read'));
CREATE POLICY retail_order_items_insert ON public.retail_order_items FOR INSERT TO authenticated WITH CHECK (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.orders.write', 'write'));
CREATE POLICY retail_purchase_orders_read ON public.retail_purchase_orders FOR SELECT TO authenticated USING (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.procurement.read'));
CREATE POLICY retail_purchase_orders_write ON public.retail_purchase_orders FOR ALL TO authenticated USING (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.procurement.write', 'write')) WITH CHECK (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.procurement.write', 'write'));
CREATE POLICY retail_purchase_order_items_read ON public.retail_purchase_order_items FOR SELECT TO authenticated USING (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.procurement.read'));
CREATE POLICY retail_purchase_order_items_insert ON public.retail_purchase_order_items FOR INSERT TO authenticated WITH CHECK (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.procurement.write', 'write'));
CREATE POLICY retail_goods_receipts_read ON public.retail_goods_receipts FOR SELECT TO authenticated USING (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.procurement.read'));
CREATE POLICY retail_goods_receipts_insert ON public.retail_goods_receipts FOR INSERT TO authenticated WITH CHECK (received_by = auth.uid() AND public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.procurement.write', 'write'));
CREATE POLICY retail_goods_receipt_items_read ON public.retail_goods_receipt_items FOR SELECT TO authenticated USING (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.procurement.read'));
CREATE POLICY retail_goods_receipt_items_insert ON public.retail_goods_receipt_items FOR INSERT TO authenticated WITH CHECK (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.procurement.write', 'write'));
CREATE POLICY retail_delivery_handoffs_read ON public.retail_delivery_handoffs FOR SELECT TO authenticated USING (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.delivery.read'));
CREATE POLICY retail_delivery_handoffs_write ON public.retail_delivery_handoffs FOR ALL TO authenticated USING (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.delivery.write', 'write')) WITH CHECK (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.delivery.write', 'write'));
CREATE POLICY retail_cod_events_read ON public.retail_cod_events FOR SELECT TO authenticated USING (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.delivery.read') OR public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.finance.read'));
CREATE POLICY retail_cod_events_insert ON public.retail_cod_events FOR INSERT TO authenticated WITH CHECK (actor_id = auth.uid() AND ((event_type IN ('cash_collected', 'cash_handover') AND public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.delivery.write', 'write')) OR (event_type = 'finance_confirmed' AND public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.finance.write', 'write'))));
CREATE POLICY retail_finance_allocations_read ON public.retail_finance_allocations FOR SELECT TO authenticated USING (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.finance.read'));
CREATE POLICY retail_finance_allocations_insert ON public.retail_finance_allocations FOR INSERT TO authenticated WITH CHECK (allocated_by = auth.uid() AND public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.finance.write', 'write'));
CREATE POLICY retail_finance_reconciliations_read ON public.retail_finance_reconciliations FOR SELECT TO authenticated USING (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.finance.read'));
CREATE POLICY retail_finance_reconciliations_write ON public.retail_finance_reconciliations FOR ALL TO authenticated USING (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.finance.write', 'write')) WITH CHECK (public.v4_actor_has_capability(organization_id, auth.uid(), 'retail.finance.write', 'write'));

NOTIFY pgrst, 'reload schema';
COMMIT;
