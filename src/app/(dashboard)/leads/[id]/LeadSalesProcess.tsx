"use client";

// Middle column — Sales Process. Drives the deal forward:
// milestone checklist → next required action → missing required fields (gated by
// stage) → stage progress / Won-Lost → quote / contract / payment links.
//
// All mutations call back into page.tsx handlers (onUpdateField, onStageChange,
// onToggleMilestone, …). Inline edits reuse the page-owned render closures so the
// single-edit-at-a-time behaviour is preserved across columns.

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { cn, fmtDubai } from "@/lib/utils";
import {
  CheckCircle,
  AlertTriangle,
  ShieldAlert,
  Target,
  DollarSign,
  Plus,
  FileText,
  WandSparkles,
  Calendar,
  Send,
  ThumbsUp,
  Minus,
  ThumbsDown,
  Phone,
  MessageSquare,
  Clock,
} from "lucide-react";
import { COMPLETABLE_MILESTONES } from "@/lib/milestones";
import { calculateHealthScore } from "@/lib/health-score";
import { evaluateFirstContactGate } from "@/lib/first-contact-gate.mjs";
import { STAGES, STAGE_COLORS } from "./types";
import { PIPELINE_STAGES } from "@/shared/kanban/types";
import { fmtAED, daysSince } from "./utils";
import type {
  Lead,
  LeadTrace,
  LeadMilestone,
  FollowUpLog,
  Task,
  RenderInlineEdit,
  RenderDateEdit,
  RenderJsonEdit,
} from "./types";

interface Props {
  lead: Lead;
  leadTrace: LeadTrace[];
  followUpLogs: FollowUpLog[];
  milestones: LeadMilestone[];
  nextTask: Task | null;
  updating: boolean;
  onToggleMilestone: (milestoneKey: string, currentlyCompleted: boolean) => void;
  onUpdateField: (field: string, value: any, eventType?: string, eventDesc?: string) => void;
  onStageChange: (stage: string) => void;
  onWon: () => void;
  onLost: () => void;
  onOpenQuoteCalculator: () => void;
  onCreateContract: () => void;
  onGenerateKnx: () => void;
  renderInlineEdit: RenderInlineEdit;
  renderDateEdit: RenderDateEdit;
  renderJsonEdit: RenderJsonEdit;
  renderNextFollowupDate: () => React.ReactNode;
  renderNextAction: () => React.ReactNode;
  onAddStructuredContact: (params: {
    contact_method: string;
    contact_time: string;
    contact_result: string;
    summary?: string;
  }) => Promise<void>;
  t: (key: string) => string;
  lang: "en" | "zh";
}

type MissingField = {
  key: string;
  label: string;
  kind: "text" | "json" | "contract";
};

export default function LeadSalesProcess({
  lead,
  leadTrace,
  followUpLogs,
  milestones,
  nextTask,
  updating,
  onToggleMilestone,
  onUpdateField,
  onStageChange,
  onWon,
  onLost,
  onOpenQuoteCalculator,
  onCreateContract,
  onGenerateKnx,
  renderInlineEdit,
  renderDateEdit: _renderDateEdit,
  renderJsonEdit,
  renderNextFollowupDate,
  renderNextAction,
  onAddStructuredContact,
  t,
  lang,
}: Props) {
  // ── Inline workspace state for first_contact milestone ──
  const [contactMethod, setContactMethod] = useState("");
  const [contactTime, setContactTime] = useState(new Date().toISOString().slice(0, 16));
  const [contactResult, setContactResult] = useState("");
  const [contactNotes, setContactNotes] = useState("");
  const [contactFormOpen, setContactFormOpen] = useState(false);
  const [contactSubmitting, setContactSubmitting] = useState(false);
  const [showQualityPoorReason, setShowQualityPoorReason] = useState(false);
  const [qualityPoorReason, setQualityPoorReason] = useState("");
  const [qualitySetting, setQualitySetting] = useState<string | null>(null);

  // Latest trace row carries the quote / contract / payment state for the links.
  const trace = leadTrace[0];

  // ── Health score (Phase B) — shown as a badge in Stage Progress ──
  const health = calculateHealthScore({
    hasRecentFollowUp:
      (lead.followup_count ?? 0) > 0 && (daysSince(lead.last_contact_date) ?? Infinity) <= 7,
    hasMeeting:
      lead.final_status === "won" ||
      ["negotiation", "pending_decision"].includes(lead.stage),
    hasDrawings: !!lead.circuit_diagrams,
    hasQuotation:
      lead.final_status === "won" ||
      ["quotation_submitted", "negotiation", "pending_decision"].includes(lead.stage),
    isOverdue: !!nextTask && new Date(nextTask.due_at).getTime() < Date.now(),
  });
  const healthLevelLabel =
    health.level === "healthy"
      ? t("leadDetail.health_healthy")
      : health.level === "at_risk"
      ? t("leadDetail.health_at_risk")
      : t("leadDetail.health_stale");
  const healthColor =
    health.score >= 50
      ? "bg-emerald-500/10 text-emerald-400"
      : health.score >= 20
      ? "bg-amber-500/10 text-amber-400"
      : "bg-red-500/10 text-red-400";

  const nextTaskOverdue = !!nextTask && new Date(nextTask.due_at).getTime() < Date.now();
  const completeContactCount = followUpLogs.filter(
    (log) => log.contact_time != null && !!log.contact_result?.trim(),
  ).length;
  const firstContactGate = evaluateFirstContactGate({
    currentStage: lead.stage,
    nextStage: "contacted",
    contactCount: completeContactCount,
    quality: lead.quality,
  });

  // ── Missing required fields, gated by current stage (display only, no block) ──
  const STAGE_ORDER = STAGES; // new … lost
  const stageIdx = STAGE_ORDER.indexOf(lead.final_status === "won" ? "won" : lead.stage);
  const missingFields: MissingField[] = (() => {
    const activeStage = lead.final_status === "lost" ? "lost" : lead.final_status === "won" ? "won" : lead.stage;
    if (activeStage === "lost") {
      return lead.lost_reason
        ? []
        : [{ key: "lost_reason", label: t("leadDetail.lostReason"), kind: "text" as const }];
    }
    const reqIdx = (s: string) => STAGE_ORDER.indexOf(s);
    const candidates: MissingField[] = [
      { key: "customer_name", label: t("leadDetail.customerName"), kind: "text" },
      { key: "phone", label: t("leadDetail.phone"), kind: "text" },
      { key: "project_type", label: t("leadDetail.projectType"), kind: "text" },
      { key: "project_status", label: t("leadDetail.projectStatus"), kind: "text" },
      { key: "location", label: t("leadDetail.address"), kind: "text" },
      { key: "smart_requirements", label: t("leadDetail.smartRequirements"), kind: "json" },
      { key: "quotation_value", label: t("leadDetail.quotationValue"), kind: "text" },
    ];
    // stage threshold at which each candidate becomes required (cumulative)
    const thresholds: Record<string, number> = {
      customer_name: reqIdx("new"),
      phone: reqIdx("contacted"),
      project_type: reqIdx("requirement_confirmed"),
      project_status: reqIdx("requirement_confirmed"),
      location: reqIdx("requirement_confirmed"),
      smart_requirements: reqIdx("solution_submitted"),
      quotation_value: reqIdx("quotation_submitted"),
    };
    const filled: Record<string, boolean> = {
      customer_name: !!lead.customer_name,
      phone: !!lead.phone,
      project_type: !!lead.project_type,
      project_status: !!lead.project_status,
      location: !!lead.location,
      smart_requirements: !!(lead.ai_summary || lead.smart_requirements),
      quotation_value: !!(lead.quotation_value && lead.quotation_value > 0),
    };
    const out = candidates.filter(
      (c) => stageIdx >= thresholds[c.key] && !filled[c.key]
    );
    if (activeStage === "won" && !trace?.contract_id) {
      out.push({ key: "contract", label: t("leadDetail.contractLabel"), kind: "contract" });
    }
    return out;
  })();

  // ── Milestone checklist state (7-step, lock/unlock logic) ──
  const completedKeys = milestones.filter((m) => m.completed).map((m) => m.milestone_key);
  const nextPendingKey = COMPLETABLE_MILESTONES.find((k) => !completedKeys.includes(k));
  const isLocked = (key: string): boolean => {
    if (completedKeys.includes(key)) return false;
    if (key === nextPendingKey) return false;
    return true;
  };

  const hasContract = !!trace?.contract_id;
  const hasPayment = !!trace?.payment_id;
  const hasQuotation = !!trace?.quotation_id || !!(lead.quotation_value && lead.quotation_value > 0);

  return (
    <div className="space-y-4">
      {/* AI Summary */}
      {lead.ai_summary && (
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">{t("leadDetail.aiAnalysis")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-foreground text-sm">{lead.ai_summary}</p>
            {lead.ai_tags && lead.ai_tags.length > 0 && (
              <div className="flex gap-2 mt-3 flex-wrap">
                {lead.ai_tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="text-xs border-border text-muted-foreground">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Current Milestone — 7-step checklist */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-muted-foreground flex items-center gap-2">
            <CheckCircle className="w-4 h-4" /> {t("leadDetail.currentMilestone")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-0">
            {COMPLETABLE_MILESTONES.map((key, idx) => {
              const completed = completedKeys.includes(key);
              const locked = isLocked(key);
              const isNext = key === nextPendingKey;
              return (
                <div
                  key={key}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 rounded-md transition-colors",
                    locked ? "opacity-40" : "",
                    isNext && !completed ? "bg-copper-500/5 border border-copper-500/15" : ""
                  )}
                >
                  <button
                    onClick={() => {
                      if (locked) return;
                      onToggleMilestone(key, completed);
                    }}
                    disabled={locked}
                    className={cn(
                      "w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors",
                      completed
                        ? "bg-emerald-500 border-emerald-500 text-white cursor-pointer"
                        : locked
                        ? "border-gray-700 bg-transparent cursor-not-allowed"
                        : "border-copper-500 bg-transparent hover:bg-copper-500/10 cursor-pointer"
                    )}
                  >
                    {completed && <CheckCircle className="w-3.5 h-3.5" />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <p className={cn("text-sm", completed ? "text-foreground line-through opacity-60" : "text-foreground")}>
                      {t(`leadDetail.milestone_${key}`)}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {t(`leadDetail.milestone_desc_${key}`)}
                    </p>
                    {completed && <p className="text-[10px] text-emerald-400">{t("leadDetail.milestoneCompleted")}</p>}
                    {isNext && !completed && <p className="text-[10px] text-copper-400">{t("leadDetail.milestoneNext")}</p>}
                    {locked && <p className="text-[10px] text-gray-600">{t("leadDetail.milestoneLocked")}</p>}
                    {/* first_contact inline workspace */}
                    {key === "first_contact" && !completed && isNext && (() => {
                      const contactTimeCount = followUpLogs.filter(l => l.contact_time != null).length;
                      const qAssessed = lead.quality && lead.quality !== "pending";
                      const contactsNeeded = 1;
                      const coachingTarget = 3;
                      const contactsMet = contactTimeCount >= contactsNeeded;

                      // Sorted recent contacts
                      const sortedLogs = [...followUpLogs]
                        .filter(l => l.contact_time != null)
                        .sort((a, b) =>
                          new Date(b.contact_time!).getTime() - new Date(a.contact_time!).getTime()
                        );
                      const recentContacts = sortedLogs.slice(0, 3);

                      const contactTypeIcon = (type: string) => {
                        if (type === "phone") return <Phone className="h-3 w-3 shrink-0" />;
                        if (type === "whatsapp") return <MessageSquare className="h-3 w-3 shrink-0" />;
                        return <Clock className="h-3 w-3 shrink-0" />;
                      };

                      const handleAddStructuredContact = async () => {
                        if (contactSubmitting) return;
                        if (!contactMethod || !contactTime || !contactResult.trim()) return;
                        setContactSubmitting(true);
                        try {
                          await onAddStructuredContact({
                            contact_method: contactMethod,
                            contact_time: new Date(contactTime).toISOString(),
                            contact_result: contactResult.trim(),
                            summary: contactNotes.trim() || undefined,
                          });
                          // Reset form
                          setContactMethod("");
                          setContactTime(new Date().toISOString().slice(0, 16));
                          setContactResult("");
                          setContactNotes("");
                          setContactFormOpen(false);
                        } finally {
                          setContactSubmitting(false);
                        }
                      };

                      const handleSetQuality = async (q: "good" | "normal" | "poor", poorReason?: string) => {
                        setQualitySetting(q);
                        try {
                          const body: Record<string, unknown> = { quality: q };
                          if (q === "poor") body.poor_reason = poorReason ?? "";
                          const res = await fetch(`/api/leads/${lead.id}/quality`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(body),
                          });
                          if (!res.ok) {
                            const err = await res.json().catch(() => ({}));
                            alert((err as any)?.error || "Failed to set quality");
                          } else {
                            window.location.reload();
                          }
                        } catch {
                          // reload on any error to stay consistent with LeadContactQualityPanel
                        } finally {
                          setQualitySetting(null);
                        }
                      };

                      const canSubmit = contactMethod !== "" && contactTime !== "" && contactResult.trim() !== "" && !contactSubmitting;

                      return (
                      <div className="mt-2 space-y-2 border-t border-border/50 pt-2">
                        {/* ── Status indicators ── */}
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-1.5 text-[10px]">
                            <span className={contactsMet ? "text-emerald-400" : "text-amber-400"}>
                              {contactsMet ? "✓" : "○"} {contactTimeCount}/{contactsNeeded} {t("leadDetail.contactsWithTime") || "contact required"} · {contactTimeCount}/{coachingTarget} {t("leadDetail.contactCoachingTarget") || "coaching target"}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5 text-[10px]">
                            <span className={qAssessed ? "text-emerald-400" : "text-amber-400"}>
                              {qAssessed ? "✓" : "○"} {t("leadDetail.qualityAssessed") || "Quality assessed"}
                            </span>
                          </div>
                        </div>

                        {/* ── Add Structured Contact Record ── */}
                        {!contactFormOpen ? (
                          <button
                            onClick={() => setContactFormOpen(true)}
                            className="flex items-center gap-1.5 text-[10px] text-copper-400 hover:text-copper-300 transition-colors w-full py-1"
                          >
                            <Plus className="h-3 w-3" />
                            {t("leadDetail.addContactRecord") || "+ Add Contact Record"}
                          </button>
                        ) : (
                          <div className="space-y-2 p-2 rounded border border-copper-500/20 bg-copper-500/5">
                            {/* Contact Method */}
                            <div>
                              <label className="text-[10px] text-muted-foreground block mb-0.5">
                                {t("leadDetail.contactMethod") || "Contact Method"} *
                              </label>
                              <select
                                value={contactMethod}
                                onChange={(e) => setContactMethod(e.target.value)}
                                disabled={contactSubmitting}
                                className="w-full h-7 text-[11px] bg-muted border border-border rounded px-2 text-foreground"
                              >
                                <option value="">{t("leadDetail.selectContactMethod") || "-- Select --"}</option>
                                <option value="whatsapp">WhatsApp</option>
                                <option value="phone">{t("leadDetail.contactMethodPhone") || "Phone"}</option>
                                <option value="other">{t("common.other") || "Other"}</option>
                              </select>
                            </div>

                            {/* Contact Time */}
                            <div>
                              <label className="text-[10px] text-muted-foreground block mb-0.5">
                                {t("leadDetail.contactTime") || "Contact Time"} *
                              </label>
                              <input
                                type="datetime-local"
                                value={contactTime}
                                onChange={(e) => setContactTime(e.target.value)}
                                disabled={contactSubmitting}
                                className="w-full h-7 text-[11px] bg-muted border border-border rounded px-2 text-foreground"
                              />
                            </div>

                            {/* Contact Result */}
                            <div>
                              <label className="text-[10px] text-muted-foreground block mb-0.5">
                                {t("leadDetail.contactResult") || "Contact Result"} *
                              </label>
                              <input
                                type="text"
                                value={contactResult}
                                onChange={(e) => setContactResult(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" && canSubmit) handleAddStructuredContact();
                                }}
                                placeholder={t("leadDetail.contactResultPlaceholder") || "e.g. Interested, No answer..."}
                                disabled={contactSubmitting}
                                className="w-full h-7 text-[11px] bg-muted border border-border rounded px-2 text-foreground placeholder:text-muted-foreground/50"
                              />
                            </div>

                            {/* Summary / Notes (optional) */}
                            <div>
                              <label className="text-[10px] text-muted-foreground block mb-0.5">
                                {t("leadDetail.contactNotes") || "Notes"}
                              </label>
                              <input
                                type="text"
                                value={contactNotes}
                                onChange={(e) => setContactNotes(e.target.value)}
                                placeholder={t("leadDetail.contactNotesPlaceholder") || "Optional notes..."}
                                disabled={contactSubmitting}
                                className="w-full h-7 text-[11px] bg-muted border border-border rounded px-2 text-foreground placeholder:text-muted-foreground/50"
                              />
                            </div>

                            {/* Submit / Cancel row */}
                            <div className="flex gap-1.5 flex-wrap">
                              <button
                                onClick={handleAddStructuredContact}
                                disabled={!canSubmit}
                                className={cn(
                                  "text-[10px] px-2 py-1 rounded border transition-colors flex items-center gap-1",
                                  canSubmit
                                    ? "border-copper-500/30 text-copper-400 hover:bg-copper-500/10"
                                    : "border-border text-muted-foreground/30 cursor-not-allowed"
                                )}
                              >
                                <Send className="h-3 w-3" />
                                {contactSubmitting ? "..." : t("common.save") || "Save"}
                              </button>
                              <button
                                onClick={() => setContactFormOpen(false)}
                                disabled={contactSubmitting}
                                className="text-[10px] px-2 py-1 rounded border border-border text-muted-foreground hover:border-gray-500"
                              >
                                {t("common.cancel") || "Cancel"}
                              </button>
                            </div>
                          </div>
                        )}

                        {/* ── Quality selector ── */}
                        <div className="space-y-1">
                          <p className="text-[10px] text-muted-foreground">
                            {t("leadDetail.setContactQuality") || "Set Contact Quality"}
                            {!contactsMet && (
                              <span className="text-amber-400 ml-1">
                                ({t("leadDetail.needMoreContacts") || `need ${contactsNeeded - contactTimeCount} more contacts`})
                              </span>
                            )}
                          </p>
                          {showQualityPoorReason ? (
                            <div className="space-y-1.5">
                              <input
                                autoFocus
                                type="text"
                                value={qualityPoorReason}
                                onChange={(e) => setQualityPoorReason(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Escape") { setShowQualityPoorReason(false); setQualityPoorReason(""); }
                                }}
                                placeholder={t("leadDetail.poorReasonPlaceholder") || "Enter reason for Poor (min 3 chars)"}
                                className="w-full h-7 text-[11px] bg-muted border border-border rounded px-2 text-foreground"
                              />
                              <div className="flex gap-1.5">
                                <button
                                  disabled={qualityPoorReason.trim().length < 3 || qualitySetting === "poor"}
                                  onClick={() => handleSetQuality("poor", qualityPoorReason.trim())}
                                  className="text-[10px] px-2 py-1 rounded border border-rose-500/30 text-rose-400 hover:bg-rose-500/10 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                  {qualitySetting === "poor" ? "..." : t("leadDetail.confirmPoor") || "Confirm Poor"}
                                </button>
                                <button
                                  onClick={() => { setShowQualityPoorReason(false); setQualityPoorReason(""); }}
                                  className="text-[10px] px-2 py-1 rounded border border-border text-muted-foreground hover:border-gray-500"
                                >
                                  {t("common.cancel") || "Cancel"}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex gap-1.5 flex-wrap">
                              <button
                                disabled={!contactsMet || qualitySetting !== null}
                                onClick={() => handleSetQuality("good")}
                                className={cn(
                                  "text-[10px] px-2 py-1 rounded border transition-colors flex items-center gap-1",
                                  contactsMet && qualitySetting === null
                                    ? "border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"
                                    : "border-border text-muted-foreground/30 cursor-not-allowed"
                                )}
                              >
                                <ThumbsUp className="h-3 w-3" />
                                {t("leadDetail.qualityGood") || "Good"}
                              </button>
                              <button
                                disabled={!contactsMet || qualitySetting !== null}
                                onClick={() => handleSetQuality("normal")}
                                className={cn(
                                  "text-[10px] px-2 py-1 rounded border transition-colors flex items-center gap-1",
                                  contactsMet && qualitySetting === null
                                    ? "border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
                                    : "border-border text-muted-foreground/30 cursor-not-allowed"
                                )}
                              >
                                <Minus className="h-3 w-3" />
                                {t("leadDetail.qualityNormal") || "Normal"}
                              </button>
                              <button
                                disabled={!contactsMet || qualitySetting !== null}
                                onClick={() => setShowQualityPoorReason(true)}
                                className={cn(
                                  "text-[10px] px-2 py-1 rounded border transition-colors flex items-center gap-1",
                                  contactsMet && qualitySetting === null
                                    ? "border-rose-500/30 text-rose-400 hover:bg-rose-500/10"
                                    : "border-border text-muted-foreground/30 cursor-not-allowed"
                                )}
                              >
                                <ThumbsDown className="h-3 w-3" />
                                {t("leadDetail.qualityPoor") || "Poor"}
                              </button>
                            </div>
                          )}
                        </div>

                        {/* ── Recent contacts list ── */}
                        {recentContacts.length > 0 && (
                          <div className="space-y-0.5">
                            <p className="text-[10px] text-muted-foreground">
                              {t("leadDetail.recentContacts") || "Recent Contacts"}
                            </p>
                            <ul className="space-y-0.5">
                              {recentContacts.map((log) => (
                                <li key={log.id} className="flex items-start gap-1.5 text-[10px]">
                                  <span className="mt-0.5 text-muted-foreground">
                                    {contactTypeIcon(log.contact_type)}
                                  </span>
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate text-foreground/80">
                                      {log.contact_result || log.summary || "(no summary)"}
                                    </div>
                                    <div className="text-[9px] text-muted-foreground">
                                      {fmtDubai(log.contact_time || log.created_at)}
                                    </div>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                      );
                    })()}
                  </div>
                  <span className="text-xs text-muted-foreground">{idx + 1}/7</span>
                </div>
              );
            })}
            {milestones.length === 0 && (
              <p className="text-gray-600 text-sm text-center py-4">
                {t("leadDetail.noMilestones")}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Next Required Action */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-muted-foreground flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <Calendar className="w-4 h-4" /> {t("leadDetail.nextRequiredAction")}
            </span>
            {nextTaskOverdue && (
              <Badge className="bg-red-500/10 text-red-400 text-[10px]">{t("leadDetail.overdue")}</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-3 text-sm">
            <div>
              <Label className="text-muted-foreground text-xs">{t("leadDetail.nextFollowUp")}</Label>
              {renderNextFollowupDate()}
            </div>
            <div>
              <Label className="text-muted-foreground text-xs">{t("leadDetail.nextAction")}</Label>
              {renderNextAction()}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Missing Required Fields (gated by stage) */}
      {missingFields.length > 0 && (
        <Card className="bg-card border-rose-500/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-rose-400 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> {t("leadDetail.missingRequiredFields")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-[11px] text-muted-foreground">{t("leadDetail.missingFieldsHint")}</p>
            {missingFields.map((f) => (
              <div key={f.key} className="flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 text-rose-400 mt-1 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-rose-400 text-xs">{f.label}</p>
                  {f.kind === "contract" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-1 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 h-7 text-xs"
                      onClick={onCreateContract}
                    >
                      <FileText className="w-3.5 h-3.5 mr-1" />{t("leadDetail.createContract")}
                    </Button>
                  ) : f.kind === "json" ? (
                    renderJsonEdit(f.key, f.label)
                  ) : (
                    renderInlineEdit(f.key, f.label)
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Stage Progress */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-muted-foreground flex items-center gap-2 flex-wrap">
            <Target className="w-4 h-4" /> {t("leadDetail.stageProgress")}
            <Badge className={cn("text-xs", STAGE_COLORS[lead.stage] || "")}>
              {t(`stageLabels.${lead.stage}`) || lead.stage}
            </Badge>
            <Badge className={cn("text-xs", healthColor)} title={t("leadDetail.healthScore")}>
              <ShieldAlert className="w-3 h-3 mr-1" />
              {healthLevelLabel} · {health.score}
            </Badge>
            {lead.quotation_value != null && lead.quotation_value > 0 && (
              <Badge className="bg-copper-500/10 text-copper-400 text-xs">
                <DollarSign className="w-3 h-3 mr-1" />
                {fmtAED(lead.quotation_value)}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <p className="text-xs text-muted-foreground mb-1.5">{t("leadDetail.updateStage")}</p>
            <div className="flex flex-wrap gap-1">
              {(() => {
                const stageKeys: string[] = PIPELINE_STAGES.map(s => s.key);
                const curIdx = stageKeys.indexOf(lead.stage ?? 'new');
                return STAGES.filter((s) => s !== "won" && s !== "lost").map((s) => {
                  const sIdx = stageKeys.indexOf(s);
                  const isBeyondNext = curIdx >= 0 && sIdx > curIdx + 1;
                  // Hard gate: one complete contact + assessed quality before leaving New.
                  const gate = evaluateFirstContactGate({
                    currentStage: lead.stage,
                    nextStage: s,
                    contactCount: completeContactCount,
                    quality: lead.quality,
                  });
                  const gateDisabled = !gate.allowed;
                  const gateTitle = gateDisabled ? gate.reasons.join("; ") : undefined;
                  return (
                    <button
                      key={s}
                      disabled={isBeyondNext || gateDisabled}
                      title={gateTitle}
                      className={cn(
                        "text-[10px] px-2 py-1 rounded border transition-colors",
                        lead.stage === s
                          ? "border-transparent text-foreground"
                          : isBeyondNext || gateDisabled
                            ? "border-border text-muted-foreground/30 cursor-not-allowed"
                            : "border-border text-muted-foreground hover:border-gray-500"
                      )}
                      style={
                        lead.stage === s
                          ? { backgroundColor: STAGE_COLORS[s]?.split(" ")[0]?.replace("/10", "/30") || "#6b7280" }
                          : {}
                      }
                      onClick={() => {
                        onStageChange(s);
                      }}
                    >
                      {t(`stageLabels.${s}`)}
                    </button>
                  );
                });
              })()}
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="flex-1 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"
              onClick={onWon}
              disabled={updating || !firstContactGate.allowed}
              title={!firstContactGate.allowed ? firstContactGate.reasons.join("; ") : undefined}
            >
              <CheckCircle className="w-4 h-4 mr-1" />{t("stageLabels.won")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="flex-1 border-red-500/30 text-red-400 hover:bg-red-500/10"
              onClick={onLost}
              disabled={updating || !firstContactGate.allowed}
              title={!firstContactGate.allowed ? firstContactGate.reasons.join("; ") : undefined}
            >
              <AlertTriangle className="w-4 h-4 mr-1" />{t("stageLabels.lost")}
            </Button>
          </div>
          <Separator className="bg-border" />
          <Button
            variant="outline"
            size="sm"
            className="w-full border-copper-500/30 text-copper-400 justify-start"
            onClick={onOpenQuoteCalculator}
          >
            <Plus className="w-4 h-4 mr-2" />{t("leadDetail.createQuote")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full border-purple-500/30 text-purple-400 hover:bg-purple-500/10 justify-start"
            onClick={onGenerateKnx}
          >
            <WandSparkles className="w-4 h-4 mr-2" />{t("leadDetail.generateKnxPlan")}
          </Button>
        </CardContent>
      </Card>

      {/* Quote / Contract / Payment links */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-muted-foreground">{t("leadDetail.traceLinks")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {/* Quote link */}
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-muted-foreground text-xs">{t("leadDetail.quoteLink")}</p>
              <p className="text-foreground">
                {lead.quotation_value != null && lead.quotation_value > 0 ? fmtAED(lead.quotation_value) : "—"}
              </p>
            </div>
            {hasQuotation ? (
              <Badge className="bg-blue-500/10 text-blue-400 text-[10px]">{t("leadDetail.quotationLabel")}</Badge>
            ) : (
              <Button size="sm" variant="outline" className="border-copper-500/30 text-copper-400 h-7 text-xs" onClick={onOpenQuoteCalculator}>
                <Plus className="w-3.5 h-3.5 mr-1" />{t("leadDetail.createQuote")}
              </Button>
            )}
          </div>

          {/* Contract link — only when won */}
          {lead.final_status === "won" && (
            <>
              <Separator className="bg-border" />
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-muted-foreground text-xs">{t("leadDetail.contractLink")}</p>
                  {hasContract ? (
                    <p className="text-foreground truncate">
                      {trace?.contract_no || t("leadDetail.contractLabel")} · {fmtAED(trace?.contract_amount ?? null)}
                    </p>
                  ) : (
                    <p className="text-gray-600 text-xs">{t("leadDetail.contractNotCreated")}</p>
                  )}
                </div>
                {!hasContract && (
                  <Button size="sm" variant="outline" className="border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 h-7 text-xs" onClick={onCreateContract}>
                    <FileText className="w-3.5 h-3.5 mr-1" />{t("leadDetail.createContract")}
                  </Button>
                )}
              </div>
            </>
          )}

          {/* Payment link — only when a payment exists in the trace */}
          {hasPayment && (
            <>
              <Separator className="bg-border" />
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-muted-foreground text-xs">{t("leadDetail.paymentLink")}</p>
                  <p className="text-foreground">
                    {fmtAED(trace?.payment_amount ?? null)}
                    {trace?.payment_date ? ` · ${fmtDubai(trace.payment_date)}` : ""}
                  </p>
                </div>
                <Badge className={cn("text-[10px]", trace?.confirmed ? "bg-emerald-500/10 text-emerald-400" : "bg-amber-500/10 text-amber-400")}>
                  {trace?.confirmed ? t("leadDetail.confirmed") : t("leadDetail.pendingConfirm")}
                </Badge>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
