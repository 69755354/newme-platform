"use client";

/**
 * useLeadsData — P1-D refactored data layer for the leads dashboard.
 *
 * Replaces 4 client-side useSupabaseQuery calls (auth, profile, leads, salesUsers)
 * with a single fetch to the server-side /api/leads/list aggregation endpoint.
 * Auth, role resolution, and queries now happen on the server — zero client
 * Supabase reads reach the database directly.
 *
 * The hook still exposes the same UseLeadsDataReturn shape so page.tsx and
 * all downstream components (LeadsKanbanBoard, LeadsFilters, etc.) work
 * without changes.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

/* ─── Types ─── */
export interface Lead {
  id: string; customer_name: string | null; phone: string | null;
  source: string; stage: string; final_status?: string | null; quotation_value: number | null;
  location: string | null; property_type: string | null;
  project_type: string | null; project_status: string | null;
  property_size_sqm: number | null;
  ai_quality: string | null; lead_status: string | null;
  assigned_to: string | null; win_probability: number | null;
  last_contact_date: string | null; next_followup_date: string | null;
  next_action: string | null; followup_count: number | null;
  created_at: string; updated_at: string;
  recovery_candidate: boolean; transfer_candidate: boolean;
  sales_manager_review: boolean; hold_since: string | null;
  lost_reason: string | null; decision_maker: string | null;
  decision_date: string | null; competitor: string | null;
  owner: string | null; sales_manager: string | null;
  campaign_name: string | null; source_platform: string | null;
  quality: string | null;
  poor_reason: string | null;
}

interface SalesUser {
  id: string;
  email: string | null;
  role: string | null;
  full_name: string | null;
}

interface OwnerProfile {
  id: string;
  full_name: string | null;
}

export interface UseLeadsDataReturn {
  leads: Lead[];
  setLeads: React.Dispatch<React.SetStateAction<Lead[]>>;
  loading: boolean;
  error: string | null;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  userId: string | null;
  setUserId: React.Dispatch<React.SetStateAction<string | null>>;
  role: string | null;
  setRole: React.Dispatch<React.SetStateAction<string | null>>;
  salesUsers: SalesUser[];
  userNameMap: Record<string, string>;
  fetchLeads: () => void;
}

/* ─── Hook ─── */
export function useLeadsData(): UseLeadsDataReturn {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [salesUsers, setSalesUsers] = useState<SalesUser[]>([]);
  const [ownerProfiles, setOwnerProfiles] = useState<OwnerProfile[]>([]);
  const [loading, setLoading] = useState(true);

  // ── Single fetch to server-side aggregation endpoint ──
  const fetchLeads = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch("/api/leads/list")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json) => {
        if (cancelled) return;
        setUserId(json.userId);
        setRole(json.role);
        setLeads((json.leads ?? []) as Lead[]);
        setSalesUsers((json.salesUsers ?? []) as SalesUser[]);
        setOwnerProfiles((json.ownerProfiles ?? []) as OwnerProfile[]);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || "Failed to load leads");
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // ── Initial fetch on mount ──
  useEffect(() => {
    const cleanup = fetchLeads();
    return cleanup;
  }, [fetchLeads]);

  // ── Derived: userNameMap (id → full_name) ──
  const userNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    ownerProfiles.forEach((u) => {
      if (u.id && u.full_name) map[u.id] = u.full_name;
    });
    return map;
  }, [ownerProfiles]);

  return {
    leads,
    setLeads,
    loading,
    error,
    setError,
    userId,
    setUserId,
    role,
    setRole,
    salesUsers,
    userNameMap,
    fetchLeads,
  };
}
