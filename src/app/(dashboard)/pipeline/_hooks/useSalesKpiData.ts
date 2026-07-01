"use client";

/**
 * useSalesKpiData — T3-3 step 2 extracted from pipeline/page.tsx
 * T3-3 step 3 HOTFIX: re-routed all 3 queries through useSupabaseQuery to
 * comply with T1-1 freeze rule (no direct supabase.from() Promise chains).
 *
 * Encapsulates the 3-query parallel fetch (kpi_targets / contracts / payments)
 * plus the derived KPI calculations for the Sales KPI Dashboard.
 *
 * Returns ALL computed values the dashboard needs (signing/collection targets,
 * actuals, percentages, contract count, loading flag) so the consuming
 * component stays purely presentational.
 */

import { useEffect, useState, useMemo } from "react";
import { createClient } from "@/lib/supabase";
import { useSupabaseQuery } from "@/lib/supabaseQuery";

/* ─── Types ─── */
interface KpiTarget {
  id: string;
  period: string;
  target_type: string;
  target_amount: number;
  assigned_to: string | null;
}

interface ContractRow {
  id: string;
  contract_amount: number | null;
  status: string;
}

interface PaymentRow {
  amount: number | null;
  confirmed: boolean;
  contract_id: string;
}

export interface UseSalesKpiDataReturn {
  signingTarget: number;
  signingActual: number;
  signingPct: number | null;
  collectionTarget: number;
  collectionActual: number;
  collectionPct: number | null;
  contractCount: number;
  isLoading: boolean;
}

/* ─── Hook ─── */
export function useSalesKpiData(currentUserId: string | null): UseSalesKpiDataReturn {
  const supabase = createClient();
  // Period computed once per render — stable across the 3 queries below.
  const period = new Date().toISOString().slice(0, 7);
  const enabled = !!currentUserId;

  // ── 3 parallel queries via useSupabaseQuery (replaces Promise.all + supabase.from chain).
  // Each hook is independent; React triggers all 3 in parallel just like Promise.all did.
  // useSupabaseQuery handles AbortController/timeout/retry internally — do NOT wrap externally.
  // Pattern reference: src/app/(dashboard)/products/page.tsx
  const {
    data: kpiTargetsData,
    loading: kpiLoading,
  } = useSupabaseQuery<KpiTarget[]>(
    async () => {
      return await supabase
        .from("kpi_targets")
        .select("*")
        .eq("period", period)
        .eq("assigned_to", currentUserId as string);
    },
    [currentUserId, period],
    { enabled }
  );

  const {
    data: contractsData,
    loading: contractsLoading,
  } = useSupabaseQuery<ContractRow[]>(
    async () => {
      return await supabase
        .from("contracts")
        .select("id,contract_amount,status")
        .eq("sales_id", currentUserId as string);
    },
    [currentUserId],
    { enabled }
  );

  const {
    data: paymentsData,
    loading: paymentsLoading,
  } = useSupabaseQuery<PaymentRow[]>(
    async () => {
      return await supabase.from("payments").select("amount,confirmed,contract_id");
    },
    [],
    { enabled }
  );

  // ── Derived values (signingActual / collectionActual / contractCount) ──
  // Recomputed synchronously from query data; synced into state via useEffect
  // so the public hook return interface stays a stable 9-field shape.
  const [signingActual, setSigningActual] = useState(0);
  const [collectionActual, setCollectionActual] = useState(0);
  const [contractCount, setContractCount] = useState(0);

  useEffect(() => {
    const contracts = (contractsData ?? []) as ContractRow[];
    const active = contracts.filter((c) => c.status !== "terminated");
    const totalSigning = active.reduce((sum, c) => sum + (c.contract_amount || 0), 0);
    setSigningActual(totalSigning);
    setContractCount(active.length);

    if (paymentsData) {
      const contractIds = new Set(contracts.map((c) => c.id));
      const confirmedPayments = (paymentsData as PaymentRow[]).filter(
        (p) => p.confirmed === true && contractIds.has(p.contract_id)
      );
      const totalCollected = confirmedPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
      setCollectionActual(totalCollected);
    } else {
      setCollectionActual(0);
    }
  }, [contractsData, paymentsData]);

  // ── isLoading: true while ANY of the 3 queries is in flight ──
  const isLoading = Boolean(kpiLoading || contractsLoading || paymentsLoading);

  // ─── Derived values ───
  const kpiTargets = (kpiTargetsData ?? []) as KpiTarget[];
  const signingTarget = useMemo(
    () => kpiTargets.find((t) => t.target_type === "signing")?.target_amount || 0,
    [kpiTargets]
  );
  const collectionTarget = useMemo(
    () => kpiTargets.find((t) => t.target_type === "collection")?.target_amount || 0,
    [kpiTargets]
  );
  const signingPct = useMemo(
    () => (signingTarget > 0 ? Math.round((signingActual / signingTarget) * 100) : null),
    [signingTarget, signingActual]
  );
  const collectionPct = useMemo(
    () => (collectionTarget > 0 ? Math.round((collectionActual / collectionTarget) * 100) : null),
    [collectionTarget, collectionActual]
  );

  return {
    signingTarget,
    signingActual,
    signingPct,
    collectionTarget,
    collectionActual,
    collectionPct,
    contractCount,
    isLoading,
  };
}
