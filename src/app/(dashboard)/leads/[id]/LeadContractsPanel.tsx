"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { FileText, DollarSign, Calendar, Plus, CheckCircle, AlertTriangle, Clock } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageContext";

interface ContractRow {
  id: string;
  contract_no: string;
  contract_amount: number;
  status: string;
  contract_date: string;
  first_payment_status?: string | null;
  installment_plans?: { seq: number; amount: number; due_date: string; status: string }[] | null;
}

/**
 * Shown inside the lead-detail "合同" (contract) collapsible panel.
 * Lists every contract attached to this lead, each linking to its detail page.
 */
export default function LeadContractsPanel({ leadId }: { leadId: string }) {
  const { t } = useLanguage();
  const [contracts, setContracts] = useState<ContractRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/contracts?lead_id=${leadId}`);
        if (!res.ok) return;
        const json = await res.json();
        if (alive) setContracts(json.data ?? []);
      } catch {
        /* ignore — panel is non-critical */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [leadId]);

  const fmtAED = (v: number) =>
    v >= 1_000_000 ? `AED ${(v / 1_000_000).toFixed(1)}M` : `AED ${v.toLocaleString()}`;

  if (loading) {
    return <div className="py-6 text-center text-xs text-muted-foreground">{t("common.loading")}</div>;
  }

  if (contracts.length === 0) {
    return (
      <div className="py-6 text-center space-y-3">
        <p className="text-sm text-muted-foreground">{t("leadDetail.contractNotCreated")}</p>
        <Link
          href={`/contracts/new?lead_id=${leadId}`}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-600 text-foreground text-xs font-medium hover:bg-slate-700 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />{t("leadDetail.createContract")}
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {contracts.map((c) => {
        const paid = (c.installment_plans ?? []).filter((i) => i.status === "paid").length;
        const total = (c.installment_plans ?? []).length;
        return (
          <Link
            key={c.id}
            href={`/contracts/${c.id}`}
            className="block rounded-lg border border-border/50 bg-card/50 hover:border-copper-500/40 transition-colors p-3"
          >
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2 min-w-0">
                <FileText className="w-4 h-4 text-copper-400 shrink-0" />
                <span className="font-medium text-foreground text-sm truncate">{c.contract_no}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-copper-500/10 text-copper-400">{c.status}</span>
              </div>
              <span className="flex items-center gap-1 text-sm font-semibold text-foreground shrink-0">
                <DollarSign className="w-3 h-3" />{fmtAED(c.contract_amount)}
              </span>
            </div>
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground mt-1.5 flex-wrap">
              <span className="flex items-center gap-1"><Calendar className="w-3 h-3" />{c.contract_date?.slice(0, 10)}</span>
              {total > 0 && (
                <span className="flex items-center gap-1">
                  <CheckCircle className="w-3 h-3 text-emerald-400" />
                  {paid}/{total} {t("contracts.installments")}
                </span>
              )}
              {c.first_payment_status && c.first_payment_status !== "paid" && (
                <span className="flex items-center gap-1 text-amber-400">
                  <Clock className="w-3 h-3" />{t("analytics.outstanding")}
                </span>
              )}
            </div>
          </Link>
        );
      })}
      <Link
        href={`/contracts/new?lead_id=${leadId}`}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-copper-500/30 text-copper-400 text-xs font-medium hover:bg-copper-500/10 transition-colors mt-1"
      >
        <Plus className="w-3.5 h-3.5" />{t("leadDetail.createContract")}
      </Link>
    </div>
  );
}
