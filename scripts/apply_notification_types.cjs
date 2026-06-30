// Apply notification types expansion migration
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config({ path: ".env.local" });

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const migration = `
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'lead_created',
  'lead_assigned',
  'lead_stage_change',
  'lead_stage_changed',
  'quote_created',
  'contract_created',
  'contract_signed',
  'payment_due',
  'payment_overdue',
  'payment_received',
  'kpi_target_set',
  'followup_reminder',
  'team_member_added'
));

CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type);
`;

  console.log("=== Expanding notification types ===\n");
  console.log("SQL:\n", migration);

  const r = await supabase.rpc("exec_sql", { query: migration });
  if (r.error) {
    console.error("Migration error:", r.error.message);
    // Try alternative: use Supabase Management API
    console.log("\nTrying Management API...");
    const mgmtRes = await fetch(
      `https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.SUPABASE_PAT}`,
        },
        body: JSON.stringify({ query: migration }),
      }
    );
    const mgmtBody = await mgmtRes.text();
    console.log("Management API response:", mgmtRes.status, mgmtBody.slice(0, 500));
  } else {
    console.log("Migration applied successfully!");
  }
}

main().catch(e => console.error(e));
