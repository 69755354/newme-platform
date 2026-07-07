"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtDubai } from "@/lib/utils";
import { AlertTriangle, CheckCircle2, Clock, Lock, MessageSquare, Phone, ShieldCheck, Unlock } from "lucide-react";
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
      new Date(b.contact_time || b.created_at).getTime() -
      new Date(a.contact_time || a.created_at).getTime()
  );
  const recentLogs = sortedLogs.slice(0, 3);

  // ─── First-contact milestone progress ───
  const firstContactMilestone = leadMilestones.find(
    (milestone) => milestone.milestone_key === "first_contact"
  );
  const milestoneCompleted = firstContactMilestone?.completed ?? false;

  // Count follow-up logs that have contact_time (valid contact records)
  const validContacts = followUpLogs.filter(
    (log) => log.contact_time != null
  );
  const contactCount = validContacts.length;
  const contactsNeeded = 3;
  const contactsMet = contactCount >= contactsNeeded;

  // Quality status
  const quality = lead.quality ?? "pending";
  const qualityAssessed = quality !== "pending";
  const qualityBadgeClass =
    quality === "good"
      ? "bg-emerald-500/10 text-emerald-400"
      : quality === "normal"
        ? "bg-amber-500/10 text-amber-400"
        : "bg-gray-500/10 text-muted-foreground";

  // Gate status: both conditions must be met
  const gatePassed = contactsMet && qualityAssessed;
  // Milestone from DB: trigger sets completed=true when gate is passed
  // If trigger hasn't fired yet but conditions are met, show as "pending unlock"

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
      <CardContent className="space-y-4">
        {/* ── First-contact milestone progress ── */}
        <div className="rounded-lg border border-border/50 p-3 space-y-2">
          <div className="flex items-center gap-2">
            {milestoneCompleted ? (
              <ShieldCheck className="h-4 w-4 text-emerald-400" />
            ) : gatePassed ? (
              <Unlock className="h-4 w-4 text-amber-400" />
            ) : (
              <Lock className="h-4 w-4 text-muted-foreground" />
            )}
            <span className="text-xs font-medium">
              {milestoneCompleted
                ? "First Contact — Unlocked ✓"
                : gatePassed
                  ? "Requirements Met — Pending Unlock"
                  : "First Contact — Locked"}
            </span>
          </div>

          {/* Contact count progress */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                Contact records (with valid time)
              </span>
              <span
                className={contactsMet ? "text-emerald-400 font-medium" : "text-amber-400"}
              >
                {contactCount}/{contactsNeeded}
              </span>
            </div>
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  contactsMet ? "bg-emerald-500" : "bg-amber-500"
                }`}
                style={{ width: `${Math.min((contactCount / contactsNeeded) * 100, 100)}%` }}
              />
            </div>
            {contactCount < contactsNeeded && (
              <p className="text-[10px] text-muted-foreground">
                Need {contactsNeeded - contactCount} more contact
                {contactsNeeded - contactCount > 1 ? "s" : ""} with valid time
              </p>
            )}
          </div>

          {/* Quality check */}
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Quality assessed</span>
            <span>
              {qualityAssessed ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 inline" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 text-amber-400 inline" />
              )}
            </span>
          </div>

          {/* Summary bar */}
          <div className="flex gap-2 text-[10px]">
            <span
              className={`px-1.5 py-0.5 rounded ${
                contactsMet
                  ? "bg-emerald-500/10 text-emerald-400"
                  : "bg-amber-500/10 text-amber-400"
              }`}
            >
              Contacts: {contactsMet ? "✓" : "✗"}
            </span>
            <span
              className={`px-1.5 py-0.5 rounded ${
                qualityAssessed
                  ? "bg-emerald-500/10 text-emerald-400"
                  : "bg-amber-500/10 text-amber-400"
              }`}
            >
              Quality: {qualityAssessed ? "✓" : "✗"}
            </span>
          </div>
        </div>

        {/* ── Existing status indicators ── */}
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
          {isOverdue && (
            <div className="flex items-center gap-2 text-xs text-red-400">
              <Clock className="h-3 w-3" />
              Follow-up overdue (
              {fmtDubai(lead.next_followup_date!, { locale: "en" })})
            </div>
          )}
          {!hasNoContact && !isOverdue && (
            <div className="flex items-center gap-2 text-xs text-emerald-400">
              <CheckCircle2 className="h-3 w-3" />
              Contact activity normal
            </div>
          )}
        </div>

        {/* ── Recent contacts ── */}
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
                      {fmtDubai(log.contact_time || log.created_at, {
                        locale: "en",
                      })}
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
