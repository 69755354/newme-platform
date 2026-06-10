"use client";

import { useEffect, useState, useMemo } from "react";
import { createClient } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { useRouter } from "next/navigation";
import {
  DollarSign, Calendar, AlertTriangle, Clock,
  CheckCircle2, TrendingUp, ChevronRight, User,
} from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageContext";

/* ─── Types ─── */
interface PaymentSummary {
  totalContractValue: number;
  collected: number;
  outstanding: number;
  overdue: number;
  dueThisWeek: number;
}

interface InstallmentRow {
  id: string;
  contract_id: string;
  contract_no: string;
  contract_amount: number;
  customer_name: string;
  sales_id: string;
  seq: number;
  amount: number;
  due_date: string;
  status: string;
  overdue_days: number;
  paid_amount: number;
}

interface PerRep {
  user_id: string;
  full_name: string;
  signed_amount: number;
  collected: number;
  collection_rate: number;
  overdue_count: number;
}

interface PaymentData {
  summary: PaymentSummary;
  installments: InstallmentRow[];
  perRep: PerRep[];
}

/* ─── Helpers ─── */
function fmtAED(v: number): string {
  if (v >= 1_000_000) return `AED ${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `AED ${(v / 1_000).toFixed(0)}K`;
  return `AED ${v.toLocaleString()}`;
}

/* ─── Summary Card ─── */
function SummaryCard({ label, value, sub, alert }: {
  label: string; value: string; sub?: string; alert?: "red" | "yellow" | "green";
}) {
  return (
    <div className={cn(
      "p-3 rounded-xl border bg-card/50",
      alert === "red" ? "border-red-500/30" :
      alert === "yellow" ? "border-yellow-500/30" :
      alert === "green" ? "border-emerald-500/30" :
      "border-border/50"
    )}>
      <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium mb-0.5">{label}</p>
      <p className={cn(
        "text-xl font-bold leading-tight",
        alert === "red" ? "text-red-400" :
        alert === "yellow" ? "text-yellow-400" :
        alert === "green" ? "text-emerald-400" :
        "text-foreground"
      )}>{value}</p>
      {sub && <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

/* ─── Main Component ─── */
export default function PaymentTracker() {
  const supabase = createClient();
  const router = useRouter();
  const { t } = useLanguage();

  const [data, setData] = useState<PaymentData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  const STATUS_CONFIG: Record<string, { label: string; bg: string; text: string; dot: string }> = {
    paid:     { label: t("analytics.paid"),       bg: "bg-emerald-500/10", text: "text-emerald-400", dot: "bg-emerald-500" },
    overdue:  { label: t("analytics.overdueStatus"),    bg: "bg-red-500/10",     text: "text-red-400",    dot: "bg-red-500" },
    due_soon: { label: t("analytics.dueSoon"),   bg: "bg-yellow-500/10",  text: "text-yellow-400", dot: "bg-yellow-500" },
    pending:  { label: t("analytics.pending"),    bg: "bg-gray-500/10",    text: "text-gray-400",   dot: "bg-gray-400" },
    cancelled:{ label: t("analytics.cancelled"),  bg: "bg-gray-500/10",    text: "text-gray-500",   dot: "bg-gray-500" },
  };

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      setUserId(user.id);
      const { data: profile } = await supabase
        .from("profiles")
        .select("role, full_name")
        .eq("id", user.id)
        .single();
      setUserRole(profile?.role ?? "sales");
    })();
  }, []);

  useEffect(() => {
    if (!userRole) return;
    (async () => {
      try {
        setLoading(true);
        const res = await fetch("/api/dashboard/payment-tracker");
        if (!res.ok) throw new Error("Failed to fetch");
        const json = await res.json();
        setData(json);
      } catch (err) {
        setError(t("common.loadFailed"));
        console.error(err);
      }
      setLoading(false);
    })();
  }, [userRole]);

  const isManagement = userRole === "admin" || userRole === "boss" || userRole === "operator";

  const summary = data?.summary;
  const installments = data?.installments || [];
  const perRep = data?.perRep || [];

  // Sales: filter to my own installments — MUST be before any conditional returns (Rules of Hooks)
  const myInstallments = useMemo(() => {
    if (isManagement) return installments;
    return installments.filter(i => i.sales_id === userId);
  }, [installments, isManagement, userId]);

  // My overdue
  const myOverdue = useMemo(() => myInstallments.filter(i => i.status === "overdue"), [myInstallments]);
  // My due soon
  const myDueSoon = useMemo(() => myInstallments.filter(i => i.status === "due_soon"), [myInstallments]);

  /* ─── Status Badge ─── */
  function StatusBadge({ status }: { status: string }) {
    const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.pending;
    return (
      <span className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium",
        cfg.bg, cfg.text
      )}>
        <span className={cn("w-1.5 h-1.5 rounded-full", cfg.dot)} />
        {cfg.label}
      </span>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
        {t("analytics.loadingPayment")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-48 text-rose-400 text-sm">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <div className="w-1 h-4 rounded-full bg-copper-400" />
        <h2 className="text-sm font-semibold text-foreground">
          {isManagement ? t("analytics.paymentTracker") : t("analytics.myReceivables")}
        </h2>
      </div>

      {/* ─── CEO View: 4 Summary Cards ─── */}
      {isManagement && summary && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <SummaryCard
            label={t("analytics.totalContract")}
            value={fmtAED(summary.totalContractValue)}
            sub={`${t("analytics.outstanding")}: ${fmtAED(summary.outstanding)}`}
          />
          <SummaryCard
            label={t("analytics.collected")}
            value={fmtAED(summary.collected)}
            sub={summary.totalContractValue > 0
              ? `${Math.round((summary.collected / summary.totalContractValue) * 100)}% ${t("analytics.collectionRate")}`
              : "—"
            }
            alert="green"
          />
          <SummaryCard
            label={t("analytics.overdueStatus")}
            value={fmtAED(summary.overdue)}
            sub={summary.overdue > 0 ? t("analytics.requiresAction") : t("analytics.allClear")}
            alert={summary.overdue > 0 ? "red" : undefined}
          />
          <SummaryCard
            label={t("analytics.dueThisWeek")}
            value={fmtAED(summary.dueThisWeek)}
            sub={summary.dueThisWeek > 0 ? t("analytics.upcomingPayments") : t("analytics.noPaymentsDue")}
            alert={summary.dueThisWeek > 0 ? "yellow" : undefined}
          />
        </div>
      )}

      {/* ─── Sales View: My Collection Progress ─── */}
      {!isManagement && summary && (
        <div className="grid grid-cols-2 gap-2">
          <SummaryCard
            label={t("analytics.myCollection")}
            value={fmtAED(summary.collected)}
            sub={summary.totalContractValue > 0
              ? `${Math.round((summary.collected / summary.totalContractValue) * 100)}% ${t("analytics.collected").toLowerCase()}`
              : "—"
            }
            alert="green"
          />
          <SummaryCard
            label={t("analytics.myTotalContracts")}
            value={fmtAED(summary.totalContractValue)}
            sub={`${t("analytics.overdueStatus")}: ${fmtAED(summary.overdue)}`}
            alert={summary.overdue > 0 ? "red" : undefined}
          />
        </div>
      )}

      {/* ─── Installment Table ─── */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Calendar className="w-3.5 h-3.5 text-muted-foreground" />
          <h3 className="text-xs font-semibold text-foreground">
            {isManagement ? t("analytics.installmentDetails") : t("analytics.myInstallments")}
          </h3>
          <span className="text-[10px] text-muted-foreground">
            ({myInstallments.length})
          </span>
        </div>

        {myInstallments.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
            <CheckCircle2 className="w-8 h-8 text-emerald-400/30 mb-2" />
            <p className="text-xs">{t("analytics.noInstallments")}</p>
          </div>
        ) : (
          <div className="rounded-xl border border-border/50 bg-card/50 overflow-hidden">
            {/* Table header — hidden on very small screens */}
            <div className="hidden md:flex items-center gap-2 px-3 py-2 border-b border-border/30 text-[10px] text-muted-foreground uppercase tracking-wider font-medium">
              <div className="flex-[2]">{t("analytics.customer")}</div>
              <div className="flex-1 text-right">{t("analytics.amount")}</div>
              <div className="flex-1 text-right">{t("analytics.inst")}</div>
              <div className="flex-[1.5] text-right">{t("analytics.dueDate")}</div>
              <div className="flex-1 text-center">{t("analytics.status")}</div>
              <div className="flex-1 text-right">{t("analytics.overdueDays")}</div>
            </div>

            <div className="divide-y divide-border/20 max-h-[360px] overflow-y-auto">
              {myInstallments.slice(0, 50).map((inst) => (
                <button
                  key={inst.id}
                  onClick={() => router.push(`/contracts`)}
                  className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-accent/30 transition-colors text-left group"
                >
                  {/* Mobile-friendly: stacked on small, row on md+ */}
                  <div className="flex-1 min-w-0 md:hidden">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium truncate">{inst.customer_name}</span>
                      <StatusBadge status={inst.status} />
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs font-semibold text-foreground">{fmtAED(inst.amount)}</span>
                      <span className="text-[10px] text-muted-foreground">#{inst.seq}</span>
                      <span className="text-[10px] text-muted-foreground">{t("analytics.dueLabel")} {inst.due_date}</span>
                      {inst.overdue_days > 0 && (
                        <span className="text-[10px] text-red-400">{inst.overdue_days}{t("analytics.overdueDaysLabel")}</span>
                      )}
                    </div>
                  </div>

                  {/* Desktop row */}
                  <div className="hidden md:flex items-center gap-2 w-full">
                    <div className="flex-[2] min-w-0">
                      <span className="text-xs font-medium truncate block">{inst.customer_name}</span>
                      <span className="text-[10px] text-muted-foreground">{inst.contract_no}</span>
                    </div>
                    <div className="flex-1 text-right">
                      <span className="text-xs font-semibold">{fmtAED(inst.amount)}</span>
                    </div>
                    <div className="flex-1 text-right">
                      <span className="text-[11px] text-muted-foreground">#{inst.seq}</span>
                    </div>
                    <div className="flex-[1.5] text-right">
                      <span className={cn(
                        "text-[11px]",
                        inst.status === "overdue" ? "text-red-400" : "text-muted-foreground"
                      )}>{inst.due_date}</span>
                    </div>
                    <div className="flex-1 text-center">
                      <StatusBadge status={inst.status} />
                    </div>
                    <div className="flex-1 text-right">
                      {inst.overdue_days > 0 ? (
                        <span className="text-[11px] text-red-400 font-medium">{inst.overdue_days}d</span>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">—</span>
                      )}
                    </div>
                  </div>

                  <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0 md:hidden" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ─── Sales View: My Overdue Action List ─── */}
      {!isManagement && myOverdue.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
            <h3 className="text-xs font-semibold text-foreground">{t("analytics.overdueReceivables")}</h3>
            <span className="text-[10px] text-red-400 font-medium">({myOverdue.length})</span>
          </div>
          <div className="space-y-1">
            {myOverdue.slice(0, 5).map((inst) => (
              <button
                key={inst.id}
                onClick={() => router.push(`/contracts`)}
                className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-red-500/5 border border-red-500/10 hover:bg-red-500/10 transition-colors"
              >
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate">{inst.customer_name}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {fmtAED(inst.amount)} · {t("analytics.duePrefix")} {inst.due_date} · {inst.overdue_days}{t("analytics.overdueDaysLabel")}
                  </p>
                </div>
                <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ─── Sales View: My Due-This-Week Reminders ─── */}
      {!isManagement && myDueSoon.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Clock className="w-3.5 h-3.5 text-yellow-400" />
            <h3 className="text-xs font-semibold text-foreground">{t("analytics.dueThisWeek")}</h3>
            <span className="text-[10px] text-yellow-400 font-medium">({myDueSoon.length})</span>
          </div>
          <div className="space-y-1">
            {myDueSoon.slice(0, 5).map((inst) => (
              <button
                key={inst.id}
                onClick={() => router.push(`/contracts`)}
                className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-yellow-500/5 border border-yellow-500/10 hover:bg-yellow-500/10 transition-colors"
              >
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate">{inst.customer_name}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {fmtAED(inst.amount)} · {t("analytics.duePrefix")} {inst.due_date}
                  </p>
                </div>
                <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ─── CEO View: Rep Collection Table ─── */}
      {isManagement && perRep.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <User className="w-3.5 h-3.5 text-muted-foreground" />
            <h3 className="text-xs font-semibold text-foreground">{t("analytics.collectionByRep")}</h3>
          </div>
          <div className="rounded-xl border border-border/50 bg-card/50 overflow-hidden">
            <div className="hidden md:flex items-center gap-2 px-3 py-2 border-b border-border/30 text-[10px] text-muted-foreground uppercase tracking-wider font-medium">
              <div className="flex-[2]">{t("analytics.rep")}</div>
              <div className="flex-1 text-right">{t("analytics.signedShort")}</div>
              <div className="flex-1 text-right">{t("analytics.collectedShort")}</div>
              <div className="flex-1 text-center">{t("analytics.rate")}</div>
              <div className="flex-1 text-right">{t("analytics.overdueShort")}</div>
            </div>
            <div className="divide-y divide-border/20">
              {perRep.map((rep) => (
                <button
                  key={rep.user_id}
                  onClick={() => router.push(`/leads?assigned_to=${rep.user_id}`)}
                  className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-accent/30 transition-colors group"
                >
                  <div className="flex-1 min-w-0 md:hidden">
                    <span className="text-xs font-medium">{rep.full_name}</span>
                    <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-foreground">
                      <span>{t("analytics.signedShort")}: {fmtAED(rep.signed_amount)}</span>
                      <span>{t("analytics.collectedShort")}: {fmtAED(rep.collected)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        "text-[10px] font-medium",
                        rep.collection_rate >= 70 ? "text-emerald-400" :
                        rep.collection_rate >= 40 ? "text-yellow-400" : "text-red-400"
                      )}>
                        {rep.collection_rate}% {t("analytics.rate").toLowerCase()}
                      </span>
                      {rep.overdue_count > 0 && (
                        <span className="text-[10px] text-red-400">{rep.overdue_count} {t("analytics.overdueShort").toLowerCase()}</span>
                      )}
                    </div>
                  </div>

                  <div className="hidden md:flex items-center gap-2 w-full">
                    <div className="flex-[2] min-w-0">
                      <span className="text-xs font-medium truncate block">{rep.full_name}</span>
                    </div>
                    <div className="flex-1 text-right">
                      <span className="text-xs font-medium">{fmtAED(rep.signed_amount)}</span>
                    </div>
                    <div className="flex-1 text-right">
                      <span className="text-xs">{fmtAED(rep.collected)}</span>
                    </div>
                    <div className="flex-1 text-center">
                      <span className={cn(
                        "text-xs font-mono font-medium",
                        rep.collection_rate >= 70 ? "text-emerald-400" :
                        rep.collection_rate >= 40 ? "text-yellow-400" : "text-red-400"
                      )}>
                        {rep.collection_rate}%
                      </span>
                    </div>
                    <div className="flex-1 text-right">
                      {rep.overdue_count > 0 ? (
                        <span className="text-xs text-red-400 font-medium">{rep.overdue_count}</span>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">—</span>
                      )}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
