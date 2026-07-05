"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtDubai } from "@/lib/utils";
import { AlertTriangle, CheckCircle2, Clock, MessageSquare, Phone } from "lucide-react";
import type { FollowUpLog, Lead, LeadMilestone } from "./types";

interface Props {
  lead: Lead | null;
  followUpLogs: FollowUpLog[];
  leadMilestones: LeadMilestone[];
  loading?: boolean;
  error?: string | null;
  t: (key: string) => string;
}

export default function LeadContactQualityPanel({
  lead,
  followUpLogs,
  leadMilestones,
  loading,
  error,
  t,
}: Props) {
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("leads.contactQuality") || "Contact Quality"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">Loading…</div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("leads.contactQuality") || "Contact Quality"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-red-400">{error}</div>
        </CardContent>
      </Card>
    );
  }

  if (!lead) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("leads.contactQuality") || "Contact Quality"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">No data</div>
        </CardContent>
      </Card>
    );
  }

  const sortedLogs = [...followUpLogs].sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
  const recentLogs = sortedLogs.slice(0, 3);

  const firstContactMilestone = leadMilestones.find(
    (milestone) => milestone.milestone_key === "first_contact"
  );

  const quality = lead.quality ?? "pending";
  const qualityBadgeClass =
    quality === "good"
      ? "bg-emerald-500/10 text-emerald-400"
      : quality === "normal"
        ? "bg-amber-500/10 text-amber-400"
        : "bg-gray-500/10 text-muted-foreground";

  const contactTypeIcon = (type: string) => {
    if (type === "phone") return <Phone className="h-3 w-3" />;
    if (type === "whatsapp") return <MessageSquare className="h-3 w-3" />;
    return <Clock className="h-3 w-3" />;
  };

  const hasNoContact =
    (lead.followup_count ?? 0) === 0 && !lead.last_contact_date;
  const isOverdue =
    lead.next_followup_date &&
    new Date(lead.next_followup_date) < new Date();
  const missingFirstContact = !firstContactMilestone;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span>{t("leads.contactQuality") || "Contact Quality"}</span>
          <Badge className={qualityBadgeClass}>
            {quality === "good"
              ? "✓ Good"
              : quality === "normal"
                ? "Normal"
                : "Pending"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {quality === "pending" && lead.poor_reason && (
          <div className="flex items-start gap-2 rounded bg-amber-500/5 px-2 py-1.5 text-xs text-amber-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <span>{lead.poor_reason}</span>
          </div>
        )}

        <div className="space-y-1.5">
          {hasNoContact && (
            <div className="flex items-center gap-2 text-xs text-red-400">
              <AlertTriangle className="h-3 w-3" />
              No contact yet
            </div>
          )}
          {missingFirstContact && (
            <div className="flex items-center gap-2 text-xs text-amber-400">
              <AlertTriangle className="h-3 w-3" />
              First contact not completed
            </div>
          )}
          {isOverdue && (
            <div className="flex items-center gap-2 text-xs text-red-400">
              <Clock className="h-3 w-3" />
              Follow-up overdue (
              {fmtDubai(lead.next_followup_date!, { locale: "en" })})
            </div>
          )}
          {firstContactMilestone && !hasNoContact && !isOverdue && (
            <div className="flex items-center gap-2 text-xs text-emerald-400">
              <CheckCircle2 className="h-3 w-3" />
              First contact completed
            </div>
          )}
        </div>

        <div className="border-t border-border/50 pt-2">
          <div className="mb-2 text-xs font-medium text-muted-foreground">
            Recent Contacts ({followUpLogs.length} total)
          </div>
          {recentLogs.length === 0 ? (
            <div className="text-xs text-muted-foreground">
              No follow-up logs
            </div>
          ) : (
            <ul className="space-y-1.5">
              {recentLogs.map((log) => (
                <li key={log.id} className="flex items-start gap-2 text-xs">
                  <span className="mt-0.5 text-muted-foreground">
                    {contactTypeIcon(log.contact_type)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate">
                      {log.summary || "(no summary)"}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {fmtDubai(log.created_at, { locale: "en" })}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
