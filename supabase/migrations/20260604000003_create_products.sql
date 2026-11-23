-- Products table for quotes integration
-- 2026-06-04
CREATE TABLE IF NOT EXISTS products (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID, -- legacy placeholder; no tenants schema exists in this migration chain
    name        TEXT NOT NULL,
    sku         TEXT,
    category    TEXT DEFAULT 'general',
    unit        TEXT DEFAULT 'pcs',
    unit_price  NUMERIC DEFAULT 0,
    description TEXT,
    is_active   BOOLEAN DEFAULT true,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);

-- RLS for products
CREATE POLICY "products_admin_all" ON products FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

CREATE POLICY "products_sales_select" ON products FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid()));

-- Seed with common KNX/smart home products
INSERT INTO products (name, sku, category, unit, unit_price, description) VALUES
  ('KNX Power Supply 640mA', 'KNX-PS-640', 'knx', 'pcs', 850, 'KNX bus power supply unit, 640mA'),
  ('KNX IP Router', 'KNX-IPR', 'knx', 'pcs', 1200, 'KNX/IP router for line coupling'),
  ('KNX 8-Channel Switch Actuator', 'KNX-SA-8', 'knx', 'pcs', 950, '8-channel switching actuator 16A'),
  ('KNX 4-Channel Dimmer', 'KNX-DIM-4', 'knx', 'pcs', 1100, '4-channel universal dimmer 250W'),
  ('KNX 6-Button Push Sensor', 'KNX-PS-6', 'knx', 'pcs', 650, '6-button KNX push button sensor'),
  ('KNX Touch Panel 5"', 'KNX-TP-5', 'knx', 'pcs', 3200, '5-inch KNX touch panel, wall-mounted'),
  ('KNX Motion Sensor', 'KNX-MS', 'knx', 'pcs', 450, 'KNX PIR motion/presence sensor, ceiling mount'),
  ('DALI Gateway', 'KNX-DALI-GW', 'knx', 'pcs', 1500, 'KNX-DALI gateway, 64 devices'),
  ('KNX Blind Actuator 4-Ch', 'KNX-BA-4', 'knx', 'pcs', 980, '4-channel blind/shutter actuator'),
  ('KNX HVAC Controller', 'KNX-HVAC', 'knx', 'pcs', 1800, 'KNX heating/cooling controller'),
  ('Installation & Commissioning', 'SVC-INSTALL', 'service', 'day', 2500, 'On-site installation and commissioning per day'),
  ('System Design Fee', 'SVC-DESIGN', 'service', 'project', 5000, 'KNX system design and documentation'),
  ('CAT6 Network Cable', 'CABLE-CAT6', 'cable', 'meter', 8, 'CAT6 UTP network cable per meter'),
  ('KNX Bus Cable', 'CABLE-KNX', 'cable', 'meter', 12, 'KNX certified bus cable YCYM 2x2x0.8'),
  ('Speaker Cable 2x1.5mm', 'CABLE-SPK', 'cable', 'meter', 6, 'Speaker cable 2x1.5mm² per meter')
ON CONFLICT DO NOTHING;
