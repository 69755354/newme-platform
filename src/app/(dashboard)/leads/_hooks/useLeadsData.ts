"use client";

/**
 * useLeadsData — T3-3 step 5 extracted from leads/page.tsx
 *
 * Encapsulates the core data layer for the leads dashboard:
 *   - current user id (auth) + profile role for RLS-respecting lead filtering
 *   - sales users list (for reassignment dropdowns)
 *   - the leads list itself (500-row cap, ordered by updated_at desc)
 *   - derived userNameMap (id → full_name) for inline owner display
 *
 * All 4 queries are routed through useSupabaseQuery (T1-1 freeze rule —
 * no direct supabase.from() Promise chains). They run in parallel as 4
 * independent hook instances; React fires them concurrently.
 *
 * The async circuit-breaker is preserved: do NOT query leads until BOTH
 * role AND userId are resolved. A sales user running the unfiltered query
 * before role loads would briefly render leads they shouldn't see. RLS
 * remains the source of truth; this is defence-in-depth.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase";
import { useSupabaseQuery } from "@/lib/supabaseQuery";

/* ─── Types ─── */
export interface Lead {
  id: string; customer_name: string | null; phone: string | null;
  source: string; stage: string; final_status?: string | null; quotation_value: number | null;
  location: string | null; property_type: string | null;
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

interface ProfileRow {
  id: string;
  role: string | null;
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
  const supabase = createClient();

  const [leads, setLeads] = useState<Lead[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);

  // ── Query 1: current user id (auth) ──
  // Bootstrap gate — until this resolves, profile + leads queries stay disabled.
  const {
    data: authData,
    loading: authLoading,
  } = useSupabaseQuery<{ id: string } | null>(
    // supabase.auth.getUser returns AuthError (not PostgrestError); cast so
    // the query function signature matches useSupabaseQuery's generic contract.
    async () => {
      const { data, error: authErr } = await supabase.auth.getUser();
      if (authErr) return { data: null, error: authErr as unknown as never };
      return { data: data.user ? { id: data.user.id } : null, error: null };
    },
    [],
    { retry: 1 }
  );

  // Sync auth → userId state once the query settles.
  useEffect(() => {
    if (authData?.id && userId !== authData.id) setUserId(authData.id);
  }, [authData?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Query 2: profile role (drives sales filtering) ──
  const {
    data: profileData,
    loading: profileLoading,
  } = useSupabaseQuery<ProfileRow | null>(
    async () => {
      if (!userId) return { data: null, error: null };
      return await supabase
        .from("profiles")
        .select("id,role")
        .eq("id", userId)
        .single();
    },
    [userId],
    { enabled: !!userId }
  );

  useEffect(() => {
    if (profileData?.role) {
      if (role !== profileData.role) setRole(profileData.role);
    } else if (profileData && !profileData.role && role === null) {
      // Only fallback to "sales" when role truly unknown (null),
      // not when it's already resolved from a previous query
      setRole("sales");
    }
  }, [profileData, profileData?.role, role]);

  // ── Query 3: leads list (gated until BOTH role + userId are known) ──
  const leadsEnabled = !!role && !!userId;
  const {
    data: leadsData,
    loading: leadsLoading,
    refetch: refetchLeads,
  } = useSupabaseQuery<Lead[]>(
    async () => {
      let q = supabase.from("leads").select("*");
      if (role === "sales") q = q.eq("assigned_to", userId as string);
      const { data, error: leadsErr } = await q
        .order("updated_at", { ascending: false })
        .limit(500);
      if (leadsErr) return { data: null, error: leadsErr };
      return { data: (data ?? []) as Lead[], error: null };
    },
    [role, userId],
    { enabled: leadsEnabled }
  );

  // Sync query result → leads state.
  useEffect(() => {
    if (leadsData) setLeads(leadsData as Lead[]);
  }, [leadsData]);

  // Reset error whenever a fresh leads fetch starts.
  useEffect(() => {
    if (leadsLoading) setError(null);
  }, [leadsLoading]);

  // Public refetch — page-level mutations call this on success.
  const fetchLeads = useCallback(() => {
    if (leadsEnabled) refetchLeads();
  }, [leadsEnabled, refetchLeads]);

  // ── Query 4: sales users (for reassignment dropdown) ──
  const {
    data: salesUsersData,
  } = useSupabaseQuery<SalesUser[]>(
    async () => {
      const { data, error: salesErr } = await supabase
        .from("profiles")
        .select("id,email,role,full_name")
        .in("role", ["admin", "sales", "operator"]);
      if (salesErr) return { data: [], error: salesErr };
      return { data: (data ?? []) as SalesUser[], error: null };
    },
    []
  );

  const salesUsers: SalesUser[] = (salesUsersData ?? []) as SalesUser[];

  // ── Aggregate loading flag — true until leads query has settled once ──
  const loading = authLoading || profileLoading || leadsLoading;

  // ── Derived: userNameMap (id → full_name) ──
  const userNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    salesUsers.forEach((u) => {
      if (u.id && u.full_name) map[u.id] = u.full_name;
    });
    return map;
  }, [salesUsers]);

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