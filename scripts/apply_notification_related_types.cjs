// Apply related_type expansion for notifications
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config({ path: ".env.local" });

async function main() {
  const migration = `
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_related_type_check;

ALTER TABLE notifications ADD CONSTRAINT notifications_related_type_check CHECK (
  related_type IS NULL OR related_type IN ('lead', 'contract', 'payment', 'kpi', 'quote')
);
`;

  console.log("=== Expanding notification related_types ===\n");

  const res = await fetch(
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
  console.log("Management API response:", res.status, await res.text());
}

main().catch(e => console.error(e));
