"use client";

/**
 * useLeadMutations — T3-3 step 6 extracted from leads/page.tsx
 *
 * Encapsulates every lead-level write (mutation) path on the leads dashboard.
 * Pure 1:1 move from page.tsx — no business logic changed. The handlers
 * originally lived inline in LeadsContent; this hook makes them testable
 * and brings the page closer to a render-only shell.
 *
 * Why a separate hook from useLeadsData?
 *   - useLeadsData owns the read side (queries via useSupabaseQuery).
 *   - useLeadMutations owns the write side (mutations stay direct
 *     supabase.from() calls — T1-1 freeze rule applies to *queries*
 *     only; mutations are explicitly out of scope per the dispatch).
 *   - Keeps the page-level orchestrator (page.tsx) focused on UI state
 *     + composition, with one mutation surface to mock in tests.
 *
 * Stage transitions are deliberately absent from this dashboard hook. They
 * require the Lead detail page's controlled API path, which records the
 * required stage note and enforces the current-stage completion gates.
 *
 * T3-3 step 7 — ui interface slim-down
 *   - The original `ui` parameter was a 13-setter bundle used by handlers
 *     to read current editor text + close picker flags on completion.
 *   - After step 7 (LeadCard.tsx), all editor state is owned by LeadCard
 *     itself. The hook no longer needs the full UI bundle: editors are
 *     closed on-click by LeadCard before invoking the mutation handler,
 *     and the 3 text-input editors (note / nextAction / nextFollowup)
 *     have their text passed as a handler argument.
 *   - The hook invokes `onSuccess?.()` after each text-editor write
 *     completes successfully, giving LeadCard the hook to clear its
 *     input + close picker only on a confirmed DB write.
 */

import { useCallback } from "react";
import { createClient } from "@/lib/supabase";
import { toast } from "sonner";
import type { Lead } from "./useLeadsData";

/* ─── Types ─── */
export interface SalesUser {
  id: string;
  email: string | null;
  role: string | null;
  full_name: string | null;
}

export interface UseLeadMutationsParams {
  leads: Lead[];
  setLeads: React.Dispatch<React.SetStateAction<Lead[]>>;
  userId: string | null;
  role: string | null;
  salesUsers: SalesUser[];
  userNameMap: Record<string, string>;
  fetchLeads: () => void;
  setError: (msg: string | null) => void;
  t: (key: string) => string;
  lang: string;
  /**
   * Page-level state setters (used by reassignSales to clear the
   * reassign dropdown on completion). These are page concerns —
   * not editor state — so they stay top-level instead of being
   * lumped into `editors`.
   */
    setReassignLeadId: (v: string | null) => void;
    setReassigning: (v: boolean) => void;
  }

export interface UseLeadMutationsReturn {
  reassignSales: (leadId: string, newUserId: string) => Promise<void>;
  writeEvent: (
    leadId: string,
    eventType: string,
    description: string,
    eventData?: Record<string, any>
  ) => Promise<void>;
  handleDelete: (leadId: string, leadAssignedTo: string | null) => Promise<void>;
}

/* ─── Hook ─── */
export function useLeadMutations(params: UseLeadMutationsParams): UseLeadMutationsReturn {
  const supabase = createClient();
  const {
    leads,
    setLeads,
    role: salesRole,
    userId: currentUserId,
    salesUsers,
    fetchLeads,
    setError,
    t,
    lang,
    setReassignLeadId,
    setReassigning,
  } = params;

  // ─── Write business event ───
  // P3-12: route via POST /api/leads/[id]/events instead of the direct
  // supabase.from('business_events').insert(...) that lived here before.
  // Mirrors the P3-11 detail-page hook pattern but stays fire-and-forget
  // by design — the list page has no critical UI for missing audit rows,
  // so a console.error is enough and we deliberately do NOT toast.
  // Signature is unchanged: (leadId, eventType, description, eventData?)
  // → Promise<void>, so all remaining dashboard mutation call sites
  // (currently reassignment) keep working as-is.
  const writeEvent = useCallback(
    async (leadId: string, eventType: string, description: string, eventData?: Record<string, any>) => {
      if (!currentUserId) return;
      try {
        const res = await fetch(`/api/leads/${leadId}/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eventType, description, eventData: eventData ?? {} }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          console.error("Failed to write business event:", res.status, json?.error || "");
        }
      } catch (e) {
        console.error("Failed to write business event:", e);
      }
    },
    [currentUserId]
  );

  // ─── Sales reassignment ───
  const reassignSales = useCallback(
    async (leadId: string, newUserId: string) => {
      setReassigning(true);
      const oldLead = leads.find(l => l.id === leadId);
      if (!oldLead) return;
      const newUser = salesUsers.find(u => u.id === newUserId);
      if (!newUser) {
        setReassigning(false);
        setError(t("common.saveFailed"));
        return;
      }
      try {
        const response = await fetch(`/api/leads/${leadId}/assignment`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            assignedTo: newUserId,
            expectedUpdatedAt: oldLead.updated_at,
            idempotencyKey: crypto.randomUUID(),
            reason: "manual_reassign",
          }),
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          setError(payload.error || t("common.saveFailed"));
          return;
        }
        setReassignLeadId(null);
        fetchLeads();
      } finally {
        setReassigning(false);
      }
    },
    [leads, salesUsers, fetchLeads, setError, setReassignLeadId, setReassigning, t]
  );

  // ─── Delete lead ───
  const handleDelete = useCallback(
    async (leadId: string, leadAssignedTo: string | null) => {
      const canDelete = salesRole === "admin" || salesRole === "boss" || (salesRole === "sales" && leadAssignedTo === currentUserId);
      if (!canDelete) return;
      const confirmed = confirm(t("leadDetail.confirmDelete") || "Are you sure you want to delete this lead? This action cannot be undone.");
      if (!confirmed) return;
      const response = await fetch(`/api/leads/${leadId}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        console.error("Failed to delete lead:", payload.error || response.status);
        toast.error(t("common.saveFailed") || "Delete failed");
        return;
      }
      toast.success(lang === "zh" ? "已删除" : "Lead deleted");
      fetchLeads();
    },
    [salesRole, currentUserId, fetchLeads, t, lang]
  );

  return {
    reassignSales,
    writeEvent,
    handleDelete,
  };
}
