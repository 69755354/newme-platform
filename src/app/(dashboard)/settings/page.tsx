"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import {
  Users, ArrowRight, Search, Check, RefreshCw,
  ShieldCheck, User, AlertCircle, GripHorizontal, Settings,
} from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { toast } from "sonner";
import SubNavTabs from "@/components/SubNavTabs";
import KpiManagement from "./kpi-management";
import { useRequireRole } from "@/hooks/useRequireRole";
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";

/* ─── Types ─── */
interface Lead {
  id: string; customer_name: string | null; phone: string | null;
  stage: string; final_status: string | null; assigned_to: string | null; owner: string | null;
  sales_manager: string | null; location: string | null;
  source: string; quotation_value: number | null;
}

interface Profile {
  id: string; email: string | null; full_name: string | null;
  role: string;
}

const STAGES = ["new","contacted","requirement_confirmed","solution_submitted","quotation_submitted","negotiation","pending_decision","won","lost"];
const STAGE_KEYS = ["new","contacted","requirement_confirmed","solution_submitted","quotation_submitted","negotiation","pending_decision","won","lost"] as const;
/* ════════════════════════════════════════ */

function PasswordChange() {
  const { t } = useLanguage();
  const [current, setCurrent] = useState("");
  const [newPass, setNewPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  const handleChange = async () => {
    if (newPass !== confirm) {
      toast.error(t("settings.passwordMismatch"));
      return;
    }
    if (newPass.length < 6) {
      toast.error(t("settings.passwordTooShort"));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/users/change-password/password", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: newPass }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      toast.success(t("settings.passwordChanged"));
      setCurrent(""); setNewPass(""); setConfirm("");
    } catch (err: any) {
      toast.error(t("common.failedPrefix") + err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-md space-y-4">
      <h3 className="text-lg font-semibold text-foreground">{t("settings.changePassword")}</h3>
      <div className="space-y-3">
        <div>
          <label className="text-sm text-muted-foreground">{t("settings.newPassword")}</label>
          <input type="password" value={newPass} onChange={e => setNewPass(e.target.value)}
            className="w-full mt-1 bg-muted/50 border border-border/50 rounded-lg px-3 py-2 text-sm"
            placeholder={t("settings.newPasswordPlaceholder")} />
        </div>
        <div>
          <label className="text-sm text-muted-foreground">{t("settings.confirmPassword")}</label>
          <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
            className="w-full mt-1 bg-muted/50 border border-border/50 rounded-lg px-3 py-2 text-sm"
            placeholder={t("settings.confirmPasswordPlaceholder")} />
        </div>
        <button onClick={handleChange} disabled={saving}
          className="w-full px-4 py-2 text-sm font-medium bg-copper-500 text-foreground rounded-lg hover:bg-copper-600 transition-colors disabled:opacity-40">
          {saving ? t("common.saving") : t("settings.changePassword")}
        </button>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════ */
export default function SettingsPage() {
  const { t } = useLanguage();
  const { loading: roleLoading, blocked } = useRequireRole(["admin", "boss", "operator"]);

  const [leads, setLeads] = useState<Lead[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<"data" | "kpi" | "password">("data");

  // Filters
  const [stageFilter, setStageFilter] = useState<string>("all");
  const [assignFilter, setAssignFilter] = useState<string>("unassigned"); // unassigned | assigned | all
  const [search, setSearch] = useState("");

  // Selection
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectAll, setSelectAll] = useState(false);

  // Bulk action
  const [targetUserId, setTargetUserId] = useState<string>("");
  const [targetUserSearch, setTargetUserSearch] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/data");
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to fetch settings data");
      }
      const data = await res.json();
      setLeads((data.leads ?? []) as Lead[]);
      setProfiles((data.profiles ?? []) as Profile[]);
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Role guard — must be AFTER all hooks
  if (roleLoading || blocked) return <div className="text-center py-16 text-muted-foreground">{t("common.loading")}</div>;

  // Filter
  const filtered = leads.filter(l => {
    if (stageFilter !== "all" && l.stage !== stageFilter) return false;
    if (assignFilter === "unassigned" && l.assigned_to) return false;
    if (assignFilter === "assigned" && !l.assigned_to) return false;
    if (search) {
      const s = search.toLowerCase();
      return (l.customer_name?.toLowerCase().includes(s)) || (l.phone?.includes(s)) || (l.location?.toLowerCase().includes(s));
    }
    return true;
  });

  // Filter for profile search
  const filteredProfiles = profiles.filter(p =>
    !targetUserSearch || p.email?.toLowerCase().includes(targetUserSearch.toLowerCase()) || p.full_name?.toLowerCase().includes(targetUserSearch.toLowerCase())
  );

  // Toggle selection
  const toggleLead = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
    setSelectAll(false);
  };

  const toggleSelectAll = () => {
    if (selectAll) {
      setSelected(new Set());
      setSelectAll(false);
    } else {
      setSelected(new Set(filtered.map(l => l.id)));
      setSelectAll(true);
    }
  };

  // Assign single lead — uses Supabase mutation (keep as-is)
  const supabase = createClient();
  const assignLead = async (leadId: string, userId: string) => {
    setSaving(true);
    const { error } = await supabase.from("leads").update({ assigned_to: userId }).eq("id", leadId);
    if (error) { toast.error(t("common.failedPrefix") + error.message); setSaving(false); return; }
    setLeads(prev => prev.map(l => l.id === leadId ? { ...l, assigned_to: userId } : l));
    setSelected(prev => { const n = new Set(prev); n.delete(leadId); return n; });
    setSaving(false);
  };

  // Bulk assign
  const bulkAssign = async () => {
    if (!targetUserId || selected.size === 0) return;
    setSaving(true);
    const ids = Array.from(selected);
    const batchSize = 50;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const { error } = await supabase.from("leads").update({ assigned_to: targetUserId }).in("id", batch);
      if (error) { toast.error(t("common.bulkAssignFailed") + error.message); setSaving(false); return; }
    }
    setLeads(prev => prev.map(l => selected.has(l.id) ? { ...l, assigned_to: targetUserId } : l));
    setSelected(new Set());
    setSelectAll(false);
    setTargetUserId("");
    setSaving(false);
  };

  // Bulk unassign
  const bulkUnassign = async () => {
    if (selected.size === 0) return;
    setSaving(true);
    const ids = Array.from(selected);
    const batchSize = 50;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const { error } = await supabase.from("leads").update({ assigned_to: null }).in("id", batch);
      if (error) { toast.error(t("common.bulkUnassignFailed") + error.message); setSaving(false); return; }
    }
    setLeads(prev => prev.map(l => selected.has(l.id) ? { ...l, assigned_to: null } : l));
    setSelected(new Set());
    setSelectAll(false);
    setSaving(false);
  };

  // Transfer all from user A to user B
  const transferAll = async (fromUserId: string, toUserId: string) => {
    if (!fromUserId || !toUserId || fromUserId === toUserId) return;
    setSaving(true);
    const { error } = await supabase.from("leads").update({ assigned_to: toUserId }).eq("assigned_to", fromUserId);
    if (error) { toast.error(t("common.transferFailed") + error.message); setSaving(false); return; }
    setLeads(prev => prev.map(l => l.assigned_to === fromUserId ? { ...l, assigned_to: toUserId } : l));
    setSaving(false);
  };

  // Stats
  const totalUnassigned = leads.filter(l => !l.assigned_to).length;
  const activeUnassigned = leads.filter(l => !l.assigned_to && !l.final_status).length;

  if (loading) return <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">{t("common.loading")}</div>;
  if (error) return <div className="p-10 text-center text-rose-400">{t("common.error")}: {error} <button onClick={fetchData} className="underline ml-4">{t("common.retry")}</button></div>;

  return (
    <DashboardScrollContainer className="space-y-0">
      <SubNavTabs
        items={[
          { href: "/settings", labelKey: "settings.subnavSystem", iconName: "settings" },
          { href: "/team", labelKey: "settings.subnavTeam", iconName: "users" },
        ]}
      />
      <div className="space-y-6 mt-5">
      {/* Header with Tabs */}
      <div>
        <h1 className="text-2xl font-bold text-foreground tracking-tight">
          {t("settings.title")}
        </h1>
        <div className="flex gap-1 mt-3 border-b border-border/50">
          <button
            onClick={() => setActiveTab("data")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "data"
                ? "border-copper-500 text-copper-400"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t("settingsTab.dataManagement")}
          </button>
          <button
            onClick={() => setActiveTab("kpi")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "kpi"
                ? "border-copper-500 text-copper-400"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t("settingsTab.kpiManagement")}
          </button>
          <button
            onClick={() => setActiveTab("password")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "password"
                ? "border-copper-500 text-copper-400"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t("settingsTab.password")}
          </button>
        </div>
      </div>

      {activeTab === "kpi" ? (
        <KpiManagement />
      ) : activeTab === "password" ? (
        <PasswordChange />
      ) : (
      <>
      {/* ═══════ Original data management content ═══════ */}
      {/* Stats row */}
        <button onClick={fetchData} disabled={saving} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground border border-border rounded-lg transition-colors">
          <RefreshCw className={cn("w-3.5 h-3.5", saving && "animate-spin")} />
          {t("settings.refresh")}
        </button>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="p-4 rounded-xl border border-border/50 bg-card/50">
          <p className="text-xs text-muted-foreground">{t("settings.totalLeads")}</p>
          <p className="text-2xl font-bold text-foreground mt-1">{leads.length}</p>
        </div>
        <div className="p-4 rounded-xl border border-amber-500/20 bg-amber-500/5">
          <p className="text-xs text-amber-400">{t("settings.unassigned")}</p>
          <p className="text-2xl font-bold text-amber-400 mt-1">{totalUnassigned}</p>
          <p className="text-[10px] text-amber-400/60">{t("settings.activeUnassigned").replace("{n}", String(activeUnassigned))}</p>
        </div>
        <div className="p-4 rounded-xl border border-border/50 bg-card/50">
          <p className="text-xs text-muted-foreground">{t("settings.salesTeam")}</p>
          <p className="text-2xl font-bold text-foreground mt-1">{profiles.length || "-"}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 bg-muted/50 rounded-lg p-1">
          {[{ key: "unassigned" }, { key: "assigned" }, { key: "all" }].map(f => (
            <button key={f.key} onClick={() => { setAssignFilter(f.key); setSelected(new Set()); setSelectAll(false); }}
              className={cn("px-3 py-1 text-xs rounded-md transition-colors",
                assignFilter === f.key ? "bg-background text-foreground font-medium shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}>{t("settings.filter" + f.key.charAt(0).toUpperCase() + f.key.slice(1))}</button>
          ))}
        </div>
        <select value={stageFilter} onChange={e => setStageFilter(e.target.value)}
          className="bg-muted/50 border border-border/50 rounded-lg px-3 py-1.5 text-xs text-muted-foreground focus:outline-none focus:border-copper-500/50"
        >
          <option value="all">{t("settings.allStages")}</option>
          {STAGES.map(s => <option key={s} value={s}>{t(`stages.${s}`)}</option>)}
        </select>
        <div className="flex items-center gap-1.5 bg-muted/50 border border-border/50 rounded-lg px-3 py-1.5 flex-1 max-w-xs">
          <Search className="w-3.5 h-3.5 text-muted-foreground" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t("settings.searchPlaceholder")}
            className="bg-transparent text-xs text-foreground placeholder:text-muted-foreground/60 outline-none flex-1"
          />
        </div>
      </div>

      {/* Bulk Action Bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 p-3 rounded-lg bg-copper-500/10 border border-copper-500/20">
          <span className="text-sm text-copper-400 font-medium">{selected.size} {t("settings.selected")}</span>
          <div className="flex items-center gap-2 ml-auto">
            <select value={targetUserId} onChange={e => setTargetUserId(e.target.value)}
              className="bg-background border border-border/50 rounded-lg px-3 py-1.5 text-xs focus:outline-none"
            >
              <option value="">{t("settings.selectSales")}</option>
              {profiles.map(p => (
                <option key={p.id} value={p.id}>{p.full_name || p.email || p.id.slice(0,8)} ({p.role})</option>
              ))}
            </select>
            <button onClick={bulkAssign} disabled={!targetUserId || saving}
              className="px-3 py-1.5 text-xs font-medium bg-copper-500 text-foreground rounded-lg hover:bg-copper-600 transition-colors disabled:opacity-40"
            >{t("settings.bulkAssign")}</button>
            <button onClick={bulkUnassign} disabled={saving}
              className="px-3 py-1.5 text-xs text-rose-400 border border-rose-500/30 rounded-lg hover:bg-rose-500/10 transition-colors"
            >{t("settings.bulkUnassign")}</button>
          </div>
        </div>
      )}

      {/* Lead Table */}
      <div className="rounded-xl border border-border/50 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/50 bg-muted/30">
                <th className="py-2.5 px-3 text-left">
                  <input type="checkbox" checked={selectAll} onChange={toggleSelectAll}
                    className="w-4 h-4 rounded border-border accent-copper-500" />
                </th>
                <th className="py-2.5 px-3 text-left text-muted-foreground font-medium text-xs">{t("settings.customer")}</th>
                <th className="py-2.5 px-3 text-left text-muted-foreground font-medium text-xs">{t("settings.stage")}</th>
                <th className="py-2.5 px-3 text-left text-muted-foreground font-medium text-xs">{t("settings.owner")}</th>
                <th className="py-2.5 px-3 text-right text-muted-foreground font-medium text-xs">{t("settings.action")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 100).map(lead => {
                const isSel = selected.has(lead.id);
                const ownerProfile = lead.assigned_to ? profiles.find(p => p.id === lead.assigned_to) : null;
                return (
                  <tr key={lead.id} className={cn("border-b border-border/20 hover:bg-accent/30 transition-colors", isSel && "bg-copper-500/5")}>
                    <td className="py-2.5 px-3">
                      <input type="checkbox" checked={isSel} onChange={() => toggleLead(lead.id)}
                        className="w-4 h-4 rounded border-border accent-copper-500" />
                    </td>
                    <td className="py-2.5 px-3">
                      <p className="font-medium text-foreground text-sm">{lead.customer_name || "-"}</p>
                      <p className="text-[11px] text-muted-foreground">{lead.phone} · {lead.location}</p>
                    </td>
                    <td className="py-2.5 px-3">
                      <span className={cn("text-xs px-2 py-0.5 rounded-full",
                        lead.final_status === "won" ? "bg-emerald-500/10 text-emerald-400" :
                        lead.final_status === "lost" ? "bg-gray-500/10 text-muted-foreground" :
                        "bg-muted text-muted-foreground"
                      )}>{t(`stages.${lead.final_status || lead.stage}`) || lead.final_status || lead.stage}</span>
                    </td>
                    <td className="py-2.5 px-3">
                      {lead.assigned_to ? (
                        <span className="text-xs">
                          <span className="text-foreground">{ownerProfile?.full_name || ownerProfile?.email || "—"}</span>
                          {ownerProfile && <span className="text-muted-foreground ml-1">· {ownerProfile.role}</span>}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground/60 italic">{t("leads.unassigned")}</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      {profiles.length > 0 ? (
                        <select
                          value={lead.assigned_to || ""}
                          onChange={e => { if (e.target.value) assignLead(lead.id, e.target.value); }}
                          disabled={saving}
                          className="bg-muted/50 border border-border/50 rounded-lg px-2 py-1 text-xs focus:outline-none max-w-[140px]"
                        >
                          <option value="">{t("settings.unassigned")}</option>
                          {profiles.map(p => (
                            <option key={p.id} value={p.id}>{p.full_name || p.email || p.id.slice(0,8)}</option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">{t("settings.noProfiles")}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && (
          <div className="py-16 text-center text-muted-foreground text-sm">
            <AlertCircle className="w-8 h-8 mx-auto mb-2 opacity-30" />
            {t("settings.noMatching")}
          </div>
        )}
        {filtered.length > 100 && (
          <div className="py-3 px-4 text-center text-xs text-muted-foreground border-t border-border/30">
            {t("settings.showingN").replace("{n}", "100").replace("{total}", String(filtered.length))}
          </div>
        )}
      </div>

      {/* Transfer All */}
      {profiles.length >= 2 && (
        <div className="rounded-xl border border-border/50 p-5">
          <div className="flex items-center gap-2 mb-3">
            <GripHorizontal className="w-4 h-4 text-orange-400" />
            <h3 className="text-sm font-semibold text-foreground">{t("settings.bulkTransfer")}</h3>
          </div>
          <p className="text-xs text-muted-foreground mb-4">{t("settings.transferDesc")}</p>
          <div className="flex items-center gap-3">
            <select id="from-user" className="bg-muted/50 border border-border/50 rounded-lg px-3 py-2 text-sm min-w-[180px]">
              <option value="">{t("settings.source")}</option>
              {profiles.filter(p => p.role === 'sales').map(p => (
                <option key={p.id} value={p.id}>{p.full_name || p.email || p.id.slice(0,8)}</option>
              ))}
            </select>
            <ArrowRight className="w-4 h-4 text-muted-foreground" />
            <select id="to-user" className="bg-muted/50 border border-border/50 rounded-lg px-3 py-2 text-sm min-w-[180px]">
              <option value="">{t("settings.target")}</option>
              {profiles.filter(p => p.role === 'sales').map(p => (
                <option key={p.id} value={p.id}>{p.full_name || p.email || p.id.slice(0,8)}</option>
              ))}
            </select>
            <button onClick={() => {
              const from = (document.getElementById("from-user") as HTMLSelectElement)?.value;
              const to = (document.getElementById("to-user") as HTMLSelectElement)?.value;
              if (from && to) transferAll(from, to);
            }} disabled={saving}
              className="px-4 py-2 text-sm font-medium bg-orange-500 text-foreground rounded-lg hover:bg-orange-600 transition-colors disabled:opacity-40"
            >{t("settings.transferAll")}</button>
          </div>
        </div>
      )}
      </>
      )}
    </div>
    </DashboardScrollContainer>
  );
}
