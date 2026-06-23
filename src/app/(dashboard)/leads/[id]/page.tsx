"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { ErrorState } from "@/components/ui/error-state";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  ArrowLeft, Phone, MessageSquare, MapPin, Home, Plus, Send,
  Calendar, Clock, User, Target, AlertTriangle, ShieldAlert,
  RotateCcw, BarChart3, TrendingUp, MessageCircle,
  FileText, ClipboardList, CheckCircle, DollarSign, ExternalLink, Calculator, WandSparkles,
  Wrench, GitBranch,
} from "lucide-react";
import QuoteCalculator from "@/app/(dashboard)/quotes/quote-calculator";
import KnxDesignPanel from "@/components/knx-design-panel";
import LeadWorkflow from "@/components/lead-workflow";
import { calculateHealthScore } from "@/lib/health-score";
import { Toaster } from "sonner";

const STAGES = ["new", "contacted", "requirement_confirmed", "solution_submitted", "quotation_submitted", "negotiation", "pending_decision", "won", "lost"];
const STAGE_COLORS: Record<string, string> = {
  new: "bg-gray-500/10 text-muted-foreground", contacted: "bg-amber-500/10 text-amber-400",
  requirement_confirmed: "bg-yellow-500/10 text-yellow-400", solution_submitted: "bg-rose-500/10 text-rose-400",
  quotation_submitted: "bg-purple-500/10 text-purple-400", negotiation: "bg-blue-500/10 text-blue-400",
  pending_decision: "bg-amber-500/10 text-amber-400", won: "bg-emerald-500/10 text-emerald-400",
  lost: "bg-gray-500/10 text-muted-foreground",
};
const getStatusLabels = (t: (key: string) => string): Record<string, { label: string; color: string; bg: string }> => ({
  hot: { label: "🔥 " + t("leads.hot"), color: "text-rose-400", bg: "bg-rose-500/10" },
  warm: { label: "☀️ " + t("leads.warm"), color: "text-amber-400", bg: "bg-amber-500/10" },
  cold: { label: "❄️ " + t("leads.cold"), color: "text-sky-400", bg: "bg-sky-500/10" },
  dormant: { label: "💤 " + t("leads.dormant"), color: "text-muted-foreground", bg: "bg-gray-500/10" },
});
const PROBABILITIES = [10, 30, 50, 70, 90];
const LOST_REASON_KEYS = ["price", "competitor", "noBudget", "cancelled", "delayed", "noResponse", "other"];

interface Lead {
  id: string; source: string; quality: string; stage: string;
  customer_name: string | null; phone: string | null; email: string | null;
  property_type: string | null; property_size_sqm: number | null;
  location: string | null; budget_range: string | null;
  service_needs: string[] | null; ai_summary: string | null;
  ai_tags: string[] | null; ai_quality: string | null;
  created_at: string; updated_at: string;
  disqualified_candidate: boolean; notes: string | null;
  lead_status: string | null; win_probability: number | null;
  stage_changed_at: string | null;
  decision_maker: string | null; decision_date: string | null; competitor: string | null;
  last_contact_date: string | null; next_followup_date: string | null;
  next_action: string | null; followup_count: number | null;
  lost_reason: string | null; lost_at: string | null;
  sales_manager_review: boolean; recovery_candidate: boolean;
  transfer_candidate: boolean; hold_since: string | null;
  source_platform: string | null; source_channel: string | null;
  campaign_id: string | null; campaign_name: string | null;
  adset_id: string | null; adset_name: string | null;
  ad_id: string | null; ad_name: string | null;
  creative_id: string | null; creative_name: string | null;
  form_id: string | null; form_name: string | null;
  utm_source: string | null; utm_medium: string | null;
  utm_campaign: string | null; utm_content: string | null; utm_term: string | null;
  landing_page: string | null; referrer: string | null;
  first_touch_at: string | null; last_touch_at: string | null;
  assigned_to: string | null; rep_name: string | null;
  quotation_value: number | null;
  project_name: string | null; project_status: string | null;
  ac_brand: string | null; system_preference: string | null;
  // Phase B extension fields
  project_type: string | null; emirate: string | null; area: string | null;
  customer_budget: number | null; smart_requirements: any | null;
  expected_sign_date: string | null;
  visit_status: string | null; rejection_detail: string | null;
  circuit_diagrams: boolean | null;
  sales_phase: string | null; phase_pct: number | null; sub_phase: string | null;
  quotation_sent_date: string | null;
  reminder_24h_sent: boolean | null; reminder_48h_sent: boolean | null;
}

interface Activity { id: string; type: string; content: string; ai_generated: boolean; created_at: string; }
interface BusinessEvent { id: string; event_type: string; description: string; event_data: any; created_at: string; }
interface ChatMessage { id: string; content: string | null; direction: string; created_at: string; }
interface LeadTrace {
  lead_id: string; customer_name: string | null; stage: string; quotation_value: number | null;
  quotation_id: string | null; quotation_price: number | null; quotation_status: string | null;
  contract_id: string | null; contract_no: string | null; contract_amount: number | null; contract_status: string | null;
  installment_id: string | null; seq: number | null; installment_amount: number | null; due_date: string | null; installment_status: string | null;
  payment_id: string | null; payment_amount: number | null; payment_date: string | null; confirmed: boolean | null;
  project_id: string | null; project_name: string | null; project_phase: string | null; project_status: string | null;
}

function fmtAED(v: number | null | undefined): string {
  if (v == null || v === 0) return "—";
  if (v >= 1_000_000) return `AED ${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `AED ${(v / 1_000).toFixed(0)}K`;
  return `AED ${v.toLocaleString()}`;
}
function daysSince(d: string | null): number | null {
  if (!d) return null;
  return Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);
}

const TABS = [
  { key: "overview", labelKey: "leadDetail.tabOverview", icon: TrendingUp },
  { key: "details", labelKey: "leadDetail.tabDetails", icon: FileText },
  { key: "workflow", labelKey: "leadDetail.tabWorkflow", icon: CheckCircle },
  { key: "timeline", labelKey: "leadDetail.tabTimeline", icon: Clock },
  { key: "trace", labelKey: "leadDetail.tabTrace", icon: ClipboardList },
];

function InlineEdit({ lead, field, label, type = "text", onSave, children }: {
  lead: any; field: string; label?: string; type?: string;
  onSave: (field: string, value: any, evType?: string, evDesc?: string) => void;
  children?: React.ReactNode;
}) {
  const { t } = useLanguage();
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");

  if (children) return <>{children}</>;

  const value = lead[field];
  const displayValue = value
    ? type === "date" ? new Date(value).toLocaleDateString() : String(value)
    : null;

  return editing ? (
    <div className="flex gap-1 mt-1">
      <input autoFocus value={val} onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { onSave(field, val, "note_added", `${label}: ${val}`); setEditing(false); }
          if (e.key === "Escape") setEditing(false);
        }}
        onBlur={() => { if (val !== String(value ?? "")) onSave(field, val || null, "note_added", `${label}: ${val || "cleared"}`); setEditing(false); }}
        className="flex-1 h-8 text-xs bg-muted border border-border rounded px-2 text-foreground" />
    </div>
  ) : (
    <p className="text-foreground mt-1 cursor-pointer hover:text-copper-400"
      onClick={() => { setVal(String(value ?? "")); setEditing(true); }}>
      {displayValue || <span className="text-gray-600">{t("leadDetail.placeholderClickToFill")}</span>}
    </p>
  );
}

export default function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const supabase = createClient();
  const { t, lang } = useLanguage();
  const [lead, setLead] = useState<Lead | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [events, setEvents] = useState<BusinessEvent[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [leadTrace, setLeadTrace] = useState<LeadTrace[]>([]);
  const [noteText, setNoteText] = useState("");
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("overview");
  const [editField, setEditField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>("");
  const [salesUsers, setSalesUsers] = useState<any[]>([]);
  const [showSalesDropdown, setShowSalesDropdown] = useState(false);
  const [reassigning, setReassigning] = useState(false);
  const [showQuoteCalculator, setShowQuoteCalculator] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data: l, error: err1 } = await supabase.from("leads").select("*").eq("id", id).single();
    if (err1) { console.error("Failed to fetch lead:", err1); setError(t("common.loadFailedRetry")); setLoading(false); return; }
    if (l) setLead(l);
    const res = await fetch(`/api/activities?lead_id=${id}`);
    const a = res.ok ? await res.json() : null;
    if (a) setActivities(a);
    const { data: e } = await supabase.from("business_events").select("*").eq("lead_id", id).order("created_at", { ascending: false }).limit(50);
    if (e) setEvents(e);
    const { data: c } = await supabase.from("chat_messages").select("id, content, direction, created_at").eq("lead_id", id).order("created_at", { ascending: false }).limit(100);
    if (c) setChatMessages(c);
    const { data: tr } = await supabase.from("v_lead_trace").select("*").eq("lead_id", id);
    if (tr) setLeadTrace(tr);
    setLoading(false);
  }, [id]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Meta Pixel: track ViewContent when lead data loads
  useEffect(() => {
    if (lead && typeof window !== "undefined" && (window as any).fbq) {
      (window as any).fbq("track", "ViewContent", {
        content_name: lead.customer_name || "unnamed",
        content_ids: [id],
        content_type: "smart_home_lead",
        value: lead.quotation_value || undefined,
        currency: "AED",
        status: lead.stage || undefined,
      });
    }
  }, [lead, id]);

  useEffect(() => {
    supabase.from("profiles").select("id,email,role,full_name").in("role", ["admin", "sales", "operator"]).then(({ data }) => {
      if (data) setSalesUsers(data);
    });
  }, []);

  async function reassignSales(newUserId: string) {
    setReassigning(true);
    const oldLead = lead!;
    const newUser = salesUsers.find(u => u.id === newUserId);
    const oldUser = salesUsers.find(u => u.id === oldLead.assigned_to);
    const newUserName = newUser?.full_name || newUser?.email || newUserId;
    const oldName = oldUser?.full_name || oldUser?.email || oldLead.rep_name || "Unknown";
    await supabase.from("leads").update({ assigned_to: newUserId, updated_at: new Date().toISOString() }).eq("id", id);
    await supabase.from("transfer_history").insert({ lead_id: id, from_user_id: oldLead.assigned_to, to_user_id: newUserId, reason: "manual_reassign", transferred_by: (await supabase.auth.getUser()).data.user?.id });
    await supabase.from("activities").insert({ lead_id: id, type: "transfer", content: `Reassigned from ${oldName} to ${newUserName}`, user_id: (await supabase.auth.getUser()).data.user?.id });
    await supabase.from("business_events").insert({ lead_id: id, event_type: "transfer", description: `Reassigned from ${oldName} to ${newUserName}`, user_id: (await supabase.auth.getUser()).data.user?.id });
    // Notify the newly assigned salesperson
    import("@/lib/notify").then(({ notify }) => {
      notify({ type: "lead_assigned", lead_id: id, assigned_to: newUserId });
    });
    setLead({ ...oldLead, assigned_to: newUserId, rep_name: newUserName });
    setShowSalesDropdown(false);
    setReassigning(false);
  }

  async function writeEvent(eventType: string, description: string, eventData?: Record<string, any>) {
    await supabase.from("business_events").insert({ lead_id: id, event_type: eventType, description, event_data: eventData || {}, user_id: (await supabase.auth.getUser()).data.user?.id });
  }

  async function updateField(field: string, value: any, eventType?: string, eventDesc?: string) {
    setUpdating(true);
    const updates: Record<string, any> = { updated_at: new Date().toISOString() };
    updates[field] = value;
    const { error: err } = await supabase.from("leads").update(updates).eq("id", id);
    if (err) { console.error("Failed to update field:", err); setError(t("common.saveFailed") || "Save failed"); setUpdating(false); return; }
    if (eventType && eventDesc) {
      await supabase.from("activities").insert({ lead_id: id, type: eventType, content: eventDesc, user_id: (await supabase.auth.getUser()).data.user?.id });
      await writeEvent(eventType, eventDesc, { [field]: value });
    }
    setEditField(null);
    fetchData();
    setUpdating(false);
  }

  async function updateStage(stage: string) {
    await updateField("stage", stage, "stage_change", `${t("leadDetail.eventTypes.stage_changed")} → ${t(`stageLabels.${stage}`)}`);
  }

  async function handleWon() {
    setUpdating(true);
    try {
      // Stage update only — contract & installment creation is handled
      // by the DB trigger trg_lead_won to avoid duplicates
      await updateStage("won");
      toast.success(t("leads.markedWon"));
    } catch (e: any) {
      console.error("handleWon error:", e);
      toast.error(t("common.operationFailed"));
    } finally {
      setUpdating(false);
    }
  }

  async function addNote() {
    if (!noteText.trim()) return;
    await supabase.from("activities").insert({ lead_id: id, type: "note", content: noteText.trim(), user_id: (await supabase.auth.getUser()).data.user?.id });
    await writeEvent("note_added", `${t("leadDetail.eventTypes.note_added")}: ${noteText.trim()}`);
    await supabase.from("leads").update({ last_contact_date: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", id);
    setNoteText("");
    fetchData();
  }

  async function openQuoteCalculator() {
    setShowQuoteCalculator(true);
  }

  if (loading) return <div className="text-muted-foreground p-8">{t("common.loading")}</div>;
  if (error) return <ErrorState message={error} onRetry={fetchData} />;
  if (!lead) return <div className="text-muted-foreground p-8">{t("common.loading")}</div>;

  const dSinceContact = daysSince(lead.last_contact_date || lead.updated_at);
  const isYellow = dSinceContact !== null && dSinceContact >= 7 && dSinceContact < 14 && !["won", "lost"].includes(lead.stage);
  const isRed = dSinceContact !== null && dSinceContact >= 14 && !["won", "lost"].includes(lead.stage);

  // ─── Render helpers ───

  function renderInlineEdit(field: string, label: string, type = "text") {
    const value = (lead as any)[field];
    return editField === field ? (
      <div className="flex gap-1 mt-1">
        <input autoFocus value={editValue} onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") updateField(field, editValue, "note_added", `${label}: ${editValue}`); if (e.key === "Escape") setEditField(null); }}
          className="flex-1 h-8 text-xs bg-muted border border-border rounded px-2 text-foreground" />
      </div>
    ) : (
      <p className="text-foreground mt-1 cursor-pointer hover:text-copper-400"
        onClick={() => { setEditField(field); setEditValue(String(value ?? "")); }}>
        {value ? String(value) : <span className="text-gray-600">{t("leadDetail.placeholderClickToFill")}</span>}
      </p>
    );
  }

  function renderDateEdit(field: string, label: string) {
    const value = (lead as any)[field];
    return editField === field ? (
      <input type="date" autoFocus value={editValue} onChange={(e) => setEditValue(e.target.value)}
        onBlur={() => { updateField(field, editValue || null, "note_added", `${label}: ${editValue || t("leadDetail.cleared")}`); }}
        className="w-full h-8 text-xs bg-muted border border-border rounded px-2 text-foreground mt-1" />
    ) : (
      <p className="text-foreground mt-1 cursor-pointer hover:text-copper-400"
        onClick={() => { setEditField(field); setEditValue(value || ""); }}>
        {value ? new Date(value).toLocaleDateString(t("locale.dateLocale")) : <span className="text-gray-600">{t("leadDetail.placeholderClickToFill")}</span>}
      </p>
    );
  }

  function renderJsonEdit(field: string, label: string) {
    const value = (lead as any)[field];
    let display: string | null = null;
    if (value != null) {
      try { display = typeof value === "string" ? value : JSON.stringify(value); }
      catch { display = String(value); }
    }
    return editField === field ? (
      <div className="flex gap-1 mt-1">
        <input autoFocus value={editValue} placeholder='{"rooms": 4, "lights": "KNX"}'
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              let parsed: any = editValue;
              try { parsed = editValue ? JSON.parse(editValue) : null; } catch { parsed = editValue; }
              updateField(field, parsed, "note_added", `${label}: ${editValue}`);
              setEditField(null);
            }
            if (e.key === "Escape") setEditField(null);
          }}
          className="flex-1 h-8 text-xs bg-muted border border-border rounded px-2 text-foreground" />
      </div>
    ) : (
      <p className="text-foreground mt-1 cursor-pointer hover:text-copper-400 break-all text-xs"
        onClick={() => { setEditField(field); setEditValue(display || ""); }}>
        {display || <span className="text-gray-600">{t("leadDetail.placeholderClickToFill")}</span>}
      </p>
    );
  }

  // ─── Tab: 概览 ───
  function TabOverview() {
    if (!lead) return null;
    // Health score (Phase B) — derived from follow-up recency, stage, quotation, drawings, overdue
    const health = calculateHealthScore({
      hasRecentFollowUp: (lead.followup_count ?? 0) > 0 && (daysSince(lead.last_contact_date) ?? Infinity) <= 7,
      hasMeeting: ["negotiation", "pending_decision", "won"].includes(lead.stage),
      hasDrawings: !!lead.circuit_diagrams,
      hasQuotation: ["quotation_submitted", "negotiation", "pending_decision", "won"].includes(lead.stage),
      isOverdue: !!lead.next_followup_date && new Date(lead.next_followup_date).getTime() < Date.now(),
    });
    const healthLevelLabel = health.level === "healthy" ? t("leadDetail.health_healthy") : health.level === "at_risk" ? t("leadDetail.health_at_risk") : t("leadDetail.health_stale");
    const healthColor = health.score >= 50 ? "bg-emerald-500/10 text-emerald-400" : health.score >= 20 ? "bg-amber-500/10 text-amber-400" : "bg-red-500/10 text-red-400";
    return (
      <div className="space-y-4">
        {/* AI Summary */}
        {lead.ai_summary && (
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground flex items-center gap-2">{t("leadDetail.aiAnalysis")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-foreground">{lead.ai_summary}</p>
              {lead.ai_tags && lead.ai_tags.length > 0 && (
                <div className="flex gap-2 mt-3 flex-wrap">
                  {lead.ai_tags.map((t) => (
                    <Badge key={t} variant="outline" className="text-xs border-border text-muted-foreground">{t}</Badge>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Key metrics row */}
        <div className="flex flex-wrap items-center gap-3">
          <Badge className={cn("text-sm px-3 py-1", STAGE_COLORS[lead.stage] || "")}>
            {t(`stageLabels.${lead.stage}`) || lead.stage}
          </Badge>
          <Badge className={cn("text-sm px-3 py-1", healthColor)} title={t("leadDetail.healthScore")}>
            <ShieldAlert className="w-3.5 h-3.5 mr-1" />{healthLevelLabel} · {health.score}
          </Badge>
          {lead.lead_status && (
            <Badge className={cn("text-sm px-3 py-1", getStatusLabels(t)[lead.lead_status]?.bg)}>
              {getStatusLabels(t)[lead.lead_status]?.label}
            </Badge>
          )}
          {lead.win_probability != null && (
            <Badge className={cn("text-sm px-3 py-1", lead.win_probability >= 70 ? "bg-emerald-500/10 text-emerald-400" : lead.win_probability >= 30 ? "bg-amber-500/10 text-amber-400" : "bg-gray-500/10 text-muted-foreground")}>
              <Target className="w-3.5 h-3.5 mr-1" />{lead.win_probability}%
            </Badge>
          )}
          {lead.quotation_value != null && lead.quotation_value > 0 && (
            <Badge className="bg-copper-500/10 text-copper-400 text-sm px-3 py-1">
              <DollarSign className="w-3.5 h-3.5 mr-1" />{fmtAED(lead.quotation_value)}
            </Badge>
          )}
          {lead.followup_count != null && (
            <span className="text-xs text-muted-foreground">{t("leadDetail.times").replace("{n}", String(lead.followup_count))}</span>
          )}
          {lead.recovery_candidate && <Badge className="bg-orange-500/10 text-orange-400">{t("leads.recovery")}</Badge>}
          {lead.transfer_candidate && <Badge className="bg-red-500/10 text-red-400">{t("leads.transfer")}</Badge>}
          {lead.sales_manager_review && <Badge className="bg-purple-500/10 text-purple-400">{t("leadDetail.managerReview")}</Badge>}
        </div>

        {/* Alert banners */}
        {(isYellow || isRed || lead.recovery_candidate || lead.transfer_candidate) && (
          <div className={cn("px-4 py-2 rounded-lg text-sm flex items-center gap-2",
            isRed ? "bg-red-500/10 text-red-400 border border-red-500/20" :
            isYellow ? "bg-amber-500/10 text-amber-400 border border-amber-500/20" :
            lead.transfer_candidate ? "bg-red-500/10 text-red-400 border border-red-500/20" :
            "bg-orange-500/10 text-orange-400 border border-orange-500/20")}>
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {isRed ? t("leadDetail.redAlert").replace("{n}", String(dSinceContact)) :
             isYellow ? t("leadDetail.yellowAlert").replace("{n}", String(dSinceContact)) :
             lead.recovery_candidate ? t("leadDetail.recoveryAlert") :
             lead.transfer_candidate ? t("leadDetail.transferAlert") : ""}
          </div>
        )}

        {/* Quick action buttons */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">{t("common.actions")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Update Stage — compact dropdown */}
            <div>
              <p className="text-xs text-muted-foreground mb-1.5">{t("leadDetail.updateStage")}</p>
              <div className="flex flex-wrap gap-1">
                {STAGES.filter(s => s !== "won" && s !== "lost").map(s => (
                  <button key={s}
                    className={cn("text-[10px] px-2 py-1 rounded border transition-colors",
                      lead.stage === s ? "border-transparent text-foreground" : "border-border text-muted-foreground hover:border-gray-500")}
                    style={lead.stage === s ? { backgroundColor: STAGE_COLORS[s]?.split(" ")[0]?.replace("/10", "/30") || "#6b7280" } : {}}
                    onClick={() => updateStage(s)}>{t(`stageLabels.${s}`)}</button>
                ))}
              </div>
            </div>
            {/* Mark Won / Lost */}
            <div className="flex gap-2">
              <Button size="sm" variant="outline"
                className="flex-1 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"
                onClick={() => handleWon()}>
                <CheckCircle className="w-4 h-4 mr-1" />{t("stageLabels.won")}
              </Button>
              <Button size="sm" variant="outline"
                className="flex-1 border-red-500/30 text-red-400 hover:bg-red-500/10"
                onClick={() => updateStage("lost")}>
                <AlertTriangle className="w-4 h-4 mr-1" />{t("stageLabels.lost")}
              </Button>
            </div>
            <Separator className="bg-border" />
            <Button variant="outline" size="sm"
              className="w-full border-copper-500/30 text-copper-400 justify-start"
              onClick={openQuoteCalculator}>
              <Plus className="w-4 h-4 mr-2" />{t("leadDetail.createQuote")}
            </Button>
            <Button variant="outline" size="sm"
              className="w-full border-purple-500/30 text-purple-400 hover:bg-purple-500/10 justify-start mt-2"
              onClick={() => {
                // Open KNX design panel — we'll use a simple approach:
                // scroll to the sidebar KNX panel and click its button
                const knxPanel = document.querySelector('[data-knx-panel]');
                if (knxPanel) {
                  knxPanel.scrollIntoView({ behavior: 'smooth' });
                  const btn = knxPanel.querySelector('button');
                  if (btn) btn.click();
                }
              }}>
              <WandSparkles className="w-4 h-4 mr-2" />{t("leadDetail.generateKnxPlan")}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ─── Tab: 详情 ───
  function TabDetails() {
    if (!lead) return null;
    return (
      <div className="space-y-4">
        {/* 客户信息 */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground flex items-center gap-2"><User className="w-4 h-4" /> {t("leadDetail.customerInfo")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div><Label className="text-muted-foreground text-xs">{t("leadDetail.customerName")}</Label>{renderInlineEdit("customer_name", t("leadDetail.customerName"))}</div>
              <div><Label className="text-muted-foreground text-xs">{t("leadDetail.phone")}</Label>{renderInlineEdit("phone", t("leadDetail.phone"))}</div>
              <div><Label className="text-muted-foreground text-xs">{t("leadDetail.email")}</Label>{renderInlineEdit("email", t("leadDetail.email"))}</div>
              <div><Label className="text-muted-foreground text-xs">{t("leadDetail.address")}</Label>{renderInlineEdit("location", t("leadDetail.address"))}</div>
            </div>
          </CardContent>
        </Card>

        {/* 项目信息 */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground flex items-center gap-2"><Home className="w-4 h-4" /> {t("leadDetail.projectInfo")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div><Label className="text-muted-foreground text-xs">{t("leadDetail.propertyType")}</Label>{renderInlineEdit("property_type", t("leadDetail.propertyType"))}</div>
              <div><Label className="text-muted-foreground text-xs">{t("leadDetail.area")}</Label>{renderInlineEdit("property_size_sqm", t("leadDetail.area"))}</div>
              <div><Label className="text-muted-foreground text-xs">{t("leadDetail.budgetRange")}</Label>{renderInlineEdit("budget_range", t("leadDetail.budgetRange"))}</div>
              <div><Label className="text-muted-foreground text-xs">{t("leadDetail.decisionMaker")}</Label>{renderInlineEdit("decision_maker", t("leadDetail.decisionMaker"))}</div>
              <div><Label className="text-muted-foreground text-xs">{t("leadDetail.decisionDate")}</Label>{renderDateEdit("decision_date", t("leadDetail.decisionDate"))}</div>
              <div><Label className="text-muted-foreground text-xs">{t("leadDetail.competitor")}</Label>{renderInlineEdit("competitor", t("leadDetail.competitor"))}</div>
              {/* Phase B: project extension fields */}
              <div>
                <Label className="text-muted-foreground text-xs">{t("leadDetail.projectType")}</Label>
                <div className="mt-1">
                  <Select value={lead.project_type || ""} onValueChange={v => updateField("project_type", v || null, "note_added", `${t("leadDetail.projectType")}: ${v}`)}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="—" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="villa">{t("leadDetail.projectType_villa")}</SelectItem>
                      <SelectItem value="apartment">{t("leadDetail.projectType_apartment")}</SelectItem>
                      <SelectItem value="developer">{t("leadDetail.projectType_developer")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div><Label className="text-muted-foreground text-xs">{t("leadDetail.emirate")}</Label>{renderInlineEdit("emirate", t("leadDetail.emirate"))}</div>
              <div><Label className="text-muted-foreground text-xs">{t("leadDetail.areaLocality")}</Label>{renderInlineEdit("area", t("leadDetail.areaLocality"))}</div>
              <div><Label className="text-muted-foreground text-xs">{t("leadDetail.customerBudget")}</Label>{renderInlineEdit("customer_budget", t("leadDetail.customerBudget"))}</div>
              <div><Label className="text-muted-foreground text-xs">{t("leadDetail.smartRequirements")}</Label>{renderJsonEdit("smart_requirements", t("leadDetail.smartRequirements"))}</div>
              <div><Label className="text-muted-foreground text-xs">{t("leadDetail.expectedSignDate")}</Label>{renderDateEdit("expected_sign_date", t("leadDetail.expectedSignDate"))}</div>
              <div><Label className="text-muted-foreground text-xs">{t("leadDetail.acBrand")}</Label>{renderInlineEdit("ac_brand", t("leadDetail.acBrand"))}</div>
            </div>
          </CardContent>
        </Card>

        {/* 技术信息 */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground flex items-center gap-2"><Wrench className="w-4 h-4" /> {t("leadDetail.techInfo")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div><Label className="text-muted-foreground text-xs">{t("leadDetail.projectName")}</Label>{renderInlineEdit("project_name", t("leadDetail.projectName"))}</div>
              <div>
                <Label className="text-muted-foreground text-xs">{t("leadDetail.projectStatus")}</Label>
                <div className="mt-1">
                  <Select value={lead.project_status || ""} onValueChange={v => updateField("project_status", v || null, "note_added", `${t("leadDetail.projectStatus")}: ${v}`)}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="—" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="在建">{t("leadDetail.underConstruction")}</SelectItem>
                      <SelectItem value="翻新">{t("leadDetail.renovation")}</SelectItem>
                      <SelectItem value="毛坯">{t("leadDetail.bareShell")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div><Label className="text-muted-foreground text-xs">{t("leadDetail.acBrand")}</Label>{renderInlineEdit("ac_brand", t("leadDetail.acBrand"))}</div>
              <div>
                <Label className="text-muted-foreground text-xs">{t("leadDetail.systemPreference")}</Label>
                <div className="mt-1">
                  <Select value={lead.system_preference || ""} onValueChange={v => updateField("system_preference", v || null, "note_added", `${t("leadDetail.systemPreference")}: ${v}`)}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="—" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="KNX">{t("leadDetail.knx")}</SelectItem>
                      <SelectItem value="无线">{t("leadDetail.wireless")}</SelectItem>
                      <SelectItem value="混合">{t("leadDetail.hybrid")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">{t("leadDetail.visitStatus")}</Label>
                <div className="mt-1">
                  <Select value={lead.visit_status || ""} onValueChange={v => updateField("visit_status", v || null, "note_added", `${t("leadDetail.visitStatus")}: ${v}`)}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="—" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="已上门">✅ {t("leadDetail.visited")}</SelectItem>
                      <SelectItem value="待上门">📅 {t("leadDetail.pendingVisit")}</SelectItem>
                      <SelectItem value="无需上门">{t("leadDetail.noVisitNeeded")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex items-end gap-2">
                <button onClick={() => updateField("circuit_diagrams", !lead.circuit_diagrams, "note_added", lead.circuit_diagrams ? "电路图: 无" : "电路图: 有")}
                  className={cn("px-3 py-1 text-xs rounded border transition-colors", lead.circuit_diagrams ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/50" : "bg-muted/50 text-muted-foreground border-border")}>
                  📐 {t("leadDetail.hasCircuitDiagrams")}
                </button>
              </div>
            </div>
            {lead.rejection_detail && (
              <div className="mt-3 p-2 bg-rose-500/10 border border-rose-500/20 rounded text-xs text-rose-400">
                🚫 {t("leadDetail.rejectionDetail")}: {lead.rejection_detail}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 销售阶段追踪 */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground flex items-center gap-2"><GitBranch className="w-4 h-4" /> {t("leadDetail.salesProgress")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <Label className="text-muted-foreground text-xs w-20 shrink-0">{t("leadDetail.phase")}</Label>
                <div className="flex-1">
                  <Select value={lead.sales_phase || "lead"} onValueChange={v => updateField("sales_phase", v, "phase_changed", `${t("leadDetail.phase")}: ${v}`)}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="lead">📥 {t("leadDetail.phaseLead")} (0%)</SelectItem>
                      <SelectItem value="contact">📞 {t("leadDetail.phaseContact")} (20%)</SelectItem>
                      <SelectItem value="requirement">📋 {t("leadDetail.phaseRequirement")} (40%)</SelectItem>
                      <SelectItem value="quotation">💰 {t("leadDetail.phaseQuotation")} (60%)</SelectItem>
                      <SelectItem value="design">🏗️ {t("leadDetail.phaseDesign")} (80%)</SelectItem>
                      <SelectItem value="closing">🤝 {t("leadDetail.phaseClosing")} (90%)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Label className="text-muted-foreground text-xs w-20 shrink-0">{t("leadDetail.progress")}</Label>
                <div className="flex-1 bg-muted rounded-full h-2 overflow-hidden">
                  <div className="h-full bg-copper-500 rounded-full transition-all" style={{ width: `${lead.phase_pct || 0}%` }} />
                </div>
                <span className="text-xs text-muted-foreground w-8 text-right">{lead.phase_pct || 0}%</span>
              </div>
              {lead.sales_phase === "design" && (
                <div>
                  <Label className="text-muted-foreground text-xs">{t("leadDetail.subPhase")}</Label>
                  <div className="mt-1">
                    <Select value={lead.sub_phase || ""} onValueChange={v => updateField("sub_phase", v || null, "note_added", `${t("leadDetail.subPhase")}: ${v}`)}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue placeholder={t("leadDetail.selectSubPhase")} /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="深化方案中">🔧 {t("leadDetail.deepeningDesign")}</SelectItem>
                        <SelectItem value="准备签单中">✍️ {t("leadDetail.preparingSign")}</SelectItem>
                        <SelectItem value="被拒">🚫 {t("leadDetail.rejected")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* 销售信息 */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground flex items-center gap-2"><TrendingUp className="w-4 h-4" /> {t("leadDetail.salesInfo")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div><Label className="text-muted-foreground text-xs">{t("leadDetail.source")}</Label><p className="text-foreground mt-1">{lead.source || "—"}</p></div>
              <div><Label className="text-muted-foreground text-xs">{t("leadDetail.quotationValue")}</Label>{renderInlineEdit("quotation_value", t("leadDetail.quotationValue"))}</div>
              <div>
                <Label className="text-muted-foreground text-xs">{t("leadDetail.probability")}</Label>
                <div className="flex gap-1 mt-1 flex-wrap">
                  {PROBABILITIES.map(p => (
                    <button key={p}
                      className={cn("text-[10px] px-2 py-1 rounded border transition-colors",
                        lead.win_probability === p ? "bg-copper-500 text-black border-copper-500" : "border-border text-muted-foreground hover:border-gray-500")}
                      onClick={() => updateField("win_probability", p, "probability_changed", `${t("leadDetail.probability")}: ${p}%`)}>
                      {p}%
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">{t("leadDetail.customerStatus")}</Label>
                <div className="flex gap-1 mt-1 flex-wrap">
                  {Object.entries(getStatusLabels(t)).map(([k, v]) => (
                    <button key={k}
                      className={cn("text-[10px] px-2 py-1 rounded border transition-colors",
                        lead.lead_status === k ? "border-transparent text-foreground" : "border-border text-muted-foreground hover:border-gray-500")}
                      style={lead.lead_status === k ? { backgroundColor: k === "hot" ? "#f43f5e" : k === "warm" ? "#f59e0b" : k === "cold" ? "#0ea5e9" : "#6b7280" } : {}}
                      onClick={() => updateField("lead_status", k, "status_changed", `${t("leadDetail.customerStatus")}: ${v.label}`)}>
                      {v.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 跟进信息 */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground flex items-center gap-2"><Calendar className="w-4 h-4" /> {t("leadDetail.followupInfo")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <Label className="text-muted-foreground text-xs">{t("leadDetail.lastContact")}</Label>
                <p className="text-foreground mt-1">
                  {lead.last_contact_date ? new Date(lead.last_contact_date).toLocaleDateString(t("locale.dateLocale")) : "—"}
                  {dSinceContact !== null && <span className={cn("ml-2", isRed ? "text-red-400" : isYellow ? "text-amber-400" : "text-muted-foreground")}>{t("leadDetail.daysAgoLabel").replace("{n}", String(dSinceContact))}</span>}
                </p>
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">{t("leadDetail.followUpCount")}</Label>
                <p className={cn("mt-1", (lead.followup_count ?? 0) === 0 ? "text-rose-400 font-medium" : "text-foreground")}>
                  {lead.followup_count != null ? t("leadDetail.times").replace("{n}", String(lead.followup_count)) : <span className="text-rose-400 font-medium">{t("leadDetail.placeholderRequired")}</span>}
                </p>
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">{t("leadDetail.nextFollowUp")} *{t("leadDetail.required")}</Label>
                {editField === "next_followup_date" ? (
                  <input type="date" autoFocus value={editValue} onChange={(e) => setEditValue(e.target.value)}
                    onBlur={() => { if (editValue) updateField("next_followup_date", editValue, "followup_scheduled", `${t("leadDetail.nextFollowUp")}: ${editValue}`); }}
                    className="w-full h-8 text-xs bg-muted border border-border rounded px-2 text-foreground mt-1" />
                ) : (
                  <p className={cn("mt-1 cursor-pointer hover:text-copper-400",
                    !lead.next_followup_date ? "text-rose-400 font-medium" : "text-foreground")}
                    onClick={() => { setEditField("next_followup_date"); setEditValue(lead.next_followup_date || ""); }}>
                    {lead.next_followup_date ? new Date(lead.next_followup_date).toLocaleDateString(t("locale.dateLocale")) : t("leadDetail.placeholderRequired")}
                  </p>
                )}
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">{t("leadDetail.nextAction")} *{t("leadDetail.required")}</Label>
                {editField === "next_action" ? (
                  <div className="flex gap-1 mt-1">
                    <input autoFocus value={editValue} onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && editValue.trim()) updateField("next_action", editValue.trim(), "followup_scheduled", `${t("leadDetail.nextAction")}: ${editValue.trim()}`); if (e.key === "Escape") setEditField(null); }}
                      className="flex-1 h-8 text-xs bg-muted border border-border rounded px-2 text-foreground" />
                  </div>
                ) : (
                  <p className={cn("mt-1 cursor-pointer hover:text-copper-400",
                    !lead.next_action ? "text-rose-400 font-medium" : "text-foreground")}
                    onClick={() => { setEditField("next_action"); setEditValue(lead.next_action || ""); }}>
                    {lead.next_action || t("leadDetail.placeholderRequired")}
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Manager flags + Hold + Reassign */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground flex items-center gap-2"><ShieldAlert className="w-4 h-4" /> {t("leadDetail.managerSection")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {/* Sales reassign */}
            <div className="relative flex items-center justify-between">
              <span className="text-muted-foreground">{t("leadDetail.responsible")}</span>
              <button onClick={() => setShowSalesDropdown(!showSalesDropdown)} disabled={reassigning}
                className="flex items-center gap-1.5 text-foreground text-sm hover:text-copper-400 transition-colors disabled:opacity-50">
                <User className="w-3.5 h-3.5" />
                <span>{lead.rep_name || (salesUsers.find(u => u.id === lead.assigned_to)?.full_name) || "—"}</span>
                <svg className={`w-3 h-3 transition-transform ${showSalesDropdown ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {showSalesDropdown && (
                <div className="absolute top-full right-0 mt-1 w-56 z-50 bg-muted border border-border rounded-lg shadow-xl py-1 max-h-48 overflow-y-auto">
                  {reassigning && <div className="px-3 py-2 text-xs text-muted-foreground">Reassigning...</div>}
                  {salesUsers.map((u) => (
                    <button key={u.id} onClick={() => reassignSales(u.id)}
                      className={cn("w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-muted transition-colors", lead.assigned_to === u.id ? "text-copper-400" : "text-foreground")}>
                      <span className={cn("w-2 h-2 rounded-full", lead.assigned_to === u.id ? "bg-copper-400" : "bg-gray-600")} />
                      <div className="flex-1 min-w-0">
                        <p className="truncate">{u.full_name || u.email}</p>
                        <p className="text-[10px] text-muted-foreground">{u.role}</p>
                      </div>
                    </button>
                  ))}
                  {salesUsers.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">No users found</p>}
                </div>
              )}
            </div>
            <Separator className="bg-border" />
            {[
              { key: "sales_manager_review", label: t("leadDetail.managerReview"), color: "purple" },
              { key: "recovery_candidate", label: t("leadDetail.recoveryCandidate"), color: "orange" },
              { key: "transfer_candidate", label: t("leadDetail.transferCandidate"), color: "red" },
            ].map(({ key, label, color }) => (
              <div key={key} className="flex items-center justify-between">
                <span className="text-muted-foreground">{label}</span>
                <button
                  className={cn("px-2 py-0.5 rounded text-xs font-medium transition-colors",
                    (lead as any)[key] ? `bg-${color}-500/20 text-${color}-400` : "bg-muted text-muted-foreground hover:bg-muted")}
                  onClick={() => updateField(key, !(lead as any)[key], (lead as any)[key] ? undefined : "manager_review_flagged", (lead as any)[key] ? `${t("leadDetail.remove")}${label}` : `${t("leadDetail.flag")}${label}`)}>
                  {(lead as any)[key] ? t("leadDetail.flaggedYes") : t("leadDetail.setFlag")}
                </button>
              </div>
            ))}
            <Separator className="bg-border" />
            <div>
              <Label className="text-muted-foreground text-xs">{t("leadDetail.holdSince")}</Label>
              {renderDateEdit("hold_since", t("leadDetail.holdSince"))}
            </div>
            <div className="bg-muted rounded-lg p-2.5 text-xs text-muted-foreground space-y-1">
              <p className="font-medium text-muted-foreground">{t("leadDetail.autoRules")}</p>
              <p>• {t("leadDetail.autoRule1")}</p><p>• {t("leadDetail.autoRule2")}</p><p>• {t("leadDetail.autoRule3")}</p>
              <p>• {t("leadDetail.autoRule4")}</p><p>• {t("leadDetail.autoRule5")}</p><p>• {t("leadDetail.autoRule6")}</p>
            </div>
          </CardContent>
        </Card>

        {/* Lost Reason (if lost) */}
        {lead.stage === "lost" && (
          <Card className="bg-card border-red-800/30">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-red-400 flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> {t("leadDetail.lostInfo")}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-sm">
                <Label className="text-muted-foreground text-xs">{t("leadDetail.lostReason")}</Label>
                <div className="flex gap-1 mt-1 flex-wrap">
                  {LOST_REASON_KEYS.map(r => (
                    <button key={r}
                      className={cn("text-[10px] px-2 py-1 rounded border transition-colors",
                        lead.lost_reason === r ? "bg-rose-500 text-foreground border-rose-500" : "border-border text-muted-foreground hover:border-gray-500")}
                      onClick={() => updateField("lost_reason", r, "lost_reason_set", `${t("leadDetail.lostReason")}: ${t(`leadDetail.lostReason_${r}`)}`)}>
                      {t(`leadDetail.lostReason_${r}`)}
                    </button>
                  ))}
                </div>
                {lead.lost_at && (<p className="text-muted-foreground text-xs mt-2">{t("leadDetail.lostAt")}{new Date(lead.lost_at).toLocaleString(t("locale.dateTimeLocale"))}</p>)}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Attribution */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground flex items-center gap-2"><BarChart3 className="w-4 h-4" /> {t("leadDetail.attribution")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
              {[
                { label: t("leadDetail.sourcePlatform"), value: lead.source_platform },
                { label: t("leadDetail.sourceChannel"), value: lead.source_channel },
                { label: t("leadDetail.campaignId"), value: lead.campaign_id }, { label: t("leadDetail.campaign"), value: lead.campaign_name },
                { label: t("leadDetail.adsetId"), value: lead.adset_id }, { label: t("leadDetail.adset"), value: lead.adset_name },
                { label: t("leadDetail.adId"), value: lead.ad_id }, { label: t("leadDetail.adName"), value: lead.ad_name },
                { label: t("leadDetail.creativeId"), value: lead.creative_id }, { label: t("leadDetail.creative"), value: lead.creative_name },
                { label: t("leadDetail.formId"), value: lead.form_id }, { label: t("leadDetail.formName"), value: lead.form_name },
                { label: t("leadDetail.utmSource"), value: lead.utm_source }, { label: t("leadDetail.utmMedium"), value: lead.utm_medium },
                { label: t("leadDetail.utmCampaign"), value: lead.utm_campaign }, { label: t("leadDetail.utmContent"), value: lead.utm_content },
                { label: t("leadDetail.utmTerm"), value: lead.utm_term }, { label: t("leadDetail.landingPage"), value: lead.landing_page },
                { label: t("leadDetail.referrer"), value: lead.referrer },
              ].map(({ label, value }) => (
                <div key={label}><p className="text-muted-foreground">{label}</p><p className="text-foreground truncate" title={value || ""}>{value || "—"}</p></div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ─── Tab: 时间线 ───
  function TabWorkflow() {
    if (!lead) return null;
    return (
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm text-muted-foreground flex items-center gap-2">
            <CheckCircle className="w-4 h-4" /> {t("leadDetail.workflowProgress")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <LeadWorkflow leadId={lead.id} />
        </CardContent>
      </Card>
    );
  }

  function TabTimeline() {
    if (!lead) return null;
    const allItems = [
      ...activities.map(a => ({ ...a, _type: "activity" as const, _icon: null })),
      ...events.map(e => ({ id: e.id, type: e.event_type, content: e.description, ai_generated: false, created_at: e.created_at, _type: "event" as const, _icon: null })),
      ...chatMessages.map(c => ({ id: c.id, type: "chat", content: c.content || "", ai_generated: false, created_at: c.created_at, _type: "chat" as const, _icon: "💬" as const, direction: c.direction })),
    ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, 100);

    return (
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-muted-foreground flex items-center gap-2">
            <Clock className="w-4 h-4" /> {t("leadDetail.timeline")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Add note */}
          <div className="flex gap-2">
            <Textarea placeholder={t("leadDetail.placeholderNote")} value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              className="bg-muted border-border text-foreground resize-none h-20"
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addNote(); } }} />
            <Button size="icon" onClick={addNote} disabled={!noteText.trim()} className="bg-copper-500 hover:bg-copper-600 text-black h-10 w-10 shrink-0 self-end">
              <Send className="w-4 h-4" />
            </Button>
          </div>
          <Separator className="bg-border" />

          <div className="space-y-3">
            {allItems.map((item) => (
              <div key={`${item._type}-${item.id}`} className="flex gap-3 text-sm">
                {item._type === "chat" ? (
                  <span className="text-lg shrink-0 mt-0.5">💬</span>
                ) : (
                  <div className={cn("w-1.5 h-1.5 rounded-full mt-1.5 shrink-0",
                    item.type.includes("stage") ? "bg-amber-500" :
                    item.type.includes("note") ? "bg-gray-500" :
                    item.type.includes("quote") ? "bg-blue-500" :
                    item.type.includes("lost") ? "bg-red-500" :
                    item.type.includes("probability") || item.type.includes("status") ? "bg-purple-500" :
                    item.type.includes("followup") ? "bg-emerald-500" :
                    item.type.includes("review") ? "bg-violet-500" :
                    item.type.includes("recovery") || item.type.includes("transfer") ? "bg-orange-500" :
                    "bg-gray-600")} />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-foreground">
                    {item._type === "chat" && item.direction === "inbound"
                      ? <><span className="text-emerald-400">📩 </span>{item.content}</>
                      : item._type === "chat" && item.direction === "outbound"
                      ? <><span className="text-blue-400">📤 </span>{item.content}</>
                      : item.content}
                  </p>
                  <p className="text-xs text-gray-600 mt-0.5 flex items-center gap-2">
                    {new Date(item.created_at).toLocaleString(t("locale.dateTimeLocale"))}
                    {"ai_generated" in item && (item as any).ai_generated && <span className="text-purple-500">🤖 AI</span>}
                    {"_type" in item && item._type === "event" && <span className="text-blue-500">{t("leadDetail.event")}</span>}
                    {item._type === "chat" && <span className="text-cyan-500">💬 Chat</span>}
                  </p>
                </div>
              </div>
            ))}
            {allItems.length === 0 && (
              <p className="text-gray-600 text-sm text-center py-4">{t("leadDetail.noActivity")}</p>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  // ─── Tab: 追溯 ───
  function TabTrace() {
    if (!lead) return null;
    if (leadTrace.length === 0) {
      return (
        <Card className="bg-card border-border">
          <CardContent className="py-8 text-center">
            <ClipboardList className="w-12 h-12 text-gray-700 mx-auto mb-3" />
            <p className="text-muted-foreground">{t("leadDetail.traceNoData")}</p>
            <p className="text-gray-600 text-xs mt-1">{t("leadDetail.traceNoDataDesc")}</p>
          </CardContent>
        </Card>
      );
    }

    // Group by trace row — typically one row per trace
    return (
      <div className="space-y-4">
        {leadTrace.map((trace, idx) => (
          <div key={idx} className="space-y-3">
            {/* Lead card */}
            <div className="bg-card border border-border rounded-lg p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <User className="w-4 h-4 text-copper-400" />
                  <span className="text-foreground font-medium">{trace.customer_name || "Unnamed"}</span>
                </div>
                <Badge className={STAGE_COLORS[trace.stage] || ""}>{t(`stageLabels.${trace.stage}`) || trace.stage}</Badge>
              </div>
              {trace.quotation_value != null && trace.quotation_value > 0 && (
                <p className="text-sm text-muted-foreground mt-1">{t("leadDetail.quotationAmount")}: {fmtAED(trace.quotation_value)}</p>
              )}
            </div>

            {/* Chain connectors */}
            <div className="relative pl-6 space-y-0">
              {/* Quotation */}
              <div className="border-l-2 border-border pb-4 pl-6 relative">
                <div className="absolute -left-[9px] top-0 w-4 h-4 rounded-full bg-muted border-2 border-border flex items-center justify-center">
                  <FileText className="w-2 h-2 text-muted-foreground" />
                </div>
                {trace.quotation_id ? (
                  <div className="bg-card border border-border rounded-lg p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-foreground font-medium">{t("leadDetail.quotationLabel")}</span>
                      <Badge className={cn("text-[10px]", trace.quotation_status === "approved" ? "bg-emerald-500/10 text-emerald-400" : "bg-amber-500/10 text-amber-400")}>
                        {trace.quotation_status || "—"}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{t("leadDetail.amount")}: {fmtAED(trace.quotation_price)}</p>
                  </div>
                ) : (
                  <div className="bg-muted/50 border border-dashed border-border/50 rounded-lg p-3">
                    <p className="text-sm text-gray-600">{t("leadDetail.quotationNotCreated")}</p>
                  </div>
                )}
              </div>

              {/* Contract */}
              <div className="border-l-2 border-border pb-4 pl-6 relative">
                <div className="absolute -left-[9px] top-0 w-4 h-4 rounded-full bg-muted border-2 border-border flex items-center justify-center">
                  <FileText className="w-2 h-2 text-muted-foreground" />
                </div>
                {trace.contract_id ? (
                  <div className="bg-card border border-border rounded-lg p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-foreground font-medium">{t("leadDetail.contractLabel")} {trace.contract_no || ""}</span>
                      <Badge className={cn("text-[10px]", trace.contract_status === "active" ? "bg-emerald-500/10 text-emerald-400" : "bg-amber-500/10 text-amber-400")}>
                        {trace.contract_status || "—"}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{t("leadDetail.amount")}: {fmtAED(trace.contract_amount)}</p>
                  </div>
                ) : (
                  <div className="bg-muted/50 border border-dashed border-border/50 rounded-lg p-3">
                    <p className="text-sm text-gray-600">{t("leadDetail.contractNotCreated")}</p>
                  </div>
                )}
              </div>

              {/* Installments */}
              <div className="border-l-2 border-border pb-4 pl-6 relative">
                <div className="absolute -left-[9px] top-0 w-4 h-4 rounded-full bg-muted border-2 border-border flex items-center justify-center">
                  <Calendar className="w-2 h-2 text-muted-foreground" />
                </div>
                {trace.installment_id ? (
                  <div className="bg-card border border-border rounded-lg p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-foreground font-medium">{t("leadDetail.installment")} #{trace.seq || "?"}</span>
                      <Badge className={cn("text-[10px]", trace.installment_status === "paid" ? "bg-emerald-500/10 text-emerald-400" : "bg-amber-500/10 text-amber-400")}>
                        {trace.installment_status || "—"}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{fmtAED(trace.installment_amount)} · {t("leadDetail.dueDate")} {trace.due_date ? new Date(trace.due_date).toLocaleDateString() : "—"}</p>
                  </div>
                ) : (
                  <div className="bg-muted/50 border border-dashed border-border/50 rounded-lg p-3">
                    <p className="text-sm text-gray-600">{t("leadDetail.installmentNotCreated")}</p>
                  </div>
                )}
              </div>

              {/* Payments */}
              <div className="border-l-2 border-border pb-4 pl-6 relative">
                <div className="absolute -left-[9px] top-0 w-4 h-4 rounded-full bg-muted border-2 border-border flex items-center justify-center">
                  <DollarSign className="w-2 h-2 text-muted-foreground" />
                </div>
                {trace.payment_id ? (
                  <div className="bg-card border border-border rounded-lg p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-foreground font-medium">{t("leadDetail.payment")}</span>
                      {trace.confirmed ? (
                        <Badge className="bg-emerald-500/10 text-emerald-400 text-[10px]">{t("leadDetail.confirmed")}</Badge>
                      ) : (
                        <Badge className="bg-amber-500/10 text-amber-400 text-[10px]">{t("leadDetail.pendingConfirm")}</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{fmtAED(trace.payment_amount)} · {trace.payment_date ? new Date(trace.payment_date).toLocaleDateString() : "—"}</p>
                  </div>
                ) : (
                  <div className="bg-muted/50 border border-dashed border-border/50 rounded-lg p-3">
                    <p className="text-sm text-gray-600">{t("leadDetail.paymentNotCreated")}</p>
                  </div>
                )}
              </div>

              {/* Project */}
              <div className="pl-6 relative">
                <div className="absolute -left-[9px] top-0 w-4 h-4 rounded-full bg-muted border-2 border-border flex items-center justify-center">
                  <Home className="w-2 h-2 text-muted-foreground" />
                </div>
                {trace.project_id ? (
                  <div className="bg-card border border-border rounded-lg p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-foreground font-medium">{trace.project_name || "Project"}</span>
                      <div className="flex gap-1">
                        <Badge className="text-[10px] bg-blue-500/10 text-blue-400">{trace.project_phase || "—"}</Badge>
                        <Badge className={cn("text-[10px]", trace.project_status === "active" ? "bg-emerald-500/10 text-emerald-400" : "bg-gray-500/10 text-muted-foreground")}>
                          {trace.project_status || "—"}
                        </Badge>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="bg-muted/50 border border-dashed border-border/50 rounded-lg p-3">
                    <p className="text-sm text-gray-600">{t("leadDetail.projectNotCreated")}</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  // ═══════════════ MAIN RENDER ═══════════════
  return (
    <div className="max-w-5xl space-y-6">
      {/* Back + header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => router.push("/leads")} className="text-muted-foreground">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-foreground">
              {lead.customer_name || lead.phone || t("leadDetail.unnamed")}
            </h1>
            {lead.lead_status && (
              <span className={cn("text-xs px-2 py-0.5 rounded font-medium",
                lead.lead_status === "hot" ? "bg-rose-500/10 text-rose-400" :
                lead.lead_status === "warm" ? "bg-amber-500/10 text-amber-400" :
                lead.lead_status === "cold" ? "bg-sky-500/10 text-sky-400" :
                "bg-gray-500/10 text-muted-foreground")}>
                {lead.lead_status === "hot" ? "🔥 " : lead.lead_status === "warm" ? "☀️ " : lead.lead_status === "cold" ? "❄️ " : "💤 "}
                {t(`statusLabels.${lead.lead_status}`)}
              </span>
            )}
          </div>
          <p className="text-muted-foreground text-sm">
            {new Date(lead.created_at).toLocaleDateString(t("locale.dateLocale"))} · {lead.source}
            {lead.rep_name && ` · ${lead.rep_name}`}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ────── Left: Tabs ────── */}
        <div className="lg:col-span-2 space-y-4">
          {/* Tab bar — horizontal pill-style */}
          <div className="flex gap-1 bg-muted/50 rounded-lg p-1 border border-border">
            {TABS.map(({ key, labelKey, icon: Icon }) => (
              <button key={key}
                onClick={() => setActiveTab(key)}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium transition-all",
                  activeTab === key
                    ? "bg-copper-500/15 text-copper-400 shadow-sm"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                )}>
                <Icon className="w-3.5 h-3.5" />
                {t(labelKey)}
              </button>
            ))}
          </div>

          {/* Tab content */}
          {activeTab === "overview" && <TabOverview />}
          {activeTab === "details" && <TabDetails />}
          {activeTab === "workflow" && <TabWorkflow />}
          {activeTab === "timeline" && <TabTimeline />}
          {activeTab === "trace" && <TabTrace />}
        </div>

        {/* ────── Right Sidebar ────── */}
        <div className="space-y-4">
          {/* Contact Info */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">{t("leadDetail.contactInfo")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {lead.phone && <div className="flex items-center gap-2 text-foreground"><Phone className="w-4 h-4 text-muted-foreground" />{lead.phone}</div>}
              {lead.email && <div className="flex items-center gap-2 text-foreground"><MessageSquare className="w-4 h-4 text-muted-foreground" />{lead.email}</div>}
              {lead.location && <div className="flex items-center gap-2 text-foreground"><MapPin className="w-4 h-4 text-muted-foreground" />{lead.location}</div>}
              {lead.property_type && <div className="flex items-center gap-2 text-foreground"><Home className="w-4 h-4 text-muted-foreground" />{lead.property_type}{lead.property_size_sqm && ` · ${lead.property_size_sqm}㎡`}</div>}
              {lead.budget_range && <div className="text-foreground">{t("leadDetail.budget")}: {lead.budget_range}</div>}
            </CardContent>
          </Card>

          {/* Quick create quote */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">{t("common.actions")}</CardTitle>
            </CardHeader>
            <CardContent>
              <Button variant="outline" size="sm"
                className="w-full border-copper-500/30 text-copper-400 justify-start"
                onClick={openQuoteCalculator}>
                <Plus className="w-4 h-4 mr-2" />{t("leadDetail.createQuote")}
              </Button>
            </CardContent>
          </Card>

          {/* KNX Design */}
          <KnxDesignPanel leadId={id as string} />
        </div>
      </div>

      {showQuoteCalculator && (
        <QuoteCalculator
          open={showQuoteCalculator}
          onOpenChange={setShowQuoteCalculator}
          initialLeadId={id as string}
          onSaved={() => { fetchData(); }}
        />
      )}
      <Toaster position="top-center" richColors />
    </div>
  );
}
