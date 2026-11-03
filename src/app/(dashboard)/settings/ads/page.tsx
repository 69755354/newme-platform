import { createServerSupabase } from "@/lib/supabase-server";
import { authorizeServerPage } from "@/lib/server-page-auth";
import { ConnectionFailed } from "@/components/ConnectionFailed";
import AdsClient from "./ads-client";
import { fetchCountedLeads } from "@/lib/fetch-all-rows.mjs";
import {
  ADS_ATTRIBUTION_COLUMNS,
  aggregateAttribution,
  totalAttribution,
  type MetricLead,
} from "@/lib/lead-metrics.mjs";
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";

export default async function SettingsAdsPage() {
  /* ─── Server-side guard: session, is_active, forced password change, role ─── */
  const session = await authorizeServerPage({ roles: ["admin", "boss"] });
  if (session.status === "unavailable") {
    return <DashboardScrollContainer><ConnectionFailed /></DashboardScrollContainer>;
  }
  const { role } = session;

  const supabase = await createServerSupabase();
  // The same rows and the same counting as /ads: every non-archived lead, paged
  // (this page used to read 500 rows including archived ones, so its total was
  // higher than /ads), grouped by src/lib/lead-metrics.mjs.
  const { data: leads } = await fetchCountedLeads(supabase, ADS_ATTRIBUTION_COLUMNS);
  const groups = aggregateAttribution(leads as MetricLead[]);
  const sorted = Object.entries(groups).sort(([, a], [, b]) => b.total - a.total);
  const totals = totalAttribution(groups);

  return (
    <DashboardScrollContainer>
      <AdsClient sorted={sorted} totals={totals} />
    </DashboardScrollContainer>
  );
}
