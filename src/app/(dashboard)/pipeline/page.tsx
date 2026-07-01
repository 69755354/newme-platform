"use client";

import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { ErrorState } from "@/components/ui/error-state";
import { createClient } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Users, DollarSign, TrendingDown, Clock, Target, AlertTriangle,
  GripVertical, User, Plus, TrendingUp, Wallet, CheckCircle2,
  ChevronLeft, ChevronRight,
} from "lucide-react";
import { usePipelineDragDrop } from "@/shared/hooks/usePipelineDragDrop";
import { useStageGuard } from "@/shared/hooks/useStageGuard";
import { useSupabaseQuery } from "@/lib/supabaseQuery";
import KanbanStats from "@/components/pipeline/KanbanStats";
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";

/* ─── Types ─── */
interface Lead {
  id: string; customer_name: string | null;
  stage: string; final_status: string | null; quotation_value: number | null;
  win_probability: number | null;
  last_contact_date: string | null; next_followup_date: string | null;
  next_action: string | null; created_at: string; updated_at: string;
  recovery_candidate: boolean; transfer_candidate: boolean;
  sales_manager_review: boolean; hold_since: string | null;
  lead_status: string | null; assigned_to: string | null;
  rep_name: string | null;
  followup_count: number | null;
}

const STAGES = [
  { key: "new", labelKey: "pipeline.stageNew", color: "#6B7280", bg: "bg-muted/30", border: "border-border/40" },
  { key: "contacted", labelKey: "pipeline.stageContacted", color: "#C48A52", bg: "bg-amber-950/30", border: "border-amber-800/40" },
  { key: "requirement_confirmed", labelKey: "pipeline.stageReqConfirmed", color: "#E0B95A", bg: "bg-yellow-950/20", border: "border-yellow-800/40" },
  { key: "solution_submitted", labelKey: "pipeline.stageSolutionSub", color: "#4A5568", bg: "bg-slate-950/20", border: "border-slate-800/40" },
  { key: "quotation_submitted", labelKey: "pipeline.stageQuotationSub", color: "#8B5CF6", bg: "bg-purple-950/20", border: "border-purple-800/40" },
  { key: "negotiation", labelKey: "pipeline.stageNegotiation", color: "#3B82F6", bg: "bg-blue-950/20", border: "border-blue-800/40" },
  { key: "pending_decision", labelKey: "pipeline.stagePendingDecision", color: "#F59E0B", bg: "bg-amber-950/20", border: "border-amber-800/40" },
  { key: "won", labelKey: "pipeline.stageWon", color: "#4ADE80", bg: "bg-emerald-950/20", border: "border-emerald-800/40" },
  { key: "lost", labelKey: "pipeline.stageLost", color: "#6B7280", bg: "bg-muted/30", border: "border-border/40" },
];

const STATUS_EMOJIS: Record<string, string> = {
  hot: "🔥", warm: "☀️", cold: "❄️", dormant: "💤",
};

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

/* ─── Draggable Lead Card ─── */
function LeadCard({ lead, onDragStart, onLeadClick, salesUsers }: { lead: Lead; onDragStart: (e: React.DragEvent, leadId: string) => void; onLeadClick: (id: string) => void; salesUsers: any[] }) {
  const { t } = useLanguage();
  const days = daysSince(lead.last_contact_date || lead.updated_at);
  const hoursSinceUpdate = lead.updated_at
    ? Math.floor((Date.now() - new Date(lead.updated_at).getTime()) / 3_600_000)
    : null;
  const isInactive24h = hoursSinceUpdate !== null && hoursSinceUpdate >= 24 && !lead.final_status;
  const isStale = days !== null && days > 7 && !lead.final_status;
  const isCrit = days !== null && days >= 14 && !lead.final_status;
  const isHot = lead.lead_status === "hot";
  const isWon = lead.final_status === "won";
  const isLost = lead.final_status === "lost";

  return (
    <div
      draggable
      onDragStart={(e) => {
        (e.currentTarget as HTMLElement).classList.add("opacity-40");
        onDragStart(e, lead.id);
      }}
      onDragEnd={(e) => {
        (e.currentTarget as HTMLElement).classList.remove("opacity-40");
      }}
      onClick={() => onLeadClick(lead.id)}
        className={cn(
        "p-3 rounded-lg border bg-muted/60 cursor-grab active:cursor-grabbing transition-all duration-150 select-none",
        "hover:bg-muted/80 hover:border-border",
        "group relative",
        isHot && "ring-1 ring-slate-600/30",
        isInactive24h && !isStale && "ring-1 ring-amber-500/20",
        isCrit ? "ring-2 ring-red-500/40" : isStale ? "ring-1 ring-amber-500/30" : "border-border",
        isWon && "border-emerald-700/50 bg-emerald-950/20",
        isLost && "border-border/30 bg-muted/40",
      )}
    >
      {/* Drag handle - always visible */}
      <div className="absolute top-1 right-1 opacity-40 group-hover:opacity-80 transition-opacity pointer-events-none">
        <GripVertical className="w-4 h-4 text-muted-foreground" />
      </div>

      {/* Customer name */}
      <div className="flex items-center gap-1.5 mb-1.5 pr-4">
        {isHot && <span className="text-[10px]">🔥</span>}
        <span className="text-sm font-medium text-foreground truncate flex-1">
          {lead.customer_name || t("common.unnamed")}
        </span>
        {lead.lead_status && (
          <span className="text-[9px]">{STATUS_EMOJIS[lead.lead_status]}</span>
        )}
      </div>

      {/* Value & Probability */}
      <div className="flex items-center gap-2 mb-1.5">
        {lead.quotation_value != null && lead.quotation_value > 0 && (
          <span className="text-xs font-semibold text-copper-400">{fmtAED(lead.quotation_value)}</span>
        )}
        {lead.win_probability != null && (
          <span className={cn("text-[10px] font-medium",
            lead.win_probability >= 70 ? "text-emerald-400" :
            lead.win_probability >= 30 ? "text-amber-400" : "text-muted-foreground"
          )}>
            {lead.win_probability}%
          </span>
        )}
      </div>

      {/* Next action */}
      {lead.next_action && (
        <p className="text-[10px] text-muted-foreground truncate mb-1">📋 {lead.next_action}</p>
      )}

      {/* Footer: assigned + stale days */}
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span className="flex items-center gap-0.5 truncate">
          <User className="w-2.5 h-2.5 shrink-0" />
          <span className="truncate">{lead.rep_name || (salesUsers.find(u => u.id === lead.assigned_to)?.full_name) || "—"}</span>
        </span>
        {days !== null && !isWon && !isLost && (
          <span className={cn("flex items-center gap-1",
            isCrit ? "text-red-400 font-semibold" : isStale ? "text-amber-400" : "text-muted-foreground"
          )}>
            {isInactive24h && !isStale && <Clock className="w-2.5 h-2.5" />}
            {days}d
          </span>
        )}
        {isInactive24h && !isStale && days === null && (
          <span className="text-amber-400 text-[10px] flex items-center gap-0.5"><Clock className="w-2.5 h-2.5" />24h</span>
        )}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════ */
export default function PipelinePage() {
  const supabase = createClient();
  const router = useRouter();
  const { t } = useLanguage();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [role, setRole] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [salesUsers, setSalesUsers] = useState<any[]>([]);
  const [showEmptyStages, setShowEmptyStages] = useState(true);
  const [activeStageKey, setActiveStageKey] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  // ─── Infrastructure hooks ───
  const { isValidTransition, getValidTransitions } = useStageGuard();
  const { onDragStart, onDragOver, onDragLeave, onDragEnter, onDrop, draggingLeadId, draggingOverStage } = usePipelineDragDrop(leads, setLeads, userId);

  // Get current user and role
  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return;
      setUserId(user.id);
      supabase.from("profiles").select("role").eq("id", user.id).single()
        .then(({ data }) => setRole(data?.role ?? "sales"));
    });
  }, []);

  // Fetch sales users for name lookup
  useEffect(() => {
    supabase.from("profiles").select("id,email,role,full_name").in("role", ["admin", "sales", "operator", "boss"]).then(({ data }) => {
      if (data) setSalesUsers(data);
    });
  }, []);

  // ─── KPI Performance for Sales ───
  interface KpiTarget { id: string; period: string; target_type: string; target_amount: number; assigned_to: string | null; }
  const [kpiTargets, setKpiTargets] = useState<KpiTarget[]>([]);
  const [kpiLoading, setKpiLoading] = useState(false);
  const [kpiSigningActual, setKpiSigningActual] = useState(0);
  const [kpiCollectionActual, setKpiCollectionActual] = useState(0);
  const [kpiContractCount, setKpiContractCount] = useState(0);

  useEffect(() => {
    if (role !== "sales" || !userId) return;
    const period = new Date().toISOString().slice(0, 7);
    setKpiLoading(true);

    Promise.all([
      // 1. Fetch KPI targets for this sales person
      supabase.from("kpi_targets").select("*").eq("period", period).eq("assigned_to", userId),
      // 2. Fetch contracts for this sales person
      supabase.from("contracts").select("id,contract_amount,status").eq("sales_id", userId),
      // 3. Fetch payments for this sales person's contracts
      supabase.from("payments").select("amount,confirmed,contract_id"),
    ]).then(([tRes, cRes, pRes]) => {
      if (tRes.data) setKpiTargets(tRes.data as KpiTarget[]);

      if (cRes.data) {
        const active = (cRes.data as any[]).filter(c => c.status !== "terminated");
        const totalSigning = active.reduce((sum: number, c: any) => sum + (c.contract_amount || 0), 0);
        setKpiSigningActual(totalSigning);
        setKpiContractCount(active.length);

        // Collection: payments where confirmed=true for this user's contracts
        if (pRes.data) {
          const contractIds = new Set((cRes.data as any[]).map(c => c.id));
          const confirmedPayments = (pRes.data as any[])
            .filter(p => p.confirmed === true && contractIds.has(p.contract_id));
          const totalCollected = confirmedPayments.reduce((sum: number, p: any) => sum + (p.amount || 0), 0);
          setKpiCollectionActual(totalCollected);
        }
      }

      setKpiLoading(false);
    }).catch(() => setKpiLoading(false));
  }, [role, userId, supabase]);

  // Resolve KPI targets
  const kpiSigningTarget = kpiTargets.find(t => t.target_type === "signing")?.target_amount || 0;
  const kpiCollectionTarget = kpiTargets.find(t => t.target_type === "collection")?.target_amount || 0;
  const kpiSigningPct = kpiSigningTarget > 0 ? Math.round((kpiSigningActual / kpiSigningTarget) * 100) : null;
  const kpiCollectionPct = kpiCollectionTarget > 0 ? Math.round((kpiCollectionActual / kpiCollectionTarget) * 100) : null;

  // Keyboard navigation for kanban board
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const container = scrollContainerRef.current;
        if (!container) return;
        e.preventDefault();
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        container.scrollBy({ left: dir * 310, behavior: 'smooth' });
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const fmtAED = (v: number) => v >= 1_000_000 ? `AED ${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `AED ${(v / 1_000).toFixed(0)}K` : `AED ${v.toLocaleString()}`;
  const kpiPctColor = (v: number | null) => {
    if (v === null) return "text-muted-foreground";
    if (v >= 100) return "text-emerald-400";
    if (v >= 50) return "text-amber-400";
    return "text-rose-400";
  };

  // Fetch leads
  useEffect(() => {
    if (!userId || !role) return;
    (async () => {
      let q = supabase.from("leads").select("*").limit(500);
      if (role === "sales") q = q.eq("assigned_to", userId);
      const { data, error: err } = await q;
      if (err) {
        console.error("Failed to fetch leads:", err);
        setError(t("kpi.loadFailed"));
        setLoading(false);
        return;
      }
      if (data) setLeads(data as Lead[]);
      setLoading(false);
    })();
  }, [userId, role]);

  // Group leads by stage
  const columns = useMemo(() => {
    const g: Record<string, Lead[]> = {};
    for (const s of STAGES) g[s.key] = [];
    // won/lost now live in final_status; fall back to stage for the dual-source transition
    for (const l of leads) { const key = l.final_status || l.stage; if (g[key]) g[key].push(l); }
    return g;
  }, [leads]);

  // Write business event helper
  async function writeEvent(leadId: string, eventType: string, description: string, eventData?: Record<string, any>) {
    const uid = (await supabase.auth.getUser()).data.user?.id;
    await supabase.from("business_events").insert({
      lead_id: leadId, event_type: eventType, description, event_data: eventData || {},
      user_id: uid,
    });
  }



  if (loading && role !== "sales") return <div className="text-center py-16 text-muted-foreground">{t("common.loading")}</div>;
  if (error && role !== "sales") return <ErrorState message={error} onRetry={() => window.location.reload()} />;

  // ─── Sales KPI Dashboard ───
  if (role === "sales") {
    return (
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight flex items-center gap-2">
            <Target className="w-6 h-6 text-copper-400" />
            {t("kpi.title")}
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {new Date().toISOString().slice(0, 7)} {t("kpi.subtitle")}
            {kpiLoading && <span className="ml-2 text-[10px] text-muted-foreground animate-pulse">{t("common.loading")}</span>}
          </p>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          {/* Signing KPI */}
          <div className="rounded-xl border border-border/50 bg-card/50 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-copper-400" />
                <span className="text-sm font-semibold text-foreground">{t("kpi.signing")}</span>
              </div>
              <span className="text-xs text-muted-foreground">{kpiContractCount} {t("kpi.contracts")}</span>
            </div>
            <div className="text-center">
              <p className={cn("text-4xl font-bold leading-none", kpiPctColor(kpiSigningPct))}>
                {kpiSigningPct !== null ? `${kpiSigningPct}%` : "—"}
              </p>
              <p className="text-xs text-muted-foreground mt-2">
                {fmtAED(kpiSigningActual)} / {kpiSigningTarget > 0 ? fmtAED(kpiSigningTarget) : t("kpi.noTargetSet")}
              </p>
            </div>
            <div className="h-2.5 bg-muted rounded-full overflow-hidden">
              <div
                className={cn("h-full rounded-full transition-all duration-700", kpiSigningPct !== null && kpiSigningPct >= 100 ? "bg-emerald-500" : kpiSigningPct !== null && kpiSigningPct >= 50 ? "bg-amber-500" : "bg-rose-500")}
                style={{ width: `${Math.min(kpiSigningPct ?? 0, 100)}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{t("kpi.target")}: {kpiSigningTarget > 0 ? fmtAED(kpiSigningTarget) : "—"}</span>
              <span>{t("kpi.actual")}: {fmtAED(kpiSigningActual)}</span>
            </div>
          </div>

          {/* Collection KPI */}
          <div className="rounded-xl border border-border/50 bg-card/50 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Wallet className="w-5 h-5 text-emerald-400" />
                <span className="text-sm font-semibold text-foreground">{t("kpi.collection")}</span>
              </div>
              {kpiCollectionPct !== null && kpiCollectionPct >= 100 && (
                <CheckCircle2 className="w-5 h-5 text-emerald-400" />
              )}
            </div>
            <div className="text-center">
              <p className={cn("text-4xl font-bold leading-none", kpiPctColor(kpiCollectionPct))}>
                {kpiCollectionPct !== null ? `${kpiCollectionPct}%` : "—"}
              </p>
              <p className="text-xs text-muted-foreground mt-2">
                {fmtAED(kpiCollectionActual)} / {kpiCollectionTarget > 0 ? fmtAED(kpiCollectionTarget) : t("kpi.noTargetSet")}
              </p>
            </div>
            <div className="h-2.5 bg-muted rounded-full overflow-hidden">
              <div
                className={cn("h-full rounded-full transition-all duration-700", kpiCollectionPct !== null && kpiCollectionPct >= 100 ? "bg-emerald-500" : kpiCollectionPct !== null && kpiCollectionPct >= 50 ? "bg-amber-500" : "bg-rose-500")}
                style={{ width: `${Math.min(kpiCollectionPct ?? 0, 100)}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{t("kpi.target")}: {kpiCollectionTarget > 0 ? fmtAED(kpiCollectionTarget) : "—"}</span>
              <span>{t("kpi.actual")}: {fmtAED(kpiCollectionActual)}</span>
            </div>
          </div>
        </div>

        {/* Detail breakdown */}
        <div className="rounded-xl border border-border/50 p-5">
          <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
            <DollarSign className="w-4 h-4 text-copper-400" />
            {t("kpi.detailData")}
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="p-4 rounded-lg bg-muted/30">
              <p className="text-xs text-muted-foreground">{t("kpi.contractCount")}</p>
              <p className="text-xl font-bold text-foreground mt-1">{kpiContractCount}</p>
            </div>
            <div className="p-4 rounded-lg bg-muted/30">
              <p className="text-xs text-muted-foreground">{t("kpi.totalSigning")}</p>
              <p className="text-xl font-bold text-copper-400 mt-1">{fmtAED(kpiSigningActual)}</p>
            </div>
            <div className="p-4 rounded-lg bg-muted/30">
              <p className="text-xs text-muted-foreground">{t("kpi.totalCollected")}</p>
              <p className="text-xl font-bold text-emerald-400 mt-1">{fmtAED(kpiCollectionActual)}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── Kanban Board (for management) ───

  // Summary stats
  const pipelineStages = STAGES.filter(s => s.key !== "won" && s.key !== "lost");
  const totalActive = pipelineStages.reduce((sum, s) => sum + (columns[s.key]?.length || 0), 0);
  const totalValue = pipelineStages.reduce((sum, s) => sum + (columns[s.key]?.reduce((v, l) => v + (l.quotation_value || 0), 0) || 0), 0);

  return (
    // T2-1: dashboard 滚动边界. pipeline 不让 page-level 滚动 — 让内部
    // kanban 用 flex-1 撑满可用空间并独立滚动. 这样消除 calc(100vh - Xpx).
    <DashboardScrollContainer className="flex flex-col gap-4" variant="contained" as="div">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight">{t("pipeline.title")}</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {t("pipeline.nActive").replace("{n}", String(totalActive))} · {t("pipeline.pipelineLabel")} {fmtAED(totalValue)}
            {role === "sales" && <span className="ml-2 text-[10px] text-copper-400">{t("kpi.onlyYourLeads")}</span>}
            {updating && <span className="ml-2 text-[10px] text-amber-400">{t("common.saving")}</span>}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowEmptyStages(!showEmptyStages)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded border border-border/40 hover:border-border"
          >
            {showEmptyStages ? t("pipeline.hideEmpty") : t("pipeline.showEmpty")}
          </button>
          <button onClick={() => router.push("/leads/new")}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/85 transition-colors">
            <Plus className="w-3.5 h-3.5" />{t("common.create")}
          </button>
        </div>
      </div>

      {/* Stage totals bar — unified KanbanStats unit (T2-2) */}
      <KanbanStats
        leads={leads}
        activeStageKey={activeStageKey}
        onStageClick={(k) => {
          const el = document.getElementById(`stage-${k}`);
          if (el) el.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
        }}
      />

      {/* ═══════ Kanban Board ═══════ */}
      {/* T2-1: flex-1 + min-h-0 lets the kanban fill the remaining
          DashboardScrollContainer space without calc(100vh - 280px). */}
      <div className="relative flex-1 min-h-0">
        {/* Left arrow button */}
        <button
          onClick={() => scrollContainerRef.current?.scrollBy({ left: -310, behavior: 'smooth' })}
          className="absolute left-2 top-1/2 -translate-y-1/2 z-20 bg-background/80 rounded-full p-1.5 shadow hover:bg-background"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        {/* Right arrow button */}
        <button
          onClick={() => scrollContainerRef.current?.scrollBy({ left: 310, behavior: 'smooth' })}
          className="absolute right-2 top-1/2 -translate-y-1/2 z-20 bg-background/80 rounded-full p-1.5 shadow hover:bg-background"
        >
          <ChevronRight className="w-4 h-4" />
        </button>

        {/* T2-1: scroll container is now h-full — no more calc(100vh - 280px).
            min-h-0 lets the flex child shrink; scrollbar-visible is preserved. */}
        <div
          ref={scrollContainerRef}
          className="h-full overflow-x-auto overflow-y-auto snap-x snap-mandatory scrollbar-visible"
          style={{ scrollBehavior: 'smooth' }}
        >
          {/* T2-1: h-full lets columns fill the kanban row, which fills the
              DashboardScrollContainer. No more minHeight: 100%. */}
          <div className="flex gap-3 min-w-max px-10 pb-4 h-full">
            {(() => {
              // Filter stages: always show won/lost, others based on showEmptyStages
              const visibleStages = STAGES.filter(s => {
                if (s.key === 'won' || s.key === 'lost') return true;
                if (showEmptyStages) return true;
                return (columns[s.key]?.length || 0) > 0;
              });

              return visibleStages.map((stage) => {
                const items = columns[stage.key] || [];
                const isOver = draggingOverStage === stage.key;
                const isWon = stage.key === "won";
                const isLost = stage.key === "lost";

                return (
                  <div
                    key={stage.key}
                    id={`stage-${stage.key}`}
                    onDragEnter={() => onDragEnter(stage.key)}
                    onDragOver={(e) => onDragOver(e, stage.key)}
                    onDragLeave={() => onDragLeave(stage.key)}
                    onDrop={(e) => onDrop(e, stage.key)}
                    className={cn(
                      // T2-1: h-full lets the column fill the kanban row,
                      // which in turn fills the DashboardScrollContainer.
                      "h-full flex flex-col w-[300px] shrink-0 rounded-xl border transition-all duration-150 snap-start",
                      stage.bg, stage.border,
                      isOver && "ring-2 ring-copper-500/50 border-copper-500/30 scale-[1.01]",
                      isWon && "bg-emerald-950/10",
                      isLost && "bg-muted/20",
                    )}
                  >
                    {/* Column header */}
                    <div className="flex items-center justify-between px-3 py-2.5 border-b border-inherit/30 sticky top-0 z-10">
                      <div className="flex items-center gap-2">
                        <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: stage.color }} />
                        <span className="text-sm font-semibold text-foreground">{t(stage.labelKey as any)}</span>
                        <span className="text-xs text-muted-foreground bg-background/30 px-1.5 py-0.5 rounded-full">
                          {items.length}
                        </span>
                      </div>
                      {!isWon && !isLost && (
                        <button
                          onClick={() => router.push(`/leads?stage=${stage.key}`)}
                          className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                          title={t("pipeline.viewAllInStage")}
                        >
                          <Plus className="w-3 h-3" />
                        </button>
                      )}
                    </div>

                    {/* T2-1: Cards container — flex-1 + min-h-0 lets it fill the
                        column (which is now h-full). No more max-h-[calc(100vh-360px)]. */}
                    <div className={cn(
                      "flex-1 min-h-0 p-2 space-y-2 overflow-y-auto transition-colors rounded-b-xl",
                      isOver && "bg-copper-500/5",
                    )}>
                      {/* Empty state */}
                      {items.length === 0 && (
                        <div className="flex items-center justify-center h-24">
                          <span className="text-xs text-muted-foreground/30">{t("pipeline.dropLeadsHere")}</span>
                        </div>
                      )}

                      {/* Cards */}
                      {items.map((lead) => (
                        <LeadCard key={lead.id} lead={lead} onDragStart={onDragStart} onLeadClick={(id) => router.push(`/leads/${id}`)} salesUsers={salesUsers} />
                      ))}
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        </div>
      </div>
    </DashboardScrollContainer>
  );
}
