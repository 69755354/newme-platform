"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase";
import { useUserRole } from "@/hooks/useUserRole";
import { useLanguage } from "@/lib/i18n/context";
import {
  Users, UserPlus, Activity, Clock,
  AlertTriangle, Phone, MessageSquare, FileText,
} from "lucide-react";
import Link from "next/link";

/* ─── Types ─── */
interface LeadHealthData {
  totalLeads: number;
  weeklyNew: number;
  activeCount: number;
  activePct: number;
  dormantCount: number;
  dormantPct: number;
  zeroCount: number;
  zeroPct: number;
  qualityBreakdown: Record<string, number>;
  overdue: OverdueItem[];
  isCEO: boolean;
}

interface OverdueItem {
  id: string;
  customer_name: string | null;
  assigned_to: string | null;
  assigned_name: string | null;
  stage: string;
  last_contact_date: string | null;
  next_followup_date: string | null;
  overdue_days: number;
  quotation_value: number | null;
}

/* ─── Helpers ─── */
function fmtAED(v: number | null | undefined): string {
  if (v == null || v === 0) return "—";
  if (v >= 1_000_000) return `AED ${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `AED ${(v / 1_000).toFixed(0)}K`;
  return `AED ${v.toLocaleString()}`;
}

function fmtDate(d: string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

function getStageLabels(t: any): Record<string, string> {
  return {
    new: t("stageLabels.new"),
    contacted: t("stageLabels.contacted"),
    no_answered: t("stageLabels.no_answered"),
    requirement_confirmed: t("stageLabels.requirement_confirmed"),
    solution_submitted: t("stageLabels.solution_submitted"),
    quotation_submitted: t("stageLabels.quotation_submitted"),
    negotiation: t("stageLabels.negotiation"),
    pending_decision: t("stageLabels.pending_decision"),
    won: t("stageLabels.won"),
    lost: t("stageLabels.lost"),
    fake: t("stageLabels.fake"),
  };
}

const STAGE_COLORS: Record<string, string> = {
  new: "bg-gray-500/20 text-gray-300",
  contacted: "bg-amber-500/20 text-amber-300",
  requirement_confirmed: "bg-yellow-500/20 text-yellow-300",
  solution_submitted: "bg-pink-500/20 text-pink-300",
  quotation_submitted: "bg-purple-500/20 text-purple-300",
  negotiation: "bg-blue-500/20 text-blue-300",
  pending_decision: "bg-orange-500/20 text-orange-300",
  won: "bg-green-500/20 text-green-300",
  lost: "bg-gray-500/20 text-gray-400",
};

const QUALITY_COLORS: Record<string, string> = {
  pending: "bg-amber-500",
  good: "bg-green-500",
  bad: "bg-red-500",
  unknown: "bg-gray-500",
};

function getQualityLabels(t: any): Record<string, string> {
  return {
    pending: t("analytics.qualityPending"),
    good: t("analytics.qualityGood"),
    bad: t("analytics.qualityBad"),
    unknown: t("analytics.qualityUnknown"),
  };
}

/* ─── Stat Card ─── */
function StatCard({ icon: Icon, label, value, sub, color }: {
  icon: React.ElementType; label: string; value: string | number; sub?: string; color?: string;
}) {
  return (
    <div className="bg-card border border-border rounded-xl p-4 flex items-start gap-3">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${color || "bg-wine-500/10"}`}>
        <Icon className={`w-5 h-5 ${color ? "text-white" : "text-wine-500"}`} />
      </div>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-xl font-bold text-foreground">{value}</p>
        {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

/* ─── Quality Bar ─── */
function QualityBar({ breakdown, total, qualityLabels }: {
  breakdown: Record<string, number>; total: number; qualityLabels: Record<string, string>;
}) {
  const order = ["pending", "good", "bad", "unknown"];
  const bars = order.map((key) => ({
    key,
    count: breakdown[key] ?? 0,
    pct: total > 0 ? ((breakdown[key] ?? 0) / total) * 100 : 0,
  }));

  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <h3 className="text-sm font-semibold text-foreground mb-3">Quality Distribution</h3>
      <div className="flex h-5 rounded-full overflow-hidden mb-3">
        {bars.map((b) =>
          b.count > 0 ? (
            <div
              key={b.key}
              className={`${QUALITY_COLORS[b.key]} transition-all`}
              style={{ width: `${b.pct}%` }}
              title={`${qualityLabels[b.key]}: ${b.count}`}
            />
          ) : null
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        {bars.map((b) => (
          <div key={b.key} className="flex items-center gap-2">
            <div className={`w-2.5 h-2.5 rounded-full ${QUALITY_COLORS[b.key]}`} />
            <span className="text-muted-foreground">{qualityLabels[b.key]}</span>
            <span className="text-foreground font-medium ml-auto">{b.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Overdue Table (CEO) ─── */
function OverdueTable({ items, stageLabels, t }: {
  items: OverdueItem[]; stageLabels: Record<string, string>; t: any;
}) {
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
        <Clock className="w-4 h-4 text-rose-400" />
        {t("analytics.overdueFollowups")} ({items.length})
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted-foreground border-b border-border">
              <th className="text-left py-2 pr-2 font-medium">{t("analytics.customerTable")}</th>
              <th className="text-left py-2 px-2 font-medium">{t("analytics.assignedTo")}</th>
              <th className="text-right py-2 px-2 font-medium">{t("analytics.overdueTable")}</th>
              <th className="text-left py-2 px-2 font-medium">{t("analytics.stageTable")}</th>
              <th className="text-left py-2 pl-2 font-medium">{t("analytics.lastContact")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr
                key={item.id}
                className="border-b border-border/50 hover:bg-accent/50 cursor-pointer transition-colors"
                onClick={() => window.open(`/leads/${item.id}`, "_self")}
              >
                <td className="py-2.5 pr-2 font-medium text-foreground">
                  {item.customer_name || t("analytics.unnamed")}
                  {item.quotation_value ? (
                    <span className="text-muted-foreground ml-1">({fmtAED(item.quotation_value)})</span>
                  ) : null}
                </td>
                <td className="py-2 px-2 text-muted-foreground">{item.assigned_name || "—"}</td>
                <td className={`py-2 px-2 text-right font-mono font-bold ${
                  item.overdue_days >= 7 ? "text-rose-400" : item.overdue_days >= 3 ? "text-amber-400" : "text-muted-foreground"
                }`}>
                  {item.overdue_days}d
                </td>
                <td className="py-2 px-2">
                  <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${STAGE_COLORS[item.stage] || "bg-gray-500/20 text-gray-300"}`}>
                    {stageLabels[item.stage] || item.stage}
                  </span>
                </td>
                <td className="py-2 pl-2 text-muted-foreground">
                  {fmtDate(item.last_contact_date)}
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={5} className="py-8 text-center text-muted-foreground">
                  🎉 {t("analytics.noOverdueCEO")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ─── Overdue List (Sales) ─── */
function SalesOverdueList({ items, stageLabels, t }: {
  items: OverdueItem[]; stageLabels: Record<string, string>; t: any;
}) {
  const supabase = createClient();

  const addNote = async (leadId: string) => {
    const note = prompt("Add a quick note for this follow-up:");
    if (!note) return;
    await supabase.from("activities").insert({
      lead_id: leadId,
      type: "note",
      content: note,
      user_id: (await supabase.auth.getUser()).data.user?.id,
    });
    alert("Note added!");
  };

  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 text-rose-400" />
        My Overdue Follow-ups ({items.length})
      </h3>
      <div className="space-y-2">
        {items.map((item) => (
          <div key={item.id} className="flex items-center justify-between p-3 rounded-lg bg-rose-500/5 border border-rose-500/10">
            <Link href={`/leads/${item.id}`} className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground truncate">
                {item.customer_name || t("analytics.unnamed")}
                {item.quotation_value ? (
                  <span className="text-muted-foreground ml-1">({fmtAED(item.quotation_value)})</span>
                ) : null}
              </p>
              <p className="text-xs text-muted-foreground">
                {item.overdue_days}d {t("analytics.overduePrefix")} · {stageLabels[item.stage] || item.stage} · {t("analytics.lastContact")}: {fmtDate(item.last_contact_date)}
              </p>
            </Link>
            <div className="flex items-center gap-1 shrink-0 ml-2">
              <button
                onClick={() => window.open(`tel:${item.customer_name}`, "_self")}
                className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors"
                title={t("analytics.call")}
              >
                <Phone className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => window.open(`https://wa.me/?text=${encodeURIComponent(`Hi ${item.customer_name}, following up on your enquiry`)}`, "_blank")}
                className="p-1.5 rounded-lg bg-green-500/10 text-green-400 hover:bg-green-500/20 transition-colors"
                title={t("analytics.whatsapp")}
              >
                <MessageSquare className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => addNote(item.id)}
                className="p-1.5 rounded-lg bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-colors"
                title={t("analytics.addNote")}
              >
                <FileText className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}
        {items.length === 0 && (
          <div className="py-8 text-center text-muted-foreground text-sm">
            🎉 {t("analytics.noOverdue")}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Main Component ─── */
export default function LeadHealth() {
  const { isCEO } = useUserRole();
  const { t } = useLanguage();

  const STAGE_I18N_KEYS: Record<string, string> = {
    new: t("pipeline.stageNew"), contacted: t("pipeline.stageContacted"), requirement_confirmed: t("pipeline.stageReqConfirmed"),
    solution_submitted: t("pipeline.stageSolutionSub"), quotation_submitted: t("pipeline.stageQuotationSub"),
    negotiation: t("pipeline.stageNegotiation"), pending_decision: t("pipeline.stagePendingDecision"),
    won: t("pipeline.stageWon"), lost: t("pipeline.stageLost"),
  };
  const [data, setData] = useState<LeadHealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/dashboard/lead-health")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setData(d);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="bg-card border border-border rounded-xl p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-5 bg-accent rounded w-1/3" />
          <div className="grid grid-cols-2 gap-3">
            {[1, 2, 3, 4].map((i) => <div key={i} className="h-20 bg-accent rounded" />)}
          </div>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-card border border-border rounded-xl p-6">
        <p className="text-sm text-rose-400">Failed to load: {error || "No data"}</p>
      </div>
    );
  }

  if (isCEO) {
    return (
      <div className="space-y-4">
        <h2 className="text-base font-semibold text-foreground">📊 Lead Health</h2>

        {/* Stat cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            icon={Users}
            label="Total Leads"
            value={data.totalLeads.toLocaleString()}
            sub={`+${data.weeklyNew} this week`}
            color="bg-wine-500/10"
          />
          <StatCard
            icon={Activity}
            label="Active"
            value={`${data.activePct}%`}
            sub={`${data.activeCount} leads`}
            color="bg-emerald-500/10"
          />
          <StatCard
            icon={Clock}
            label="Dormant"
            value={`${data.dormantPct}%`}
            sub={`${data.dormantCount} leads`}
            color="bg-amber-500/10"
          />
          <StatCard
            icon={UserPlus}
            label="Zero Follow-up"
            value={`${data.zeroPct}%`}
            sub={`${data.zeroCount} leads`}
            color="bg-rose-500/10"
          />
        </div>

        {/* Quality + Overdue 2-col */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <QualityBar breakdown={data.qualityBreakdown} total={data.totalLeads} qualityLabels={{ good: t("analytics.qualityGood"), pending: t("analytics.qualityPending"), bad: t("analytics.qualityBad") }} />
          <OverdueTable items={data.overdue} stageLabels={STAGE_I18N_KEYS} t={t} />
        </div>
      </div>
    );
  }

  // ── Sales view ──
  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-foreground">📊 My Lead Health</h2>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard
          icon={Users}
          label="My Leads"
          value={data.totalLeads.toLocaleString()}
          sub={`+${data.weeklyNew} this week`}
          color="bg-wine-500/10"
        />
        <StatCard
          icon={Activity}
          label="Active"
          value={`${data.activePct}%`}
          sub={`${data.activeCount} leads`}
          color="bg-emerald-500/10"
        />
        <StatCard
          icon={Clock}
          label="Dormant"
          value={`${data.dormantPct}%`}
          sub={`${data.dormantCount} leads`}
          color="bg-amber-500/10"
        />
        <StatCard
          icon={UserPlus}
          label="Zero Follow-up"
          value={`${data.zeroPct}%`}
          sub={`${data.zeroCount} leads`}
          color="bg-rose-500/10"
        />
      </div>

      {/* Quality */}
      <QualityBar breakdown={data.qualityBreakdown} total={data.totalLeads} qualityLabels={{ good: t("analytics.qualityGood"), pending: t("analytics.qualityPending"), bad: t("analytics.qualityBad") }} />

      {/* Overdue with action buttons */}
      <SalesOverdueList items={data.overdue} stageLabels={STAGE_I18N_KEYS} t={t} />
    </div>
  );
}
