"use client";

import { useEffect, useState, useRef } from "react";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { ErrorState } from "@/components/ui/error-state";
import { createClient } from "@/lib/supabase";
import { usePipelineDragDrop } from "@/shared/hooks/usePipelineDragDrop";
import { useStageGuard } from "@/shared/hooks/useStageGuard";
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";
import { SalesKpiDashboard } from "./_components/SalesKpiDashboard";
import { KanbanBoard } from "./_components/KanbanBoard";
import type { Lead } from "./_components/LeadCard";

/* ─── Types ─── */
// Lead interface is exported from ./_components/LeadCard (T3-3 step 1)

/* ════════════════════════════════════════ */
export default function PipelinePage() {
  const supabase = createClient();
  const { t } = useLanguage();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [role, setRole] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [salesUsers, setSalesUsers] = useState<any[]>([]);
  const [showEmptyStages, setShowEmptyStages] = useState(true);
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

  // ─── Kanban Board (T3-3 step 3: extracted to ./KanbanBoard) ───

  // Summary stats — recomputed here so the header subtitle stays correct.
  // The kanban board itself does its own per-column grouping internally.
  const STAGE_KEYS_FOR_TOTALS = ["new", "contacted", "requirement_confirmed", "solution_submitted", "quotation_submitted", "negotiation", "pending_decision"] as const;
  const byStage = (() => {
    const g: Record<string, Lead[]> = {};
    for (const k of STAGE_KEYS_FOR_TOTALS) g[k] = [];
    for (const l of leads) {
      const key = l.final_status || l.stage;
      if (g[key]) g[key].push(l);
    }
    return g;
  })();
  const totalActive = STAGE_KEYS_FOR_TOTALS.reduce((sum, k) => sum + (byStage[k]?.length || 0), 0);
  const totalValue = STAGE_KEYS_FOR_TOTALS.reduce((sum, k) => sum + (byStage[k]?.reduce((v, l) => v + (l.quotation_value || 0), 0) || 0), 0);

  return (
    // T2-1: dashboard 滚动边界. pipeline 不让 page-level 滚动 — 让内部
    // kanban 用 flex-1 撑满可用空间并独立滚动. 这样消除 calc(100vh - Xpx).
    <DashboardScrollContainer className="flex flex-col" variant="contained" as="div">
      <KanbanBoard
        leads={leads}
        salesUsers={salesUsers}
        scrollContainerRef={scrollContainerRef}
        draggingLeadId={draggingLeadId}
        draggingOverStage={draggingOverStage}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        showEmptyStages={showEmptyStages}
        onToggleEmptyStages={() => setShowEmptyStages(!showEmptyStages)}
        totalActive={totalActive}
        totalValue={totalValue}
        isSales={false}
        isUpdating={updating}
      />
    </DashboardScrollContainer>
  );
}