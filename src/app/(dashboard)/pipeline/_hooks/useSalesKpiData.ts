"use client";

import { useMemo } from "react";

interface KpiTarget {
  id: string;
  period: string;
  target_type: string;
  target_amount: number;
  assigned_to: string | null;
}

export interface KpiApiData {
  kpiTargets: KpiTarget[];
  contractCount: number;
  signingActual: number;
  collectionActual: number;
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

export function useSalesKpiData(
  currentUserId: string | null,
  kpiApiData: KpiApiData | null
): UseSalesKpiDataReturn {
  const kpiTargets = kpiApiData?.kpiTargets ?? [];
  const signingActual = kpiApiData?.signingActual ?? 0;
  const collectionActual = kpiApiData?.collectionActual ?? 0;
  const contractCount = kpiApiData?.contractCount ?? 0;

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
    isLoading: false,
  };
}
