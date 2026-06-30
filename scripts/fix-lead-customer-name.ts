/**
 * Fix lead customer_name — set to '待定（需补填）' for id bcb57cef-ff9c-4ad2-aea3-a3764868564a
 */
import { createClient } from "@supabase/supabase-js";

async function main() {
  const SUPABASE_URL = "https://vfopmpxlhwzpxqegayew.supabase.co";
  // Get service role key from Management API
  const PAT = "sbp_bbaf7ebe1a9a262efc5e52d3ad74341b17f1267e";
  const PROJECT_REF = "vfopmpxlhwzpxqegayew";

  const res = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys`,
    { headers: { Authorization: `Bearer ${PAT}` } }
  );
  const keys = await res.json();
  const srKey = keys.find((k: any) => k.name === "service_role").api_key;

  const supabase = createClient(SUPABASE_URL, srKey);

  const { data, error } = await supabase
    .from("leads")
    .update({ customer_name: "待定（需补填）" })
    .eq("id", "bcb57cef-ff9c-4ad2-aea3-a3764868564a")
    .select();

  if (error) {
    console.error("Error updating lead:", error);
    process.exit(1);
  }
  console.log("Success! Updated lead:", JSON.stringify(data, null, 2));
}

main();
