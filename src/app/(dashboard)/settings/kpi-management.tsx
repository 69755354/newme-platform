"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Target, TrendingUp, Wallet, Save, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { useLanguage } from "@/lib/i18n/LanguageContext";

interface Profile { id: string; full_name: string | null; email: string | null; role: string; }
interface KpiTarget { id: string; period: string; target_type: string; target_amount: number; assigned_to: string | null; notes: string | null; profiles?: { full_name: string | null } | null; }

export default function KpiManagement() {
  const { t, lang } = useLanguage();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [targets, setTargets] = useState<KpiTarget[]>([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const currentPeriod = new Date().toISOString().slice(0, 7); // "2026-06"
  const [period, setPeriod] = useState(currentPeriod);

  // Form state
  const [companySigning, setCompanySigning] = useState("");
  const [companyCollection, setCompanyCollection] = useState("");
  const [salesSigningTargets, setSalesSigningTargets] = useState<Record<string, string>>({});
  const [salesCollectionTargets, setSalesCollectionTargets] = useState<Record<string, string>>({});

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/settings/data?period=${period}`);
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();

      // Filter profiles to sales only
      const salesProfiles = ((data.profiles ?? []) as any[]).filter((p: any) => p.role === "sales");
      setProfiles(salesProfiles as Profile[]);

      const kpiData = (data.kpiTargets ?? []) as KpiTarget[];
      setTargets(kpiData);

      // Populate form
      const signing = kpiData.find((t: KpiTarget) => t.target_type === "signing" && !t.assigned_to);
      const collection = kpiData.find((t: KpiTarget) => t.target_type === "collection" && !t.assigned_to);
      const sig: Record<string, string> = {};
      const col: Record<string, string> = {};
      kpiData.forEach((t: KpiTarget) => {
        if (t.target_type === "signing" && t.assigned_to) sig[t.assigned_to] = t.target_amount.toString();
        if (t.target_type === "collection" && t.assigned_to) col[t.assigned_to] = t.target_amount.toString();
      });
      setCompanySigning(signing?.target_amount?.toString() || "");
      setCompanyCollection(collection?.target_amount?.toString() || "");
      setSalesSigningTargets(sig);
      setSalesCollectionTargets(col);
    } catch {
      // silently fail
    }
    setLoading(false);
  }, [period]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSave = async () => {
    setSaving(true);
    const payload = { period, targets: [] as any[] };

    // Company targets
    if (companySigning) {
      payload.targets.push({ target_type: "signing", target_amount: parseFloat(companySigning), assigned_to: null });
    }
    if (companyCollection) {
      payload.targets.push({ target_type: "collection", target_amount: parseFloat(companyCollection), assigned_to: null });
    }

    // Sales targets
    for (const p of profiles) {
      const sv = salesSigningTargets[p.id];
      if (sv) {
        payload.targets.push({ target_type: "signing", target_amount: parseFloat(sv), assigned_to: p.id });
      }
      const cv = salesCollectionTargets[p.id];
      if (cv) {
        payload.targets.push({ target_type: "collection", target_amount: parseFloat(cv), assigned_to: p.id });
      }
    }

    const res = await fetch("/api/kpi/targets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      fetchData();
      toast.success(t("kpi.kpiSaved"));

      // Notify salespeople whose KPI targets were set/updated
      import("@/lib/notify").then(({ notify }) => {
        for (const p of profiles) {
          const sv = salesSigningTargets[p.id];
          const cv = salesCollectionTargets[p.id];
          if (sv) {
            notify({ type: "kpi_target_set", period, assigned_to: p.id, target_type: "signing", target_amount: parseFloat(sv) });
          }
          if (cv) {
            notify({ type: "kpi_target_set", period, assigned_to: p.id, target_type: "collection", target_amount: parseFloat(cv) });
          }
        }
      });
    } else {
      const err = await res.json();
      toast.error(t("kpi.saveFailed") + ": " + err.error);
    }
    setSaving(false);
  };

  const fmtAED = (v: number) => v >= 1_000_000 ? `AED ${(v/1_000_000).toFixed(1)}M` : `AED ${v.toLocaleString()}`;

  const months: string[] = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(d.toISOString().slice(0, 7));
  }

  if (loading) return <div className="text-muted-foreground py-8 text-center">{t("common.loading")}</div>;

  return (
    <div className="space-y-6">
      {/* Period selector */}
      <div className="flex items-center gap-3">
        <Target className="w-5 h-5 text-copper-400" />
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="bg-muted/50 border border-border/50 rounded-lg px-3 py-2 text-sm font-medium"
        >
          {months.map(m => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">
          {period === currentPeriod ? t("kpi.currentMonth") : t("kpi.historyView")}
        </span>
      </div>

      {/* Company KPI */}
      <div className="rounded-xl border border-border/50 p-5">
        <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-copper-400" />
          {t("kpi.companyTarget")}（{period}）
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-muted-foreground mb-1.5 block">{t("kpi.signingTarget")}</label>
            <Input
              type="number"
              value={companySigning}
              onChange={(e) => setCompanySigning(e.target.value)}
              placeholder={t("kpi.signingPlaceholder")}
              className="h-9"
              disabled={period !== currentPeriod}
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1.5 block">{t("kpi.collectionTarget")}</label>
            <Input
              type="number"
              value={companyCollection}
              onChange={(e) => setCompanyCollection(e.target.value)}
              placeholder={t("kpi.collectionPlaceholder")}
              className="h-9"
              disabled={period !== currentPeriod}
            />
          </div>
        </div>
      </div>

      {/* Sales KPI */}
      <div className="rounded-xl border border-border/50 p-5">
        <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
          <Wallet className="w-4 h-4 text-copper-400" />
          {t("kpi.salesTarget")}（{period}）
        </h3>
        <div className="space-y-3">
          {profiles.map(p => (
            <div key={p.id} className="flex items-center gap-3">
              <span className="text-sm w-32 shrink-0 truncate">{p.full_name || p.email}</span>
              <Input
                type="number"
                value={salesSigningTargets[p.id] || ""}
                onChange={(e) => setSalesSigningTargets(prev => ({ ...prev, [p.id]: e.target.value }))}
                placeholder={t("kpi.salesSigningPlaceholder")}
                className="h-9 flex-1"
                disabled={period !== currentPeriod}
              />
              <Input
                type="number"
                value={salesCollectionTargets[p.id] || ""}
                onChange={(e) => setSalesCollectionTargets(prev => ({ ...prev, [p.id]: e.target.value }))}
                placeholder={t("kpi.salesCollectionPlaceholder")}
                className="h-9 flex-1"
                disabled={period !== currentPeriod}
              />
            </div>
          ))}
        </div>
        {period !== currentPeriod && (
          <p className="text-xs text-muted-foreground mt-3">{t("kpi.historyReadOnly")}</p>
        )}
      </div>

      {/* Save */}
      {period === currentPeriod && (
        <Button onClick={handleSave} disabled={saving} className="gap-2">
          <Save className="w-4 h-4" />
          {saving ? t("common.saving") : t("kpi.saveKpi")}
        </Button>
      )}
    </div>
  );
}
