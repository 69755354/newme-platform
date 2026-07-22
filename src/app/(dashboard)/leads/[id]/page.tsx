"use client";

// Lead Detail — three-column layout (PRD v3.2). After T3-3 step 11, the page
// is a thin orchestrator: state is owned by useLeadDetailData + useLeadDetailMutations,
// UI/state for local presentation (noteText, openPanel, showQuoteCalculator,
// salesRole, currentUserId) stays here. All fetch logic (the P0-1 batched
// fetchData) and every mutation handler live in the two hooks; this file
// owns imports + Effect composition + render closures + JSX shell.
//
// Layout:  Left (3/12) CustomerProfile · Middle (5/12) SalesProcess · Right (4/12) Timeline
//          Bottom: LeadFoldingPanel (6 accordion blocks).

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { useSupabaseQuery } from "@/lib/supabaseQuery";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, fmtDubai } from "@/lib/utils";
import { Toaster, toast } from "sonner";
import { ArrowLeft, Trash2 } from "lucide-react";
import QuoteCalculator from "@/app/(dashboard)/quotes/quote-calculator";
import KnxDesignPanel from "@/components/knx-design-panel";
import LeadCustomerProfile from "./LeadCustomerProfile";
import LeadSalesProcess from "./LeadSalesProcess";
import LeadTimeline from "./LeadTimeline";
import LeadFoldingPanel from "./LeadFoldingPanel";
import { useLeadDetailData } from "./useLeadDetailData";
import { useLeadDetailMutations } from "./useLeadDetailMutations";
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";
import type {
  RenderInlineEdit,
  RenderDateEdit,
  RenderJsonEdit,
  LeadJsonField,
  LeadTextField,
} from "./types";
import type { Json } from "@/types/database";

const INLINE_EDIT_FIELDS = new Set<string>([
  "customer_name", "phone", "email", "location", "emirate", "area",
  "expected_sign_date", "customer_budget",
]);
const JSON_EDIT_FIELDS = new Set<string>(["smart_requirements", "raw_import_data", "devices_json"]);
const DATE_EDIT_FIELDS = new Set<string>(["expected_sign_date", "decision_date", "last_contact_date"]);

function isInlineEditField(field: string): field is LeadTextField | "customer_budget" {
  return INLINE_EDIT_FIELDS.has(field);
}

function isJsonEditField(field: string): field is LeadJsonField {
  return JSON_EDIT_FIELDS.has(field);
}

function isDateEditField(field: string): field is import("./types").LeadDateField {
  return DATE_EDIT_FIELDS.has(field);
}

function isJsonValue(value: unknown): value is Json {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") return Object.values(value).every(isJsonValue);
  return false;
}

function parseJsonInput(value: string): Json | null {
  if (!value.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isJsonValue(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

declare global {
  interface Window {
    fbq?: (...args: unknown[]) => void;
  }
}

export default function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const supabase = createClient();
  const { t, lang } = useLanguage();

  // ─── Data hook (P0-1 fetchData lives here) ───────────────────────────────
  const {
    lead,
    setLead,
    activities,
    events,
    chatMessages,
    nextTask,
    leadTrace,
    transferHistory,
    followUpLogs,
    leadMilestones,
    salesUsers,
    projectInfoDraft,
    setProjectInfoDraft,
    loading,
    error,
    fetchData,
  } = useLeadDetailData(id as string);

  // ─── Page-local state for Meta Pixel effect + Mut block ──────────────────
  // currentUserId: needed by handleDelete guard + the canDelete UI; auth.getUser()
  // doesn't fit useSupabaseQuery's PostgrestError contract, so we keep it in a
  // small useEffect that mirrors the original L307-318 fetch exactly.
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) setCurrentUserId(user.id);
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Query 1 (T1-8): current user profile role — drives handleDelete guard.
  // Replaces the original inline supabase.from("profiles").select("role") block.
  // Behaviour 100% equivalent to original L307-318:
  //   - maybeSingle + non-fatal warn on error
  //   - missing profile OR missing role → falls back to "sales"
  //   - non-null role → use as-is
  // The default "sales" fallback is critical: handleDelete's canDelete gate
  // relies on salesRole === "sales" matching the assigned_to check, so a
  // transient profile-fetch failure must NOT collapse the gate to null.
  const profileRoleQuery = useSupabaseQuery<{ role: string } | null>(
    async () => {
      if (!currentUserId) return { data: null, error: null };
      return await supabase
        .from("profiles")
        .select("role")
        .eq("id", currentUserId)
        .maybeSingle();
    },
    [currentUserId],
    { enabled: !!currentUserId, retry: 1 }
  );
  // 3-way state: "admin"/"boss"/"sales" once resolved, "sales" on error/missing
  // (matches original setSalesRole(profile?.role || "sales")), null while loading.
  const salesRole: string | null = profileRoleQuery.isSuccess
    ? (profileRoleQuery.data?.role || "sales")
    : (profileRoleQuery.isError ? "sales" : null);

  // ── Query 2 (T1-8): assignee profile — enriches header subtitle when the
  // lead row has assigned_to but no embedded rep_name. Falls back gracefully
  // when the assignee profile is missing (preserves "lead.rep_name || ...").
  const assignedToId = lead?.assigned_to ?? null;
  const assignedToQuery = useSupabaseQuery<{ full_name: string | null; role: string | null } | null>(
    async () => {
      if (!assignedToId) return { data: null, error: null };
      return await supabase
        .from("profiles")
        .select("full_name, role")
        .eq("id", assignedToId)
        .maybeSingle();
    },
    [assignedToId],
    { enabled: !!assignedToId, retry: 1 }
  );
  const assignedToName = assignedToQuery.data?.full_name?.trim() || null;

  // ── Query 3 (T1-8): creator profile — used in header subtitle as
  // "Created by <name>" enrichment. Mirrors the lead.created_at line already
  // rendered; gracefully degrades when creator profile is missing.
  const createdById = lead?.created_by ?? null;
  const creatorQuery = useSupabaseQuery<{ full_name: string | null } | null>(
    async () => {
      if (!createdById) return { data: null, error: null };
      return await supabase
        .from("profiles")
        .select("full_name")
        .eq("id", createdById)
        .maybeSingle();
    },
    [createdById],
    { enabled: !!createdById, retry: 1 }
  );
  const creatorName = creatorQuery.data?.full_name?.trim() || null;

  // ─── Mutations hook (12 handlers + UI state) ─────────────────────────────
  const {
    updating,
    editField,
    setEditField,
    editValue,
    setEditValue,
    showSalesDropdown,
    setShowSalesDropdown,
    reassigning,
    markingPoor,
    setMarkingPoor,
    poorReasonText,
    setPoorReasonText,
    projectInfoStatus,
    reassignSales,
    handleDelete,
    handleMarkPoor,
    updateField,
    saveProjectInfo,
    resetProjectInfoDraft,
    updateNextTask,
    handleWon,
    handleLost,
    addNote,
    toggleMilestone,
    reopenMilestone,
    addStructuredContact,
  } = useLeadDetailMutations({
    leadId: id as string,
    lead,
    nextTask,
    setLead,
    projectInfoDraft,
    setProjectInfoDraft,
    fetchData,
    salesRole,
    currentUserId,
    salesUsers,
    t,
    lang,
  });

  // ─── Page-local UI state (presentation only, not mutations) ─────────────
  const [noteText, setNoteText] = useState("");
  const [openPanel, setOpenPanel] = useState<string | null>(null);
  const [showQuoteCalculator, setShowQuoteCalculator] = useState(false);

  // LeadTimeline expects `onAddNote: () => void`. The hook accepts noteText as
  // a callback argument; we close over `noteText` here so the LeadTimeline call
  // site stays unchanged from the original page.
  const handleAddNote = () => { void addNote(noteText); };

  // ─── Meta Pixel: track ViewContent when lead data loads ─────────────────
  useEffect(() => {
    if (lead && typeof window !== "undefined" && window.fbq) {
      // Privacy-safe: only non-PII fields (no customer_name, no quotation_value)
      window.fbq("track", "ViewContent", {
        content_ids: [id],
        content_type: "smart_home_lead",
        content_category: lead.stage || undefined,
      });
    }
  }, [lead, id]);

  function openQuoteCalculator() {
    setShowQuoteCalculator(true);
  }
  // Create-contract shortcut — only reachable when final_status === "won"
  // (the SalesProcess column gates the button).
  function handleCreateContract() {
    if (!lead) return;
    const params = new URLSearchParams({ lead_id: lead.id });
    router.push(`/contracts/new?${params.toString()}`);
  }
  // Open the KNX design panel: scroll the embedded panel into view and trigger
  // its first button (same DOM-driven approach as the previous Overview tab).
  function handleGenerateKnx() {
    if (typeof document === "undefined") return;
    const knxPanel = document.querySelector("[data-knx-panel]");
    if (knxPanel) {
      knxPanel.scrollIntoView({ behavior: "smooth" });
      const btn = knxPanel.querySelector("button");
      if (btn) btn.click();
    }
  }

  const commitInlineEdit = () => {
    if (!editField || !lead) return;

    if (!isInlineEditField(editField)) return;
    const field = editField;
    const nextValue = editValue.trim();
    const currentValue = String(lead[field] ?? "");
    if (nextValue === currentValue) {
      setEditField(null);
      return;
    }

    if (field === "customer_budget") {
      if (nextValue && !Number.isFinite(Number(nextValue))) {
        toast.error("Customer Budget must be a number");
        return;
      }
      updateField(field, nextValue ? Number(nextValue) : null, "note_added", "Customer Budget: " + nextValue);
    } else {
      updateField(field, nextValue, "note_added", field + ": " + nextValue);
    }
    setEditField(null);
  };

  const commitNextAction = () => {
    const nextValue = editValue.trim();
    if (nextValue && nextValue !== (nextTask?.title || "")) {
      updateNextTask({ title: nextValue });
    }
    setEditField(null);
  };

  // ─── Render helpers (page-owned so a single inline edit is active at a time) ───
  const renderInlineEdit: RenderInlineEdit = (field, label, type = "text") => {
    if (!lead || !isInlineEditField(field)) return null;
    const value = lead[field];
    return editField === field ? (
      // BUG-LD-3 (2026-07-06): wrap the input in a click-eating span so a click
      // outside the input (or on the span's padding) first clears editField via
      // the onBlur handler before any ancestor click handler can fire. Without
      // this, clicking elsewhere (e.g. a sidebar action) leaves the input open
      // and the edit feels "stuck".
      <span
        className="block"
        // Stop click events from bubbling up to the parent Card/click-area
        // overlay that handles other UI affordances.
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitInlineEdit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
            if (e.key === "Escape") setEditField(null);
          }}
          className="flex-1 w-full h-8 text-xs bg-muted border border-border rounded px-2 text-foreground"
        />
      </span>
    ) : (
      <p className="text-foreground mt-1 cursor-pointer hover:text-copper-400"
        onClick={() => { setEditField(field); setEditValue(String(value ?? "")); }}>
        {value ? String(value) : <span className="text-gray-600">{t("leadDetail.placeholderClickToFill")}</span>}
      </p>
    );
  };

  const renderDateEdit: RenderDateEdit = (field, label) => {
    if (!lead || !isDateEditField(field)) return null;
    const value = lead[field];
    return editField === field ? (
      <input type="date" autoFocus value={editValue} onChange={(e) => setEditValue(e.target.value)}
        onBlur={() => { updateField(field, editValue || null, "note_added", `${label}: ${editValue || t("leadDetail.cleared")}`); }}
        className="w-full h-8 text-xs bg-muted border border-border rounded px-2 text-foreground mt-1" />
    ) : (
      <p className="text-foreground mt-1 cursor-pointer hover:text-copper-400"
        onClick={() => { setEditField(field); setEditValue(value || ""); }}>
        {value ? fmtDubai(value, { locale: t("locale.dateLocale") }) : <span className="text-gray-600">{t("leadDetail.placeholderClickToFill")}</span>}
      </p>
    );
  };

  const renderJsonEdit: RenderJsonEdit = (field, label) => {
    if (!lead || !isJsonEditField(field)) return null;
    const value = lead[field];
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
              const parsed = parseJsonInput(editValue);
              if (parsed === null && editValue.trim()) {
                toast.error("Enter valid JSON");
                return;
              }
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
  };

  // Next Required Action — date + title editors bound to nextTask (creates a task
  // when none exists via updateNextTask). Mirrors the old Details-tab editors.
  const renderNextFollowupDate = () =>
    editField === "next_followup_date" ? (
      <input type="date" autoFocus value={editValue} onChange={(e) => setEditValue(e.target.value)}
        onBlur={() => { if (editValue) updateNextTask({ due_at: editValue }); }}
        className="w-full h-8 text-xs bg-muted border border-border rounded px-2 text-foreground mt-1" />
    ) : (
      <p className={cn("mt-1 cursor-pointer hover:text-copper-400", !nextTask ? "text-rose-400 font-medium" : "text-foreground")}
        onClick={() => { setEditField("next_followup_date"); setEditValue(nextTask?.due_at.slice(0, 10) || ""); }}>
        {nextTask ? fmtDubai(nextTask.due_at, { locale: t("locale.dateLocale") }) : t("leadDetail.placeholderRequired")}
      </p>
    );

  const renderNextAction = () =>
    editField === "next_action" ? (
      <div className="flex gap-1 mt-1">
        <input autoFocus value={editValue} onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitNextAction}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
            if (e.key === "Escape") setEditField(null);
          }}
          className="flex-1 h-8 text-xs bg-muted border border-border rounded px-2 text-foreground" />
      </div>
    ) : (
      <p className={cn("mt-1 cursor-pointer hover:text-copper-400", !nextTask ? "text-rose-400 font-medium" : "text-foreground")}
        onClick={() => { setEditField("next_action"); setEditValue(nextTask?.title || ""); }}>
        {nextTask?.title || t("leadDetail.placeholderRequired")}
      </p>
    );

  // ═══════════════ MAIN RENDER ═══════════════
  if (loading) {
    return (
      <div className="max-w-7xl space-y-6">
        {/* Header skeleton */}
        <div className="flex items-center gap-4">
          <div className="h-10 w-10 rounded-lg bg-muted animate-pulse" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-48" />
          </div>
        </div>

        {/* Three-column skeleton */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <aside className="lg:col-span-3 space-y-4">
            <div className="rounded-lg border border-border bg-card p-4 space-y-3">
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          </aside>

          <main className="lg:col-span-5 space-y-4">
            <div className="rounded-lg border border-border bg-card p-4 space-y-3">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-4 w-full" />
            </div>
          </main>

          <aside className="lg:col-span-4 space-y-4">
            <div className="rounded-lg border border-border bg-card p-4 space-y-3">
              <Skeleton className="h-6 w-36" />
              <Skeleton className="h-48 w-full" />
            </div>
          </aside>
        </div>
      </div>
    );
  }

  if (error) {
    return <ErrorState message={error} onRetry={() => window.location.reload()} />;
  }

  if (!lead) {
    return (
      <div className="text-center py-16">
        <p className="text-muted-foreground">{t("common.notFound")}</p>
      </div>
    );
  }

  return (
    <DashboardScrollContainer className="mx-auto max-w-[1600px] space-y-5 pb-8">
      {/* T2-4: 锚定 Header — 整页滚动时返回按钮/客户名/状态徽章/delete 永远可见
          注意：leads/[id] 不像 leads/page.tsx 包了 DashboardScrollContainer，
          这里是外层 viewport 滚动。sticky 元素 (page-title z-20) 仍能锚定到 viewport 顶部。
          BUG-LD-2 (2026-07-06): removed backdrop-blur-sm + reduced opacity to bg-background/70.
          Previous bg-background/95 + backdrop-blur-sm was visually opaque and overlapped
          the top of the lead content when scrolled, hiding the click-action area. */}
      <div
        data-sticky-region="page-title"
        className="sticky top-0 z-20 flex items-center gap-4 rounded-xl border border-border bg-card/95 px-4 py-3 shadow-sm"
      >
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
            {lead.quality === 'poor' && (
              <span className="text-xs px-2 py-0.5 rounded bg-red-500/10 text-red-400">
                ⚠️ {t("leads.poorLead")}{lead.poor_reason && `: ${lead.poor_reason}`}
              </span>
            )}
          </div>
          <p className="text-muted-foreground text-sm">
            {fmtDubai(lead.created_at, { locale: t("locale.dateLocale") })} · {lead.source ? t(`sourceLabels.${lead.source}`) : t("sourceLabels.unknown")}
            {lead.rep_name && ` · ${lead.rep_name}`}
            {assignedToName && !lead.rep_name && ` · ${assignedToName}`}
            {creatorName && ` · ${t("leadDetail.createdBy")}: ${creatorName}`}
          </p>
        </div>
        {(["admin", "boss", "operator"].includes(salesRole ?? "") || (salesRole === "sales" && lead.assigned_to === currentUserId)) && (
          <>
          <Button variant="ghost" size="icon"
            className="text-muted-foreground hover:text-red-400 hover:bg-red-500/10"
            onClick={handleDelete}
            title={t("common.delete") || "Delete"}>
            <Trash2 className="w-5 h-5" />
          </Button>
          {(["admin", "boss", "operator"].includes(salesRole ?? "")) && (
            <Button variant="ghost" size="sm"
              className="text-amber-400 hover:bg-amber-500/10"
              onClick={() => { setMarkingPoor(true); }}
              title={t("leads.markPoor")}>
              ⚠️ {t("leads.markPoor")}
            </Button>
          )}
          </>
        )}
        {markingPoor && (
          <div className="flex items-center gap-2 mt-2">
            <input value={poorReasonText} onChange={e => setPoorReasonText(e.target.value)}
              placeholder={t("leads.poorReasonPlaceholder")} className="text-sm border border-border rounded px-2 py-1 bg-background" />
            <Button size="sm" variant="ghost" onClick={handleMarkPoor} className="text-amber-400">✓</Button>
            <Button size="sm" variant="ghost" onClick={() => setMarkingPoor(false)} className="text-muted-foreground">✗</Button>
          </div>
        )}
      </div>

      {/* Deal Canvas: facts → focused action workspace → auditable activity ledger. */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(250px,0.8fr)_minmax(520px,1.6fr)_minmax(340px,1fr)]">
        <aside className="space-y-3">
          <p className="px-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {lang === "zh" ? "客户与项目事实" : "Customer & project facts"}
          </p>
          <LeadCustomerProfile
            lead={lead}
            users={salesUsers}
            onUpdateField={updateField}
            onReassign={reassignSales}
            renderInlineEdit={renderInlineEdit}
            renderDateEdit={renderDateEdit}
            t={t}
            showSalesDropdown={showSalesDropdown}
            setShowSalesDropdown={setShowSalesDropdown}
            reassigning={reassigning}
            transferHistory={transferHistory}
          />
        </aside>

        <main className="space-y-3">
          <p className="px-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-copper-400">
            {lang === "zh" ? "成交工作区 · 下一步行动" : "Deal workspace · next action"}
          </p>
          <LeadSalesProcess
            lead={lead}
            leadTrace={leadTrace}
            followUpLogs={followUpLogs}
            milestones={leadMilestones}
            nextTask={nextTask}
            updating={updating}
            onToggleMilestone={toggleMilestone}
            onReopenMilestone={reopenMilestone}
            onUpdateField={updateField}
            onWon={handleWon}
            onLost={handleLost}
            onOpenQuoteCalculator={openQuoteCalculator}
            onCreateContract={handleCreateContract}
            onGenerateKnx={handleGenerateKnx}
            renderInlineEdit={renderInlineEdit}
            renderDateEdit={renderDateEdit}
            renderJsonEdit={renderJsonEdit}
            renderNextFollowupDate={renderNextFollowupDate}
            renderNextAction={renderNextAction}
            onAddStructuredContact={addStructuredContact}
            t={t}
            lang={lang}
          />
          {/* KNX design panel — kept mounted so the "Generate KNX Plan" button
              (which drives it via the [data-knx-panel] selector) keeps working. */}
          <KnxDesignPanel leadId={id as string} />
        </main>

        <aside className="space-y-3 xl:sticky xl:top-20 xl:self-start">
          <p className="px-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {lang === "zh" ? "可追溯时间线" : "Auditable timeline"}
          </p>
          <LeadTimeline
            leadId={id as string}
            activities={activities}
            events={events}
            followUpLogs={followUpLogs}
            milestones={leadMilestones}
            chatMessages={chatMessages}
            noteText={noteText}
            onNoteTextChange={setNoteText}
            onAddNote={handleAddNote}
            onContactUpdated={fetchData}
            t={t}
            lang={lang}
          />
        </aside>
      </div>

      {/* Bottom folding panel — 6 collapsible blocks */}
      <LeadFoldingPanel
        lead={lead}
        leadMilestones={leadMilestones}
        openPanel={openPanel}
        onOpenPanelChange={setOpenPanel}
        projectInfoDraft={projectInfoDraft}
        onProjectInfoDraftChange={setProjectInfoDraft}
        projectInfoStatus={projectInfoStatus}
        onSaveProjectInfo={saveProjectInfo}
        onResetProjectInfo={resetProjectInfoDraft}
        renderJsonEdit={renderJsonEdit}
        t={t}
        lang={lang}
      />

      {/* T2-4: dialog 层级约定 — z-modal z-40
          Radix Dialog 内部已设 z-50，本处约定为「modal 大类 = z-40」便于
          与 page-title (z-20) / dropdown (z-50 内嵌元素) 协调。 */}
      {showQuoteCalculator && (
        <QuoteCalculator
          open={showQuoteCalculator}
          onOpenChange={setShowQuoteCalculator}
          initialLeadId={id as string}
          onSaved={() => { fetchData(); }}
        />
      )}
      {/* T2-4: toast 层级约定 — z-toast z-50
          sonner Toaster 已固定 z-50，作为最高优先级反馈层，
          覆盖 page-title / modal / dropdown。 */}
      <Toaster position="top-center" richColors />
    </DashboardScrollContainer>
  );
}
