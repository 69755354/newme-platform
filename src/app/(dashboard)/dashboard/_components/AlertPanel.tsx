"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import {
  AlertTriangle, Clock, UserX, PhoneOff, DollarSign,
  Phone, ChevronRight, X,
} from "lucide-react";

interface AlertItem {
  id: string;
  customer_name: string | null;
  phone: string | null;
  funnel_stage: string;
  alert_type: string;
  alert_message: string;
  severity: "red" | "yellow";
  assigned_to: string | null;
  days_since_contact: number | null;
  quotation_value: number | null;
  next_followup_date: string | null;
}

interface AlertsData {
  alerts: AlertItem[];
  summary: {
    total: number;
    red: number;
    yellow: number;
    byType: Record<string, number>;
  };
}

const alertIcons: Record<string, React.ReactNode> = {
  due_today: <Clock className="w-4 h-4 text-yellow-400" />,
  overdue_followup: <AlertTriangle className="w-4 h-4 text-red-400" />,
  stale_lead: <UserX className="w-4 h-4 text-red-400" />,
  over_contacted: <PhoneOff className="w-4 h-4 text-red-400" />,
  high_value_stuck: <DollarSign className="w-4 h-4 text-yellow-400" />,
  no_contact: <Phone className="w-4 h-4 text-red-400" />,
};

const alertTypeLabels: Record<string, { zh: string; en: string }> = {
  due_today: { zh: "今日到期", en: "Due Today" },
  overdue_followup: { zh: "逾期跟进", en: "Overdue" },
  stale_lead: { zh: "线索停滞", en: "Stale" },
  over_contacted: { zh: "过度联系", en: "Over-contacted" },
  high_value_stuck: { zh: "高金额卡住", en: "High-Value Stuck" },
  no_contact: { zh: "从未联系", en: "No Contact" },
};

export default function AlertPanel() {
  const router = useRouter();
  const { lang } = useLanguage();
  const [data, setData] = useState<AlertsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(false);

  const fetchAlerts = useCallback(async () => {
    try {
      const res = await fetch("/api/alerts");
      if (res.ok) {
        const json = await res.json();
        setData(json);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAlerts();
  }, [fetchAlerts]);

  if (loading) return null;
  if (!data || data.summary.total === 0) return null;

  const isZh = lang === "zh";
  const { red, yellow } = data.summary;

  // Collapsed banner view
  if (collapsed) {
    return (
      <div
        className="px-4 py-2.5 rounded-xl flex items-center justify-between cursor-pointer
          bg-red-500/10 border border-red-500/20 hover:bg-red-500/15 transition-colors"
        onClick={() => setCollapsed(false)}
      >
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-red-400" />
          <span className="text-sm font-medium text-red-300">
            {isZh
              ? `${data.summary.total} 条预警 (${red}🔴 ${yellow}🟡)`
              : `${data.summary.total} alerts (${red}🔴 ${yellow}🟡)`}
          </span>
        </div>
        <ChevronRight className="w-4 h-4 text-red-400" />
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-red-500/20 bg-red-500/5 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 flex items-center justify-between border-b border-red-500/10">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-red-400" />
          <span className="text-sm font-semibold text-red-300">
            {isZh ? "预警面板" : "Alert Panel"}
          </span>
          <span className="text-xs text-red-400/70">
            {red}🔴 {yellow}🟡
          </span>
        </div>
        <button
          onClick={() => setCollapsed(true)}
          className="p-1 rounded hover:bg-red-500/10 transition-colors"
        >
          <X className="w-4 h-4 text-red-400/70" />
        </button>
      </div>

      {/* Alert List */}
      <div className="divide-y divide-red-500/10 max-h-[400px] overflow-y-auto">
        {data.alerts.map((alert) => (
          <div
            key={`${alert.id}-${alert.alert_type}`}
            onClick={() => router.push(`/leads/${alert.id}`)}
            className="px-4 py-2.5 flex items-start gap-3 cursor-pointer
              hover:bg-red-500/10 transition-colors"
          >
            <div className="mt-0.5 shrink-0">
              {alertIcons[alert.alert_type] || <AlertTriangle className="w-4 h-4 text-gray-400" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-foreground truncate">
                  {alert.customer_name || (isZh ? "未知客户" : "Unknown")}
                </span>
                <span className={`
                  text-[10px] px-1.5 py-0.5 rounded-full font-medium
                  ${alert.severity === "red"
                    ? "bg-red-500/20 text-red-400"
                    : "bg-yellow-500/20 text-yellow-400"}
                `}>
                  {alertTypeLabels[alert.alert_type]?.[isZh ? "zh" : "en"] || alert.alert_type}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                {alert.alert_message}
              </p>
            </div>
            <ChevronRight className="w-4 h-4 text-muted-foreground/50 shrink-0 mt-1" />
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-red-500/10 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {Object.entries(data.summary.byType).map(([type, count]) => (
            <span key={type} className="mr-3">
              {alertTypeLabels[type]?.[isZh ? "zh" : "en"] || type} ×{count}
            </span>
          ))}
        </span>
        <button
          onClick={() => router.push("/leads?alert=all")}
          className="text-xs text-copper-400 hover:text-copper-300 transition-colors"
        >
          {isZh ? "查看全部 →" : "View All →"}
        </button>
      </div>
    </div>
  );
}
