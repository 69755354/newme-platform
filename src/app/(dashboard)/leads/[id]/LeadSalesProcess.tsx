"use client";

// Middle column — Sales Process. Drives the deal forward:
// milestone checklist → next required action → missing required fields (gated by
// stage) → stage progress / Won-Lost → quote / contract / payment links.
//
// All mutations call back into page.tsx handlers (onUpdateField, onStageChange,
// onToggleMilestone, …). Inline edits reuse the page-owned render closures so the
// single-edit-at-a-time behaviour is preserved across columns.

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { cn, fmtDubai } from "@/lib/utils";
import { dubaiInputToIso, dubaiInputValue } from "@/lib/dubai-time.mjs";
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
import { evaluateFirstContactGate, isAssessedQuality } from "@/lib/first-contact-gate.mjs";
import { STAGES, STAGE_COLORS } from "./types";
import { fmtAED, daysSince } from "./utils";
import type {
  Lead,
  LeadField,
  LeadFieldUpdater,
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
  onToggleMilestone: (milestoneKey: string, currentlyCompleted: boolean, notes?: string) => Promise<boolean>;
  onReopenMilestone: (milestoneKey: string, reason: string) => Promise<boolean>;
  onUpdateField: LeadFieldUpdater;
  onWon: (note?: string, amount?: string) => Promise<boolean>;
  onLost: (note?: string) => Promise<boolean>;
  onOpenQuoteCalculator: () => void;
  /** "Only the amount" quotation, available at any time. */
  onOpenQuickQuote: () => void;
  onCreateContract: () => void;
  /** /contracts/new admits admin and boss only; others get no button that bounces. */
  canCreateContract?: boolean;
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
  }) => Promise<{ success: boolean; error?: string }>;
  t: (key: string) => string;
  lang: "en" | "zh";
}

type MissingField =
  | { key: LeadField; label: string; kind: "text" | "json" }
  | { key: "contract"; label: string; kind: "contract" };

export default function LeadSalesProcess({
  lead,
  leadTrace,
  followUpLogs,
  milestones,
  nextTask,
  updating,
  onToggleMilestone,
  onReopenMilestone,
  onUpdateField,
  onWon,
  onLost,
  onOpenQuoteCalculator,
  onOpenQuickQuote,
  onCreateContract,
  canCreateContract = false,
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
  // S35 F05: the field is Dubai time (never the UTC clock, never the browser zone).
  const [contactTime, setContactTime] = useState(() => dubaiInputValue());
  const [contactResult, setContactResult] = useState("");
  const [contactNotes, setContactNotes] = useState("");
  const [contactFormOpen, setContactFormOpen] = useState(false);
  const [contactSubmitting, setContactSubmitting] = useState(false);
  const [contactSaveError, setContactSaveError] = useState<string | null>(null);
  const [showQualityPoorReason, setShowQualityPoorReason] = useState(false);
  const [qualityPoorReason, setQualityPoorReason] = useState("");
  const [qualitySetting, setQualitySetting] = useState<string | null>(null);
  const [qualitySaveError, setQualitySaveError] = useState<string | null>(null);
  const [stageNote, setStageNote] = useState("");
  const [wonAmount, setWonAmount] = useState("");
  const [milestoneNoteError, setMilestoneNoteError] = useState<string | null>(null);
  const [firstContactBlockReason, setFirstContactBlockReason] = useState<string | null>(null);
  const [reopenMilestoneKey, setReopenMilestoneKey] = useState<string | null>(null);
  const [reopenReason, setReopenReason] = useState("");
  const [reopenError, setReopenError] = useState<string | null>(null);
  const [clockNow, setClockNow] = useState(0);

  useEffect(() => {
    const updateClock = () => setClockNow(Date.now());
    const initialTimer = window.setTimeout(updateClock, 0);
    const interval = window.setInterval(updateClock, 60_000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
    };
  }, []);

  // Latest trace row carries the quote / contract / payment state for the links.
  const trace = leadTrace[0];

  const nextTaskOverdue = clockNow > 0 && !!nextTask && new Date(nextTask.due_at).getTime() < clockNow;

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
    isOverdue: nextTaskOverdue,
  });
  // A won or lost lead is closed: the stage route refuses any further change
  // ("Terminal Lead stage cannot be changed"), so offering Won/Lost again was a
  // button that could only error (review 4c #13).
  const isClosed =
    lead.final_status === "won" ||
    lead.final_status === "lost" ||
    lead.stage === "won" ||
    lead.stage === "lost";
  const closedAsWon = lead.final_status === "won" || lead.stage === "won";
  const healthLevelLabel =
    health.level === "healthy"
      ? t("leadDetail.health_healthy")
      : health.level === "at_risk"
      ? t("leadDetail.health_at_risk")
      : t("leadDetail.health_stale");
  const healthColor =
    health.score >= 50
      ? "bg-emerald-500/10 text-emerald-700"
      : health.score >= 20
      ? "bg-amber-500/10 text-amber-700"
      : "bg-red-500/10 text-red-700";

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
      { key: "quotation_value", label: t("leadDetail.quotationValue"), kind: "text" },
    ];
    // stage threshold at which each candidate becomes required (cumulative)
    const thresholds: Record<string, number> = {
      customer_name: reqIdx("new"),
      phone: reqIdx("contacted"),
      project_type: reqIdx("requirement_confirmed"),
      project_status: reqIdx("requirement_confirmed"),
      location: reqIdx("requirement_confirmed"),
      quotation_value: reqIdx("quotation_submitted"),
    };
    const filled: Record<string, boolean> = {
      customer_name: !!lead.customer_name,
      phone: !!lead.phone,
      project_type: !!lead.project_type,
      project_status: !!lead.project_status,
      location: !!lead.location,
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
  const historicalFirstContact = milestones.some(
    (milestone) => milestone.completed && milestone.milestone_key === "first_contact",
  ) && (
    lead.stage !== "new"
    || milestones.some(
      (milestone) => milestone.completed && milestone.milestone_key !== "first_contact",
    )
  );
  const firstContactReady = milestones.some(
    (milestone) => milestone.completed
      && milestone.milestone_key === "first_contact"
      && !!milestone.notes?.trim(),
  ) || historicalFirstContact;
  const completedKeys = milestones
    .filter((m) => m.completed && (m.milestone_key !== "first_contact" || firstContactReady))
    .map((m) => m.milestone_key);
  const nextPendingKey = COMPLETABLE_MILESTONES.find((k) => !completedKeys.includes(k));
  // S39: steps may be skipped going forward. Nothing is locked once First Contact is done, except what lies behind the
  // furthest completed step (that can only be re-opened, never completed late).
  const furthestDone = Math.max(-1, ...completedKeys.map((k) => COMPLETABLE_MILESTONES.indexOf(k)));
  const isLocked = (key: string): boolean => {
    if (completedKeys.includes(key)) return false;
    if (furthestDone >= 0 && COMPLETABLE_MILESTONES.indexOf(key) < furthestDone) return true;
    if (key === nextPendingKey) return false;
    return furthestDone < 0;
  };

  const hasContract = !!trace?.contract_id;
  const hasPayment = !!trace?.payment_id;
  const hasQuotation = !!trace?.quotation_id || !!(lead.quotation_value && lead.quotation_value > 0);

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border/80 bg-card/40 p-3 shadow-sm">
      {/* AI Summary */}
      {lead.ai_summary && (
        <Card className="order-5 border-border bg-muted/20 shadow-none">
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
      <Card className="order-2 overflow-hidden border-copper-500/30 bg-card shadow-none">
        <CardHeader className="border-b border-border/70 pb-3">
          <CardTitle className="text-base text-foreground flex items-center justify-between gap-3">
            <span className="flex items-center gap-2"><Target className="w-4 h-4 text-copper-700" /> {lang === "zh" ? "当前成交阶段" : "Current deal stage"}</span>
            <span className="text-xs font-normal text-muted-foreground">{completedKeys.length}/7</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {COMPLETABLE_MILESTONES.map((key, idx) => {
              const completed = completedKeys.includes(key);
              const milestone = milestones.find((item) => item.milestone_key === key);
              const locked = isLocked(key);
              const isNext = key === nextPendingKey;
              const previousMilestoneKey = idx > 0 ? COMPLETABLE_MILESTONES[idx - 1] : null;
              return (
                <div
                  key={key}
                  className={cn(
                    "flex items-start gap-3 rounded-lg border px-4 py-3 transition-colors",
                    locked ? "opacity-40" : "",
                    isNext && !completed ? "border-copper-500/40 bg-copper-500/5" : "border-transparent bg-muted/20"
                  )}
                >
                  <span
                    className={cn(
                      "mt-0.5 w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0",
                      completed
                        ? "bg-emerald-500 border-emerald-500 text-white"
                        : locked
                        ? "border-muted-foreground/30 bg-transparent"
                        : "border-copper-500 bg-transparent"
                    )}
                  >
                    {completed && <CheckCircle className="w-3.5 h-3.5" />}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className={cn("text-sm font-medium", completed ? "text-foreground line-through opacity-60" : "text-foreground")}>
                      {t(`leadDetail.milestone_${key}`)}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {t(`leadDetail.milestone_desc_${key}`)}
                    </p>
                    {completed && milestone && (
                      <div className="mt-2 space-y-1.5 rounded-md border border-emerald-500/20 bg-emerald-500/5 p-2">
                        <p className="text-xs text-emerald-700">{t("leadDetail.milestoneCompleted")}</p>
                        <p className="whitespace-pre-wrap break-words text-xs text-foreground">
                          {milestone.notes?.trim() || "—"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {milestone.completed_at ? fmtDubai(milestone.completed_at, { locale: t("locale.dateLocale") }) : "—"}
                          {milestone.completer?.full_name ? ` · ${milestone.completer.full_name}` : ""}
                        </p>
                        {reopenMilestoneKey === key ? (
                          <div className="space-y-1.5 pt-1">
                            <Label htmlFor={`reopen-reason-${key}`} className="text-xs text-foreground">
                              {lang === "zh" ? "重开原因（必填）" : "Reopen reason (required)"}
                            </Label>
                            <textarea
                              id={`reopen-reason-${key}`}
                              value={reopenReason}
                              onChange={(event) => {
                                setReopenReason(event.target.value);
                                setReopenError(null);
                              }}
                              placeholder={lang === "zh" ? "说明误操作或需要更新的内容" : "Explain the correction"}
                              className="min-h-16 w-full rounded border border-border bg-muted px-2 py-1.5 text-xs text-foreground"
                            />
                            {reopenError && <p role="alert" className="text-xs text-rose-700">{reopenError}</p>}
                            <div className="flex gap-1.5">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={updating}
                                onClick={async () => {
                                  const reason = reopenReason.trim();
                                  if (!reason) {
                                    setReopenError(lang === "zh" ? "请填写重开原因" : "Reopen reason is required");
                                    return;
                                  }
                                  const reopened = await onReopenMilestone(key, reason);
                                  if (reopened) {
                                    setReopenMilestoneKey(null);
                                    setReopenReason("");
                                  }
                                }}
                                className="h-7 border-amber-500/30 text-xs text-amber-700"
                              >
                                {lang === "zh" ? "确认重开" : "Confirm reopen"}
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={updating}
                                onClick={() => {
                                  setReopenMilestoneKey(null);
                                  setReopenReason("");
                                  setReopenError(null);
                                }}
                                className="h-7 text-xs"
                              >
                                {t("common.cancel") || "Cancel"}
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setReopenMilestoneKey(key);
                              setReopenReason("");
                              setReopenError(null);
                            }}
                            className="text-xs text-amber-700 hover:text-amber-700"
                          >
                            {lang === "zh" ? "重开此阶段" : "Reopen milestone"}
                          </button>
                        )}
                      </div>
                    )}
                    {isNext && !completed && <p className="text-xs text-copper-700">{t("leadDetail.milestoneNext")}</p>}
                    {locked && (
                      <p className="text-xs text-muted-foreground">
                        {previousMilestoneKey
                          ? lang === "zh"
                            ? `请先完成「${t(`leadDetail.milestone_${previousMilestoneKey}`)}」后解锁`
                            : `Complete ${t(`leadDetail.milestone_${previousMilestoneKey}`)} to unlock`
                          : t("leadDetail.milestoneLocked")}
                      </p>
                    )}
                    {/* first_contact inline workspace */}
                    {key === "first_contact" && (isNext || completed) && (() => {
                      const contactTimeCount = followUpLogs.filter(l => l.contact_time != null && !!l.contact_result?.trim()).length;
                      const qAssessed = isAssessedQuality(lead.quality);
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
                        if (!contactMethod || !contactTime) return;
                        setContactSaveError(null);
                        setContactSubmitting(true);
                        try {
                          const contactTimeIso = dubaiInputToIso(contactTime);
                          if (!contactTimeIso) {
                            setContactSaveError(t("leadDetail.contactTimeInvalid"));
                            return;
                          }
                          const result = await onAddStructuredContact({
                            contact_method: contactMethod,
                            contact_time: contactTimeIso,
                            contact_result: contactResult.trim() || (lang === "zh" ? "已联系" : "Contacted"),
                            summary: contactNotes.trim() || undefined,
                          });
                          if (!result.success) {
                            // The hook already showed the one failure toast; keep the form as it is.
                            if (result.error) setContactSaveError(result.error);
                            return;
                          }
                          // Reset form
                          setContactMethod("");
                          setContactTime(dubaiInputValue());
                          setContactResult("");
                          setContactNotes("");
                          setContactFormOpen(false);
                        } finally {
                          setContactSubmitting(false);
                        }
                      };

                      const handleSetQuality = async (q: "good" | "normal" | "poor", poorReason?: string) => {
                        setQualitySetting(q);
                        setQualitySaveError(null);
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
                            setQualitySaveError((err as any)?.error || (lang === "zh" ? "保存线索质量失败" : "Failed to set lead quality"));
                          } else {
                            window.location.reload();
                          }
                        } catch {
                          setQualitySaveError(lang === "zh" ? "网络异常，未保存线索质量" : "Network error: lead quality was not saved");
                        } finally {
                          setQualitySetting(null);
                        }
                      };

                      const canSubmit = contactMethod !== "" && contactTime !== "" && !contactSubmitting;

                      return (
                      <div className="mt-2 space-y-2 border-t border-border/50 pt-2">
                        {/* ── Status indicators ── */}
                        <div className="space-y-1 text-xs">
                          <p className={contactsMet ? "text-emerald-700" : "text-foreground"}>
                            {lang === "zh" ? "联系记录" : "Contact record"} {contactsMet ? "✓" : `${contactTimeCount}/${contactsNeeded}`}
                          </p>
                          <p className={qAssessed ? "text-emerald-700" : "text-foreground"}>
                            {lang === "zh" ? "线索质量" : "Lead quality"}{" "}
                            {qAssessed
                              ? lead.quality === "good"
                                ? lang === "zh" ? "优质" : "Good"
                                : lead.quality === "normal"
                                ? lang === "zh" ? "一般" : "Normal"
                                : lang === "zh" ? "差" : "Poor"
                              : lang === "zh" ? "未评估" : "Not assessed"}
                          </p>
                          <p className="text-muted-foreground">
                            {lang === "zh" ? "建议跟进" : "Recommended follow-ups"} {contactTimeCount}/{coachingTarget}
                          </p>
                          {!contactsMet && (
                            <p className="text-amber-700">
                              {lang === "zh" ? "添加1条联系记录后可评估" : "Add 1 contact record to assess quality"}
                            </p>
                          )}
                        </div>

                        {/* ── Add Structured Contact Record ── */}
                        {!contactFormOpen ? (
                          <button
                            onClick={() => { setContactTime(dubaiInputValue()); setContactFormOpen(true); }}
                            className="flex items-center gap-1.5 text-xs text-copper-700 hover:text-copper-700 transition-colors w-full py-1"
                          >
                            <Plus className="h-3 w-3" />
                            {t("leadDetail.addContactRecord") || "+ Add Contact Record"}
                          </button>
                        ) : (
                          <div className="space-y-2 p-2 rounded border border-copper-500/20 bg-copper-500/5">
                            {/* Contact Method */}
                            <div>
                              <label className="text-xs text-muted-foreground block mb-0.5">
                                {t("leadDetail.contactMethod") || "Contact Method"} *
                              </label>
                              <select
                                value={contactMethod}
                                onChange={(e) => setContactMethod(e.target.value)}
                                disabled={contactSubmitting}
                                className="w-full h-7 text-xs bg-muted border border-border rounded px-2 text-foreground"
                              >
                                <option value="">{t("leadDetail.selectContactMethod") || "-- Select --"}</option>
                                <option value="whatsapp">WhatsApp</option>
                                <option value="phone">{t("leadDetail.contactMethodPhone") || "Phone"}</option>
                                <option value="other">{t("common.other") || "Other"}</option>
                              </select>
                            </div>

                            {/* Contact Time */}
                            <div>
                              <label className="text-xs text-muted-foreground block mb-0.5">
                                {t("leadDetail.contactTime") || "Contact Time"} *
                              </label>
                              <input
                                type="datetime-local"
                                value={contactTime}
                                max={dubaiInputValue()}
                                onChange={(e) => setContactTime(e.target.value)}
                                disabled={contactSubmitting}
                                className="w-full h-7 text-xs bg-muted border border-border rounded px-2 text-foreground"
                              />
                            </div>

                            {/* Contact Result */}
                            <div>
                              <label className="text-xs text-muted-foreground block mb-0.5">
                                {t("leadDetail.contactResult") || "Contact Result"}
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
                                className="w-full h-7 text-xs bg-muted border border-border rounded px-2 text-foreground placeholder:text-muted-foreground/50"
                              />
                            </div>

                            {/* Summary / Notes (optional) */}
                            <div>
                              <label className="text-xs text-muted-foreground block mb-0.5">
                                {t("leadDetail.contactNotes") || "Notes"}
                              </label>
                              <input
                                type="text"
                                value={contactNotes}
                                onChange={(e) => setContactNotes(e.target.value)}
                                placeholder={t("leadDetail.contactNotesPlaceholder") || "Optional notes..."}
                                disabled={contactSubmitting}
                                className="w-full h-7 text-xs bg-muted border border-border rounded px-2 text-foreground placeholder:text-muted-foreground/50"
                              />
                            </div>

                            {contactSaveError && (
                              <p className="col-span-2 text-xs text-red-500">{contactSaveError}</p>
                            )}

                            {/* Submit / Cancel row */}
                            <div className="flex gap-1.5 flex-wrap">
                              <button
                                onClick={handleAddStructuredContact}
                                disabled={!canSubmit}
                                className={cn(
                                  "text-xs px-2 py-1 rounded border transition-colors flex items-center gap-1",
                                  canSubmit
                                    ? "border-copper-500/30 text-copper-700 hover:bg-copper-500/10"
                                    : "border-border text-muted-foreground/30 cursor-not-allowed"
                                )}
                              >
                                <Send className="h-3 w-3" />
                                {contactSubmitting ? "..." : t("common.save") || "Save"}
                              </button>
                              <button
                                onClick={() => setContactFormOpen(false)}
                                disabled={contactSubmitting}
                                className="text-xs px-2 py-1 rounded border border-border text-muted-foreground hover:border-gray-500"
                              >
                                {t("common.cancel") || "Cancel"}
                              </button>
                            </div>
                          </div>
                        )}

                        {/* ── Quality selector ── */}
                        <div className="space-y-1">
                          <p className="text-xs text-muted-foreground">
                            {t("leadDetail.setContactQuality") || "Set Contact Quality"}
                            {!contactsMet && (
                              <span className="text-amber-700 ml-1">
                                ({(t("leadDetail.needMoreContacts") || `need ${contactsNeeded - contactTimeCount} more contacts`).replace("{n}", String(contactsNeeded - contactTimeCount))})
                              </span>
                            )}
                          </p>
                          {qualitySaveError && (
                            <p role="alert" className="text-xs text-red-700">{qualitySaveError}</p>
                          )}
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
                                className="w-full h-7 text-xs bg-muted border border-border rounded px-2 text-foreground"
                              />
                              <div className="flex gap-1.5">
                                <button
                                  disabled={qualityPoorReason.trim().length < 3 || qualitySetting === "poor"}
                                  onClick={() => handleSetQuality("poor", qualityPoorReason.trim())}
                                  className="text-xs px-2 py-1 rounded border border-rose-500/30 text-rose-700 hover:bg-rose-500/10 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                  {qualitySetting === "poor" ? "..." : t("leadDetail.confirmPoor") || "Confirm Poor"}
                                </button>
                                <button
                                  onClick={() => { setShowQualityPoorReason(false); setQualityPoorReason(""); }}
                                  className="text-xs px-2 py-1 rounded border border-border text-muted-foreground hover:border-gray-500"
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
                                  "text-xs px-2 py-1 rounded border transition-colors flex items-center gap-1",
                                  contactsMet && qualitySetting === null
                                    ? "border-emerald-500/30 text-emerald-700 hover:bg-emerald-500/10"
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
                                  "text-xs px-2 py-1 rounded border transition-colors flex items-center gap-1",
                                  contactsMet && qualitySetting === null
                                    ? "border-amber-500/30 text-amber-700 hover:bg-amber-500/10"
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
                                  "text-xs px-2 py-1 rounded border transition-colors flex items-center gap-1",
                                  contactsMet && qualitySetting === null
                                    ? "border-rose-500/30 text-rose-700 hover:bg-rose-500/10"
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
                            <p className="text-xs text-muted-foreground">
                              {t("leadDetail.recentContacts") || "Recent Contacts"}
                            </p>
                            <ul className="space-y-0.5">
                              {recentContacts.map((log) => (
                                <li key={log.id} className="flex items-start gap-1.5 text-xs">
                                  <span className="mt-0.5 text-muted-foreground">
                                    {contactTypeIcon(log.contact_type)}
                                  </span>
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate text-foreground/80">
                                      {log.contact_result || log.summary || "(no summary)"}
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                      {fmtDubai(log.contact_time || log.created_at, { locale: t("locale.dateLocale") })}
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
                    {!locked && !completed && (
                      <div className="mt-4 rounded-md border border-border bg-background/60 p-3 space-y-2">
                        <Label htmlFor={`milestone-note-${key}`} className="text-xs font-medium text-foreground">
                          {lang === "zh" ? "推进备注（选填）" : "Progress note (optional)"}
                        </Label>
                        <textarea
                          id={`milestone-note-${key}`}
                          value={stageNote}
                          onChange={(event) => {
                            setStageNote(event.target.value);
                            setMilestoneNoteError(null);
                          }}
                          placeholder={lang === "zh" ? "记录这一步实际完成了什么" : "Record what was actually completed"}
                          className="min-h-20 w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
                        />
                        {(milestoneNoteError || (key === "first_contact" && firstContactBlockReason)) && (
                          <p role="alert" className="text-xs text-amber-700">
                            {milestoneNoteError || firstContactBlockReason}
                          </p>
                        )}
                        <Button
                          type="button"
                          disabled={updating}
                          className="w-full bg-copper-500 text-black hover:bg-copper-400"
                          onClick={async () => {
                            const note = stageNote.trim();
                            if (key === "first_contact" && completeContactCount < 1) {
                              setFirstContactBlockReason(lang === "zh" ? "请先添加 1 条完整联系记录（方式、时间和结果）" : "Add one complete contact record first");
                              return;
                            }
                            setFirstContactBlockReason(null);
                            const completedNow = await onToggleMilestone(key, false, note);
                            if (completedNow) setStageNote("");
                          }}
                        >
                          {lang === "zh" ? "完成此阶段" : "Complete this stage"}
                        </Button>
                      </div>
                    )}
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
      <Card className="order-1 border-copper-500/35 bg-copper-500/[0.04] shadow-none">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-muted-foreground flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-foreground">
              <Calendar className="w-4 h-4 text-copper-700" /> {t("leadDetail.nextRequiredAction")}
            </span>
            {nextTaskOverdue && (
              <Badge className="bg-red-500/10 text-red-700 text-xs">{t("leadDetail.overdue")}</Badge>
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
      <Card className="order-3 border-rose-500/30 bg-rose-500/[0.03] shadow-none">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-rose-700 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> {t("leadDetail.missingRequiredFields")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-xs text-muted-foreground">{t("leadDetail.missingFieldsHint")}</p>
            {missingFields.map((f) => (
              <div key={f.key} className="flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 text-rose-700 mt-1 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-rose-700 text-xs">{f.label}</p>
                  {f.kind === "contract" ? (
                    canCreateContract ? <Button
                      size="sm"
                      variant="outline"
                      className="mt-1 border-emerald-500/30 text-emerald-700 hover:bg-emerald-500/10 h-7 text-xs"
                      onClick={onCreateContract}
                    >
                      <FileText className="w-3.5 h-3.5 mr-1" />{t("leadDetail.createContract")}
                    </Button> : null
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
      <Card className="order-4 border-border bg-muted/20 shadow-none">
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
              <Badge className="bg-copper-500/10 text-copper-700 text-xs">
                <DollarSign className="w-3 h-3 mr-1" />
                {fmtAED(lead.quotation_value)}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {isClosed ? (
            <p className="rounded-md border border-border/70 bg-background/50 px-3 py-2 text-xs text-muted-foreground">
              {closedAsWon
                ? t("leadDetail.leadClosedWon")
                : t("leadDetail.leadClosedLost")}
            </p>
          ) : (<>
          <div>
            <label htmlFor="stage-note" className="text-xs text-muted-foreground">
              {t("leadDetail.stageNoteRequired")}
            </label>
            <textarea
              id="stage-note"
              value={stageNote}
              maxLength={1000}
              onChange={(event) => setStageNote(event.target.value)}
              placeholder={lang === "zh" ? "记录本次阶段推进的原因或客户反馈" : "Reason, customer feedback, or next-step context"}
              className="mt-1 min-h-16 w-full resize-y rounded border border-border bg-muted px-2 py-1.5 text-xs text-foreground"
            />
            <p className="text-right text-xs text-muted-foreground">{stageNote.length}/1000</p>
          </div>
          {!(lead.quotation_value != null && lead.quotation_value > 0) && (
            <div>
              <label htmlFor="won-amount" className="text-xs text-muted-foreground">
                {lang === "zh" ? "成交金额 AED（点“赢单”时必填：还没有报价或合同）" : "Deal amount AED (required to mark Won: there is no quotation or contract yet)"}
              </label>
              <input
                id="won-amount"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={wonAmount}
                onChange={(event) => setWonAmount(event.target.value)}
                className="mt-1 h-8 w-full rounded border border-border bg-muted px-2 text-xs text-foreground"
              />
            </div>
          )}
          <p className="rounded-md border border-border/70 bg-background/50 px-3 py-2 text-xs text-muted-foreground">
            {lang === "zh" ? "阶段只能通过上方当前里程碑的真实推进备注完成；后续阶段会在满足顺序后解锁。" : "Complete the current milestone above with a real progress note. Future stages unlock in sequence."}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="flex-1 border-emerald-500/30 text-emerald-700 hover:bg-emerald-500/10"
              onClick={async () => {
                const changed = await onWon(stageNote, wonAmount);
                if (changed) { setStageNote(""); setWonAmount(""); }
              }}
              disabled={updating || !firstContactGate.allowed || !stageNote.trim() || (!(lead.quotation_value != null && lead.quotation_value > 0) && !(Number(wonAmount) > 0))}
              title={!firstContactGate.allowed ? firstContactGate.reasons.join("; ") : undefined}
            >
              <CheckCircle className="w-4 h-4 mr-1" />{t("stageLabels.won")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="flex-1 border-red-500/30 text-red-700 hover:bg-red-500/10"
              onClick={async () => {
                const changed = await onLost(stageNote);
                if (changed) setStageNote("");
              }}
              disabled={updating || !firstContactGate.allowed || !stageNote.trim()}
              title={!firstContactGate.allowed ? firstContactGate.reasons.join("; ") : undefined}
            >
              <AlertTriangle className="w-4 h-4 mr-1" />{t("stageLabels.lost")}
            </Button>
          </div>
          </>)}
          <Separator className="bg-border" />
          <Button
            variant="outline"
            size="sm"
            className="w-full border-copper-500/30 text-copper-700 justify-start"
            onClick={onOpenQuoteCalculator}
          >
            <Plus className="w-4 h-4 mr-2" />{t("leadDetail.createQuote")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full border-copper-500/30 text-copper-700 justify-start"
            onClick={onOpenQuickQuote}
          >
            <DollarSign className="w-4 h-4 mr-2" />{lang === "zh" ? "只填金额报价" : "Quick quote (amount only)"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full border-purple-500/30 text-purple-700 hover:bg-purple-500/10 justify-start"
            onClick={onGenerateKnx}
          >
            <WandSparkles className="w-4 h-4 mr-2" />{t("leadDetail.generateKnxPlan")}
          </Button>
        </CardContent>
      </Card>

      {/* Quote / Contract / Payment links */}
      <Card className="order-6 border-border bg-muted/20 shadow-none">
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
              <Badge className="bg-blue-500/10 text-blue-700 text-xs">{t("leadDetail.quotationLabel")}</Badge>
            ) : (
              <Button size="sm" variant="outline" className="border-copper-500/30 text-copper-700 h-7 text-xs" onClick={onOpenQuoteCalculator}>
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
                {!hasContract && canCreateContract && (
                  <Button size="sm" variant="outline" className="border-emerald-500/30 text-emerald-700 hover:bg-emerald-500/10 h-7 text-xs" onClick={onCreateContract}>
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
                    {trace?.payment_date ? ` · ${fmtDubai(trace.payment_date, { locale: t("locale.dateLocale") })}` : ""}
                  </p>
                </div>
                {/* R5. This badge used to read "Confirmed" or "Pending confirm" off
                    `confirmed` alone, and it is fed by v_lead_trace, which exposes
                    `confirmed` and no void column at all (see src/types/database.ts).
                    void_payment() clears `confirmed`, so a REVERSED payment rendered
                    here as money still awaiting confirmation — the B8 defect, on the
                    page a salesperson actually works from.

                    The view cannot be read three ways, so this says only what it can
                    support: `confirmed = true` is confirmed money, and anything else
                    is "not confirmed", which is true of a pending payment and of a
                    voided one alike. It no longer promises that the money is still
                    coming. The contract detail page renders the real three states
                    from the payments row itself. Giving v_lead_trace a voided_at
                    column needs a migration that redefines the view, and no migration
                    in this repository creates it — it is a production-only object;
                    that gap is recorded rather than guessed at. */}
                <Badge className={cn("text-xs", trace?.confirmed === true ? "bg-emerald-500/10 text-emerald-700" : "bg-amber-500/10 text-amber-700")}>
                  {trace?.confirmed === true ? t("leadDetail.confirmed") : t("leadDetail.paymentNotConfirmed")}
                </Badge>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
