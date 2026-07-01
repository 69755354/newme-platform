"use client";

/**
 * useSalesKpiData — T3-3 step 2 extracted from pipeline/page.tsx
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
  const [kpiTargets, setKpiTargets] = useState<KpiTarget[]>([]);
  const [signingActual, setSigningActual] = useState(0);
  const [collectionActual, setCollectionActual] = useState(0);
  const [contractCount, setContractCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!currentUserId) return;
    const period = new Date().toISOString().slice(0, 7);
    setIsLoading(true);

    Promise.all([
      // 1. Fetch KPI targets for this sales person
      supabase.from("kpi_targets").select("*").eq("period", period).eq("assigned_to", currentUserId),
      // 2. Fetch contracts for this sales person
      supabase.from("contracts").select("id,contract_amount,status").eq("sales_id", currentUserId),
      // 3. Fetch payments (all — filtered by contract ownership below)
      supabase.from("payments").select("amount,confirmed,contract_id"),
    ]).then(([tRes, cRes, pRes]) => {
      if (tRes.data) setKpiTargets(tRes.data as KpiTarget[]);

      if (cRes.data) {
        const contracts = cRes.data as ContractRow[];
        const active = contracts.filter(c => c.status !== "terminated");
        const totalSigning = active.reduce((sum, c) => sum + (c.contract_amount || 0), 0);
        setSigningActual(totalSigning);
        setContractCount(active.length);

        // Collection: payments where confirmed=true for this user's contracts
        if (pRes.data) {
          const contractIds = new Set(contracts.map(c => c.id));
          const confirmedPayments = (pRes.data as PaymentRow[])
            .filter(p => p.confirmed === true && contractIds.has(p.contract_id));
          const totalCollected = confirmedPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
          setCollectionActual(totalCollected);
        }
      }

      setIsLoading(false);
    }).catch(() => setIsLoading(false));
  }, [currentUserId, supabase]);

  // ─── Derived values ───
  const signingTarget = useMemo(
    () => kpiTargets.find(t => t.target_type === "signing")?.target_amount || 0,
    [kpiTargets]
  );
  const collectionTarget = useMemo(
    () => kpiTargets.find(t => t.target_type === "collection")?.target_amount || 0,
    [kpiTargets]
  );
  const signingPct = useMemo(
    () => signingTarget > 0 ? Math.round((signingActual / signingTarget) * 100) : null,
    [signingTarget, signingActual]
  );
  const collectionPct = useMemo(
    () => collectionTarget > 0 ? Math.round((collectionActual / collectionTarget) * 100) : null,
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
