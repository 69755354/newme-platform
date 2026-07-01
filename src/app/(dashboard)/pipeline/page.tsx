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
  Users, DollarSign, TrendingDown, Target, AlertTriangle,
  Plus,
  ChevronLeft, ChevronRight,
} from "lucide-react";
import { usePipelineDragDrop } from "@/shared/hooks/usePipelineDragDrop";
import { useStageGuard } from "@/shared/hooks/useStageGuard";
import { useSupabaseQuery } from "@/lib/supabaseQuery";
import KanbanStats from "@/components/pipeline/KanbanStats";
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";
import { LeadCard } from "./_components/LeadCard";
import type { Lead } from "./_components/LeadCard";
import { SalesKpiDashboard } from "./_components/SalesKpiDashboard";

/* ─── Types ─── */
// Lead interface is exported from ./_components/LeadCard (T3-3 step 1)

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

  // ─── Sales KPI Performance ───
  // KPI fetch + derived values moved to ./useSalesKpiData (T3-3 step 2).
  // The dashboard component below is mounted only when role === "sales".

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

  // ─── Sales KPI Dashboard (T3-3 step 2: extracted to ./SalesKpiDashboard) ───
  if (role === "sales") {
    return <SalesKpiDashboard currentUserId={userId} />;
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
