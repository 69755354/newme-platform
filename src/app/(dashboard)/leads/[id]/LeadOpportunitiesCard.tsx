"use client";

// Opportunities of this customer (S23): the list and the create form. The card is for admin, boss, operator and
// the sales owner; the API refuses everyone else, so a role that cannot use it simply sees nothing.
import { Briefcase } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import OpportunityPanel from "@/components/opportunity-visit/OpportunityPanel";
import type { Lead } from "./types";

interface Props { lead: Lead; t: (key: string) => string; lang: string; role: string | null }

export default function LeadOpportunitiesCard({ lead, t, lang, role }: Props) {
  if (!role || !["admin", "boss", "operator", "sales"].includes(role)) return null;
  return (
    <Card data-testid="lead-opportunities-card">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm"><Briefcase className="h-4 w-4 text-copper-400" />{t("opportunities.cardTitle")}</CardTitle>
      </CardHeader>
      <CardContent><OpportunityPanel t={t} lang={lang} leadId={lead.id} /></CardContent>
    </Card>
  );
}
