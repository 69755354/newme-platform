import { createServerSupabase } from "@/lib/supabase-server";
import { authorizeServerPage } from "@/lib/server-page-auth";
import { ConnectionFailed } from "@/components/ConnectionFailed";
import AdsClient from "./ads-client";
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";

export default async function SettingsAdsPage() {
  /* ─── Server-side guard: session, is_active, forced password change, role ─── */
  const session = await authorizeServerPage({ roles: ["admin", "boss"] });
  if (session.status === "unavailable") {
    return <DashboardScrollContainer><ConnectionFailed /></DashboardScrollContainer>;
  }
  const { role } = session;

  const supabase = await createServerSupabase();
  const { data: leads } = await supabase
    .from("leads")
    .select(
      "source, source_platform, campaign_name, utm_campaign, meta_campaign, adset_name, ad_name, stage, final_status, quotation_value, quality"
    )
    .order("created_at", { ascending: false })
    .limit(500);

  /* ─── Aggregate by source platform ─── */
  const groups: Record<
    string,
    { total: number; valid: number; quoted: number; won: number; value: number }
  > = {};

  for (const l of leads ?? []) {
    const key = l.source || l.source_platform || "other";
    if (!groups[key])
      groups[key] = { total: 0, valid: 0, quoted: 0, won: 0, value: 0 };
    groups[key].total++;
    // Stored quality values are good/normal/poor/pending; "valid" never occurs.
    if (l.quality === "good" || l.quality === "normal") groups[key].valid++;
    const won = l.final_status === "won" || l.stage === "won";
    const quoted = won ||
      (l.stage !== null && ["quotation_submitted", "negotiation", "pending_decision"].includes(l.stage));
    if (quoted) groups[key].quoted++;
    if (won) groups[key].won++;
    if (quoted) groups[key].value += l.quotation_value || 0;
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

  return (
    <DashboardScrollContainer>
      <AdsClient sorted={sorted} totals={totals} />
    </DashboardScrollContainer>
  );
}
