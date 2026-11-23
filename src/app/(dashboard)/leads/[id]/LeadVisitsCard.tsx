"use client";

// Visits of this customer (S23): plan, approval, report and review. Shown to admin, boss, operator and the sales
// owner; the API and the database check the role and the lead again.
import { MapPin } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import VisitPanel from "@/components/opportunity-visit/VisitPanel";
import type { Lead } from "./types";

interface Props { lead: Lead; t: (key: string) => string; role: string | null }

export default function LeadVisitsCard({ lead, t, role }: Props) {
  if (!role || !["admin", "boss", "operator", "sales"].includes(role)) return null;
  return (
    <Card data-testid="lead-visits-card">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm"><MapPin className="h-4 w-4 text-copper-700" />{t("visits.cardTitle")}</CardTitle>
      </CardHeader>
      <CardContent><VisitPanel t={t} role={role} leadId={lead.id} /></CardContent>
    </Card>
  );
}
