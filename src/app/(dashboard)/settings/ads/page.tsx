import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase-server";
import AdsClient from "./ads-client";

/* ─── Server-side role guard ─── */
async function authorize() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    redirect("/login");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (!profile || !["admin", "boss"].includes(profile.role)) {
    redirect("/dashboard");
  }

  return { user, role: profile.role };
}

export default async function SettingsAdsPage() {
  const { role } = await authorize();

  const supabase = await createServerSupabase();
  const { data: leads } = await supabase
    .from("leads")
    .select(
      "source, source_platform, campaign_name, utm_campaign, meta_campaign, adset_name, ad_name, stage, quotation_value, quality"
    )
    .order("created_at", { ascending: false })
    .limit(500);

  /* ─── Aggregate by source platform ─── */
  const groups: Record<
    string,
    { total: number; valid: number; quoted: number; won: number; value: number }
  > = {};

  for (const l of leads ?? []) {
    const key = l.source_platform || l.source || "other";
    if (!groups[key])
      groups[key] = { total: 0, valid: 0, quoted: 0, won: 0, value: 0 };
    groups[key].total++;
    if (l.quality === "valid") groups[key].valid++;
    if (
      ["quotation_submitted", "negotiation", "pending_decision", "won"].includes(
        l.stage
      )
    )
      groups[key].quoted++;
    if (l.stage === "won") groups[key].won++;
    groups[key].value += l.quotation_value || 0;
  }

  const sorted = Object.entries(groups).sort(([, a], [, b]) => b.total - a.total);

  const totals = sorted.reduce(
    (acc, [, g]) => ({
      total: acc.total + g.total,
      valid: acc.valid + g.valid,
      quoted: acc.quoted + g.quoted,
      won: acc.won + g.won,
      value: acc.value + g.value,
    }),
    { total: 0, valid: 0, quoted: 0, won: 0, value: 0 }
  );

  return <AdsClient sorted={sorted} totals={totals} />;
}
