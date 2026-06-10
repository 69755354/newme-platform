// Apply DB migrations for lead INSERT fix + KPI targets table
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config({ path: ".env.local" });

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // Fix 1: Lead INSERT RLS
  console.log("=== Fix 1: Lead INSERT RLS ===");
  const r1 = await supabase.rpc("exec_sql", { query: `
    CREATE POLICY IF NOT EXISTS "sales_create_leads" ON leads FOR INSERT
    WITH CHECK (
      auth.uid() = assigned_to
      OR assigned_to IS NULL
      OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss'))
    )
  `});
  console.log("sales_create_leads:", r1.error ? r1.error.message : "OK");

  // Fix 2: Activities CREATE for sales on own leads
  const r2 = await supabase.rpc("exec_sql", { query: `
    CREATE POLICY IF NOT EXISTS "activity_sales_create_on_lead" ON activities FOR INSERT
    WITH CHECK (
      lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid())
      OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss'))
    )
  `});
  console.log("activity_create:", r2.error ? r2.error.message : "OK");

  // Fix 3: KPI targets table + RLS
  console.log("\n=== Fix 3: KPI Targets ===");
  const r3 = await supabase.rpc("exec_sql", { query: `
    CREATE TABLE IF NOT EXISTS kpi_targets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      period TEXT NOT NULL,
      target_type TEXT NOT NULL CHECK (target_type IN ('signing','collection')),
      target_amount NUMERIC(12,2) NOT NULL,
      assigned_to UUID REFERENCES profiles(id),
      notes TEXT,
      set_by UUID REFERENCES profiles(id),
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(period, target_type, assigned_to)
    );
    ALTER TABLE kpi_targets ENABLE ROW LEVEL SECURITY;
    CREATE POLICY IF NOT EXISTS "kpi_admin_all" ON kpi_targets FOR ALL
      USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')))
      WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));
    CREATE POLICY IF NOT EXISTS "kpi_sales_read_own" ON kpi_targets FOR SELECT
      USING (assigned_to = auth.uid() OR assigned_to IS NULL);
  `});
  console.log("kpi_targets:", r3.error ? r3.error.message : "OK");

  console.log("\nDone.");
}

main().catch(e => console.error(e));
