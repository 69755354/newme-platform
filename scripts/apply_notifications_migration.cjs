// Apply notifications table migration
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config({ path: ".env.local" });

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const migration = `
CREATE TABLE IF NOT EXISTS notifications (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID REFERENCES profiles(id) NOT NULL,
    type          VARCHAR(50) NOT NULL CHECK (type IN (
      'lead_assigned','lead_stage_change','payment_overdue',
      'payment_received','kpi_target_set','contract_signed','followup_reminder'
    )),
    title         TEXT NOT NULL,
    body          TEXT,
    related_id    UUID,
    related_type  VARCHAR(30) CHECK (related_type IN ('lead','contract','payment','kpi')),
    is_read       BOOLEAN DEFAULT false,
    created_at    TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY IF NOT EXISTS "notifications_user_read" ON notifications FOR SELECT
    USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY IF NOT EXISTS "notifications_admin_read_all" ON notifications FOR SELECT
    USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY IF NOT EXISTS "notifications_user_update" ON notifications FOR UPDATE
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY IF NOT EXISTS "notifications_service_insert" ON notifications FOR INSERT
    WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_notifications_user_read_created
  ON notifications(user_id, is_read, created_at DESC);
`;

  console.log("=== Creating notifications table ===");
  const r = await supabase.rpc("exec_sql", { query: migration });
  if (r.error) {
    console.error("Migration error:", r.error.message);
  } else {
    console.log("Done (table may already exist)");
  }
}

main().catch(e => console.error(e));
