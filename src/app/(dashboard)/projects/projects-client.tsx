"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { createClient } from "@/lib/supabase";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { ErrorState } from "@/components/ui/error-state";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  Search, X, ChevronDown, ChevronUp, ExternalLink,
  Calendar, DollarSign, User, MapPin, Clock,
  AlertTriangle, RefreshCw, Layers, FileText,
  Building2, Phone, Mail, ArrowLeft,
} from "lucide-react";
import Link from "next/link";

/* ─── Phase config ─── */
interface PhaseConfig {
  key: string;
  label: string;
  color: string;
  bg: string;
  border: string;
}

// Phase values must match DB CHECK constraint: projects_phase_check
const PHASES: PhaseConfig[] = [
  { key: "design", label: "Design", color: "#8B5CF6", bg: "bg-purple-500/10", border: "border-purple-500/20" },
  { key: "procurement", label: "Procurement", color: "#3B82F6", bg: "bg-blue-500/10", border: "border-blue-500/20" },
  { key: "installation", label: "Installation", color: "#F97316", bg: "bg-orange-500/10", border: "border-orange-500/20" },
  { key: "commissioning", label: "Commissioning", color: "#EAB308", bg: "bg-yellow-500/10", border: "border-yellow-500/20" },
  { key: "handover", label: "Handover", color: "#22C55E", bg: "bg-green-500/10", border: "border-green-500/20" },
  { key: "warranty", label: "Warranty", color: "#6B7280", bg: "bg-gray-500/10", border: "border-gray-500/20" },
  { key: "completed", label: "Completed", color: "#166534", bg: "bg-emerald-900/20", border: "border-emerald-800/40" },
];

const PHASE_MAP = Object.fromEntries(PHASES.map(p => [p.key, p]));

const STATUS_STYLES: Record<string, { color: string; bg: string; border: string }> = {
  active: { color: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/20" },
  on_hold: { color: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/20" },
  completed: { color: "text-muted-foreground", bg: "bg-gray-500/10", border: "border-gray-500/20" },
  cancelled: { color: "text-rose-400", bg: "bg-rose-500/10", border: "border-rose-500/20" },
};

/* ─── Types ─── */
interface Project {
  id: string;
  name: string | null;
  description: string | null;
  phase: string | null;
  status: string | null;
  property_type: string | null;
  property_size: number | null;
  location: string | null;
  quoted_amount: number | null;
  contract_amount: number | null;
  paid_amount: number | null;
  budget: number | null;
  actual_cost: number | null;
  start_date: string | null;
  end_date: string | null;
  created_at: string;
  updated_at: string;
  lead_id: string | null;
  contract_id: string | null;
  customer_id: string | null;
  sales_id: string | null;
  project_manager: string | null;
  assigned_to: string | null;
  cad_url: string | null;
  quote_url: string | null;
  ppt_url: string | null;
  contract_url: string | null;

  // Joined relations
  customer: {
    name: string | null;
    phone: string | null;
    lead: { customer_name: string | null } | null;
  } | null;
  assigned_profile: { full_name: string | null } | null;
}

/* ─── Props ─── */
interface ProjectsClientProps {
  initialData: Project[];
  fetchError?: string | null;
}

/* ─── Helpers ─── */
function fmtCurrency(v: number | null | undefined): string {
  if (v == null || v === 0) return "—";
  if (v >= 1_000_000) return `AED ${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `AED ${(v / 1_000).toFixed(0)}K`;
  return `AED ${v.toLocaleString()}`;
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-US", {
      year: "numeric", month: "short", day: "numeric",
    });
  } catch {
    return "—";
  }
}

function daysDiff(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const diff = Math.floor(
    (Date.now() - new Date(dateStr).getTime()) / 86_400_000
  );
  return diff;
}

function isPlaceholder(v: string | null | undefined): boolean {
  if (!v) return true;
  const lower = v.toLowerCase().trim();
  return lower === "unknown" || lower === "n/a" || lower === "" || lower === "-";
}

function getStatusLabel(status: string | null | undefined): string {
  if (status === "on_hold") return "OnHold";
  if (status === "active") return "Active";
  if (status === "completed") return "Completed";
  if (status === "cancelled") return "Cancelled";
  return "Active";
}

/* ─── Sort options ─── */
type SortKey = "created_at" | "name" | "start_date" | "contract_amount";
type SortDir = "asc" | "desc";

/* ════════════════════════════════════════ */
export default function ProjectsClient({ initialData, fetchError }: ProjectsClientProps) {
  const supabase = createClient();
  const { t } = useLanguage();

  const [projects, setProjects] = useState<Project[]>(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(fetchError ? (fetchError.includes(".") ? t(fetchError) : fetchError) : null);
  const [search, setSearch] = useState("");
  const [phaseFilter, setPhaseFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [memberFilter, setMemberFilter] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("created_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return;
      setUserId(user.id);
      supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single()
        .then(({ data }) => setRole(data?.role ?? null));
    });
  }, []);

  const fetchProjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    let q = supabase
      .from("projects")
      .select(
        `
          *,
          customer:customers!customer_id(
            name,
            phone,
            lead:leads!lead_id(customer_name)
          ),
          assigned_profile:profiles!assigned_to(full_name)
        `
      );

    // Sales role: only see projects assigned to them
    if (role === "sales" && userId) {
      q = q.eq("assigned_to", userId);
    }

    const { data, error: err } = await q
      .order("created_at", { ascending: false })
      .limit(500);

    if (err) {
      console.error("Failed to fetch projects:", err);
      setError(t("common.loadFailedRetry"));
      setLoading(false);
      return;
    }
    if (data) setProjects(data as Project[]);
    setLoading(false);
  }, [supabase, t, role, userId]);

  const toggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id);
  };

  /* ─── Get unique team members ─── */
  const teamMembers = useMemo(() => {
    const names = new Set<string>();
    projects.forEach((p) => {
      if (p.assigned_profile?.full_name) names.add(p.assigned_profile.full_name);
    });
    return Array.from(names).sort();
  }, [projects]);

  /* ─── Filter + Sort ─── */
  const filtered = useMemo(() => {
    let result = [...projects];

    if (phaseFilter !== "all") {
      result = result.filter(p => p.phase === phaseFilter);
    }
    if (statusFilter !== "all") {
      result = result.filter(p => p.status === statusFilter);
    }
    if (memberFilter !== "all") {
      result = result.filter(p =>
        p.assigned_profile?.full_name === memberFilter
      );
    }
    if (search.trim()) {
      const s = search.toLowerCase().trim();
      result = result.filter(p =>
        (p.name || "").toLowerCase().includes(s) ||
        (p.customer?.name || "").toLowerCase().includes(s) ||
        (p.customer?.lead?.customer_name || "").toLowerCase().includes(s) ||
        (p.location || "").toLowerCase().includes(s)
      );
    }

    result.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "name":
          cmp = (a.name || "").localeCompare(b.name || "");
          break;
        case "start_date":
          cmp = (a.start_date || "").localeCompare(b.start_date || "");
          break;
        case "contract_amount":
          cmp = (a.contract_amount || 0) - (b.contract_amount || 0);
          break;
        case "created_at":
        default:
          cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
          break;
      }
      return sortDir === "desc" ? -cmp : cmp;
    });

    return result;
  }, [projects, search, phaseFilter, statusFilter, memberFilter, sortKey, sortDir]);

  /* ─── Stats ─── */
  const stats = useMemo(() => {
    const total = projects.length;
    const active = projects.filter(p => p.status === "active").length;
    const completed = projects.filter(p => p.status === "completed" || p.phase === "completed").length;
    const overdue = projects.filter(p => {
      if (!p.end_date || p.status === "completed" || p.phase === "completed") return false;
      return new Date(p.end_date) < new Date();
    }).length;
    return { total, active, completed, overdue };
  }, [projects]);

  /* ─── Toggle sort ─── */
  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(prev => prev === "desc" ? "asc" : "desc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  /* ─── Render ─── */
  return (
    <div className="space-y-4">
      {/* Back link */}
      <Link href="/contracts" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors">
        <ArrowLeft className="w-3.5 h-3.5" />
        {t("projects.backToContracts")}
      </Link>

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight">{t("projects.title")}</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {t("projects.nProjects").replace("{n}", String(stats.total))}
          </p>
        </div>
        {error && (
          <Button variant="outline" size="sm" onClick={fetchProjects}>
            <RefreshCw className="w-3.5 h-3.5 mr-1" />
            {t("common.retry")}
          </Button>
        )}
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { key: "total", value: stats.total, icon: Layers, color: "text-blue-400", bg: "bg-blue-500/10" },
          { key: "active", value: stats.active, icon: Clock, color: "text-emerald-400", bg: "bg-emerald-500/10" },
          { key: "completed", value: stats.completed, icon: FileText, color: "text-muted-foreground", bg: "bg-gray-500/10" },
          { key: "overdue", value: stats.overdue, icon: AlertTriangle, color: "text-rose-400", bg: "bg-rose-500/10" },
        ].map((stat) => {
          const StatIcon = stat.icon;
          return (
            <Card key={stat.key} size="sm">
              <CardContent className="flex items-center gap-3 py-3">
                <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center shrink-0", stat.bg)}>
                  <StatIcon className={cn("w-4 h-4", stat.color)} />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">{t(`projects.${stat.key}`)}</p>
                  <p className="text-lg font-bold text-foreground">{stat.value}</p>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap items-center">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t("projects.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9 text-sm"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <select
          value={phaseFilter}
          onChange={(e) => setPhaseFilter(e.target.value)}
          className="h-9 px-2 text-xs rounded-lg border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary max-w-[130px]"
        >
          <option value="all">{t("projects.allPhases")}</option>
          {PHASES.map(p => (
            <option key={p.key} value={p.key}>{t(`projects.${p.key}`)}</option>
          ))}
        </select>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-9 px-2 text-xs rounded-lg border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary max-w-[110px]"
        >
          <option value="all">{t("projects.allStatuses")}</option>
          <option value="active">{t("projects.statusActive")}</option>
          <option value="on_hold">{t("projects.statusOnHold")}</option>
          <option value="completed">{t("projects.statusCompleted")}</option>
          <option value="cancelled">{t("projects.statusCancelled")}</option>
        </select>

        {teamMembers.length > 0 && (
          <select
            value={memberFilter}
            onChange={(e) => setMemberFilter(e.target.value)}
            className="h-9 px-2 text-xs rounded-lg border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary max-w-[140px]"
          >
            <option value="all">{t("projects.allMembers")}</option>
            {teamMembers.map(name => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        )}

        {/* Sort by */}
        <select
          value={`${sortKey}-${sortDir}`}
          onChange={(e) => {
            const [key, dir] = e.target.value.split("-") as [SortKey, SortDir];
            setSortKey(key);
            setSortDir(dir);
          }}
          className="h-9 px-2 text-xs rounded-lg border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary max-w-[140px]"
        >
          <option value="created_at-desc">{t("projects.sortNewest")}</option>
          <option value="created_at-asc">{t("projects.sortOldest")}</option>
          <option value="name-asc">{t("projects.sortNameAsc")}</option>
          <option value="name-desc">{t("projects.sortNameDesc")}</option>
          <option value="start_date-asc">{t("projects.sortDateAsc")}</option>
          <option value="start_date-desc">{t("projects.sortDateDesc")}</option>
          <option value="contract_amount-desc">{t("projects.sortAmountDesc")}</option>
          <option value="contract_amount-asc">{t("projects.sortAmountAsc")}</option>
        </select>

        <span className="text-xs text-muted-foreground ml-auto">
          {t("common.nResults").replace("{n}", String(filtered.length))}
        </span>
      </div>

      {/* Active filter badges */}
      {(phaseFilter !== "all" || statusFilter !== "all" || memberFilter !== "all") && (
        <div className="flex gap-1.5 flex-wrap items-center">
          {phaseFilter !== "all" && (
            <button
              onClick={() => setPhaseFilter("all")}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-purple-500/10 text-purple-400 hover:bg-purple-500/20"
            >
              {t(`projects.${phaseFilter}`)} <X className="w-3 h-3" />
            </button>
          )}
          {statusFilter !== "all" && (
            <button
              onClick={() => setStatusFilter("all")}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20"
            >
              {t(`projects.status${statusFilter === "on_hold" ? "OnHold" : statusFilter.charAt(0).toUpperCase() + statusFilter.slice(1)}`)} <X className="w-3 h-3" />
            </button>
          )}
          {memberFilter !== "all" && (
            <button
              onClick={() => setMemberFilter("all")}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-blue-500/10 text-blue-400 hover:bg-blue-500/20"
            >
              <User className="w-3 h-3" /> {memberFilter} <X className="w-3 h-3" />
            </button>
          )}
        </div>
      )}

      {/* Error state */}
      {error && !loading && (
        <ErrorState message={error} onRetry={fetchProjects} />
      )}

      {/* Loading state */}
      {loading && (
        <div className="text-center text-muted-foreground py-16 text-sm">
          <div className="animate-spin w-6 h-6 border-2 border-copper-400 border-t-transparent rounded-full mx-auto mb-3" />
          {t("common.loading")}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <Layers className="w-12 h-12 mb-3 opacity-30" />
          <p className="text-sm font-medium">{t("projects.noProjects")}</p>
          <p className="text-xs mt-1">{t("projects.noProjectsDesc")}</p>
        </div>
      )}

      {/* Projects list */}
      {!loading && !error && filtered.length > 0 && (
        <div className="space-y-2">
          {filtered.map((project) => {
            const phaseCfg = project.phase ? PHASE_MAP[project.phase] : null;
            const statusStyle = project.status ? STATUS_STYLES[project.status] : null;
            const isExpanded = expandedId === project.id;
            const endDays = daysDiff(project.end_date);
            const isOverdue = endDays !== null && endDays > 0 && project.status !== "completed" && project.phase !== "completed";

            return (
              <Card key={project.id} size="sm" className={cn(
                "transition-all duration-150",
                isOverdue && "ring-1 ring-rose-500/30",
                project.status === "cancelled" && "opacity-60",
              )}>
                {/* Main row - always visible */}
                <div
                  className="flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-accent/30 transition-colors"
                  onClick={() => toggleExpand(project.id)}
                >
                  {/* Phase badge */}
                  <div className="shrink-0 pt-0.5">
                    {phaseCfg ? (
                      <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center text-[10px] font-bold", phaseCfg.bg)} style={{ color: phaseCfg.color }}>
                        {t(`projects.${project.phase}`).slice(0, 3)}
                      </div>
                    ) : (
                      <div className="w-8 h-8 rounded-lg bg-gray-500/10 flex items-center justify-center text-[10px] text-muted-foreground">
                        —
                      </div>
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-sm font-medium text-foreground truncate max-w-[200px] sm:max-w-[300px]">
                        {project.name || t("projects.unnamed")}
                      </h3>

                      {/* Phase badge */}
                      {phaseCfg && (
                        <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full font-medium", phaseCfg.bg)} style={{ color: phaseCfg.color }}>
                          {t(`projects.${project.phase}`)}
                        </span>
                      )}

                      {/* Status badge */}
                      {statusStyle && (
                        <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full font-medium", statusStyle.bg, statusStyle.color)}>
                          {t(`projects.status${getStatusLabel(project.status)}`)}
                        </span>
                      )}

                      {/* Overdue indicator */}
                      {isOverdue && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-rose-500/10 text-rose-400 font-medium">
                          {endDays}d {t("projects.daysOverdue")}
                        </span>
                      )}
                    </div>

                    {/* Details row */}
                    <div className="flex items-center gap-3 text-[11px] text-muted-foreground mt-1 flex-wrap">
                      {project.customer?.lead?.customer_name && (
                        <span className="flex items-center gap-1">
                          <User className="w-3 h-3" />
                          {project.customer.lead.customer_name}
                        </span>
                      )}
                      {project.customer?.name && !project.customer?.lead?.customer_name && (
                        <span className="flex items-center gap-1">
                          <Building2 className="w-3 h-3" />
                          {project.customer.name}
                        </span>
                      )}
                      {project.contract_amount != null && project.contract_amount > 0 && (
                        <span className="flex items-center gap-1 font-medium text-copper-400">
                          <DollarSign className="w-3 h-3" />
                          {fmtCurrency(project.contract_amount)}
                        </span>
                      )}
                      {project.location && (
                        <span className="flex items-center gap-1">
                          <MapPin className="w-3 h-3" />
                          {project.location}
                        </span>
                      )}
                      {project.start_date && (
                        <span className="flex items-center gap-1">
                          <Calendar className="w-3 h-3" />
                          {fmtDate(project.start_date)}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Expand toggle + team */}
                  <div className="flex items-center gap-2 shrink-0">
                    {project.assigned_profile?.full_name && (
                      <span className="text-[11px] text-muted-foreground hidden sm:block">
                        {project.assigned_profile.full_name}
                      </span>
                    )}
                    <div className={cn(
                      "transition-transform duration-200 text-muted-foreground",
                      isExpanded && "rotate-180"
                    )}>
                      <ChevronDown className="w-4 h-4" />
                    </div>
                  </div>
                </div>

                {/* Expanded detail section */}
                {isExpanded && (
                  <div className="border-t border-border px-4 py-4 space-y-4 animate-in fade-in slide-in-from-top-1 duration-200">
                    {/* Project info grid */}
                    <div>
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                        {t("projects.summary")}
                      </h4>
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                        <InfoItem label={t("projects.phase")} value={phaseCfg ? t(`projects.${project.phase}`) : "—"} />
                        <InfoItem label={t("projects.status")} value={project.status ? t(`projects.status${getStatusLabel(project.status)}`) : "—"} />
                        <InfoItem label={t("projects.customer")} value={project.customer?.lead?.customer_name || project.customer?.name || "—"} />
                        <InfoItem label={t("projects.location")} value={project.location || "—"} />
                        <InfoItem label={t("projects.startDate")} value={fmtDate(project.start_date)} />
                        <InfoItem label={t("projects.endDate")} value={fmtDate(project.end_date)} />
                        {project.property_type && (
                          <InfoItem label={t("projects.propertyType")} value={project.property_type} />
                        )}
                        {project.property_size != null && (
                          <InfoItem label={t("projects.size")} value={`${project.property_size} sqm`} />
                        )}
                      </div>
                    </div>

                    {/* Financial info */}
                    <div>
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                        {t("projects.financials")}
                      </h4>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <InfoItem label={t("projects.quotedAmount")} value={fmtCurrency(project.quoted_amount)} highlight />
                        <InfoItem label={t("projects.contractAmount")} value={fmtCurrency(project.contract_amount)} highlight />
                        <InfoItem label={t("projects.paidAmount")} value={fmtCurrency(project.paid_amount)} highlight />
                        <InfoItem label={t("projects.budget")} value={fmtCurrency(project.budget)} />
                      </div>
                    </div>

                    {/* Contract info */}
                    {project.contract_url && (
                      <div>
                        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                          {t("projects.contract")}
                        </h4>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                          <InfoItem label={t("projects.contractAmount")} value={fmtCurrency(project.contract_amount)} highlight />
                          <InfoItem label={t("projects.paidAmount")} value={fmtCurrency(project.paid_amount)} highlight />
                        </div>
                        <a
                          href={project.contract_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 mt-3 text-xs text-copper-400 hover:text-copper-300 transition-colors"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                          {t("projects.viewContract")}
                        </a>
                      </div>
                    )}

                    {/* Team members */}
                    <div>
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                        {t("projects.teamMembers")}
                      </h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {project.assigned_profile?.full_name && (
                          <div className="flex items-center gap-2 text-xs text-foreground bg-accent/30 rounded-lg px-3 py-2">
                            <div className="w-7 h-7 rounded-full bg-blue-500/20 flex items-center justify-center text-[10px] font-bold text-blue-400 shrink-0">
                              {project.assigned_profile.full_name.charAt(0)}
                            </div>
                            <div className="min-w-0">
                              <p className="font-medium truncate">{project.assigned_profile.full_name}</p>
                              <p className="text-muted-foreground text-[10px]">{t("projects.assignedTo")}</p>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Description */}
                    {project.description && (
                      <div>
                        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                          {t("projects.description")}
                        </h4>
                        <p className="text-xs text-muted-foreground">{project.description}</p>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─── Info item sub-component ─── */
function InfoItem({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={cn(
        "text-sm",
        highlight && value !== "—" ? "text-copper-400 font-medium" : "text-foreground"
      )}>
        {value}
      </p>
    </div>
  );
}
