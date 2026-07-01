"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { useRequireRole } from "@/hooks/useRequireRole";
import { Card, CardContent } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn, fmtDubai } from "@/lib/utils";
import SubNavTabs from "@/components/SubNavTabs";
import { Toaster, toast } from "sonner";
import {
  FileText,
  DollarSign,
  Calendar,
  User,
  Clock,
  Plus,
  Search,
  X,
  ChevronLeft,
  ChevronRight,
  Filter,
  RefreshCw,
  Eye,
} from "lucide-react";

/* ─── Types ─── */
interface Quotation {
  id: string;
  lead_id: string | null;
  quote_no: string | null;
  version: number | null;
  subtotal: number | null;
  discount_rate: number | null;
  discount_amount: number | null;
  tax_rate: number | null;
  tax_amount: number | null;
  total_amount: number | null;
  currency: string | null;
  valid_until: string | null;
  payment_terms: string | null;
  delivery_terms: string | null;
  status: string;
  pdf_url: string | null;
  ppt_url: string | null;
  notes: string | null;
  internal_notes: string | null;
  sent_at: string | null;
  accepted_at: string | null;
  rejected_at: string | null;
  created_at: string;
  updated_at: string;
  leads?: { customer_name: string | null; phone: string | null } | null;
}

/* ─── Status config ─── */
const STATUS_STYLES: Record<string, { color: string; bg: string; border: string }> = {
  draft: { color: "text-muted-foreground", bg: "bg-gray-500/10", border: "border-gray-500/20" },
  sent: { color: "text-blue-400", bg: "bg-blue-500/10", border: "border-blue-500/20" },
  accepted: { color: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/20" },
  rejected: { color: "text-rose-400", bg: "bg-rose-500/10", border: "border-rose-500/20" },
  expired: { color: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/20" },
};

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  sent: "Sent",
  accepted: "Accepted",
  rejected: "Rejected",
  expired: "Expired",
};

const QUOTE_STATUSES = ["all", "draft", "sent", "accepted", "rejected", "expired"];

/* ─── Helpers ─── */
function fmtAED(v: number | null | undefined): string {
  if (v == null) return "—";
  if (v >= 1_000_000) return `AED ${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `AED ${(v / 1_000).toFixed(0)}K`;
  return `AED ${v.toLocaleString()}`;
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  try {
    return fmtDubai(d, { locale: "en-US", year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "—";
  }
}

function isPlaceholder(v: string | null | undefined): boolean {
  if (!v) return true;
  const lower = v.toLowerCase().trim();
  return lower === "unknown" || lower === "n/a" || lower === "" || lower === "-";
}

/* ════════════════════════════════════════ */
export default function QuotationsPage() {
  const { loading: roleLoading, blocked } = useRequireRole([
    "admin",
    "boss",
    "operator",
    "sales",
  ]);
  const supabase = createClient();
  const { t, lang } = useLanguage();

  /* ─── State ─── */
  const [quotations, setQuotations] = useState<Quotation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  // Pagination
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [totalCount, setTotalCount] = useState(0);

  // Current user
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  /* ─── Auth ─── */
  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) setCurrentUserId(user.id);
    });
  }, []);

  /* ─── Fetch data ─── */
  const fetchQuotations = useCallback(async () => {
    if (!currentUserId) return;
    setLoading(true);
    setError(null);

    try {
      let q = supabase
        .from("quotations")
        .select("*, leads(customer_name, phone)", { count: "exact" })
        .order("created_at", { ascending: false });

      // Status filter
      if (statusFilter !== "all") {
        q = q.eq("status", statusFilter);
      }

      // Search filter (quote_no or customer name via leads join)
      if (search.trim()) {
        const s = search.toLowerCase().trim();
        q = q.or(
          `quote_no.ilike.%${s}%,leads.customer_name.ilike.%${s}%`
        );
      }

      // Pagination
      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;
      q = q.range(from, to);

      const { data, error: err, count } = await q;

      if (err) {
        console.error("Failed to fetch quotations:", err);
        setError(t("common.loadFailedRetry"));
        return;
      }

      if (data) {
        setQuotations(data as Quotation[]);
        setTotalCount(count ?? 0);
      }
    } catch (err: any) {
      console.error("Fetch error:", err);
      setError(t("common.loadFailedRetry"));
    } finally {
      setLoading(false);
    }
  }, [currentUserId, page, statusFilter, search, supabase]);

  useEffect(() => {
    if (currentUserId) {
      fetchQuotations();
    }
  }, [currentUserId, fetchQuotations]);

  /* ─── Reset page on filter change ─── */
  useEffect(() => {
    setPage(1);
  }, [statusFilter, search]);

  if (roleLoading || blocked) return null;

  if (loading && quotations.length === 0)
    return (
      <div className="text-muted-foreground p-8">{t("common.loading")}</div>
    );

  if (error)
    return <ErrorState message={error} onRetry={() => window.location.reload()} />;

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const totalValue = quotations.reduce(
    (sum, q) => sum + (q.total_amount || 0),
    0
  );

  const getCustomerName = (q: Quotation): string => {
    const name = q.leads?.customer_name;
    if (name && !isPlaceholder(name)) return name;
    return t("common.unnamed") || "Unnamed";
  };

  return (
    <div className="space-y-0">
      <SubNavTabs
        items={[
          { href: "/quotations", labelKey: "quotations.subnavQuotations", iconName: "file-text" },
          { href: "/quotes", labelKey: "quotes.subnavQuotes", iconName: "calculator" },
        ]}
      />

      {/* ─── Header ─── */}
      <div className="flex items-center justify-between mb-6 mt-5 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight">
            {t("quotations.title") || "Quotations"}
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {totalCount} {t("quotations.total") || "total"} · {fmtAED(totalValue)}{" "}
            {t("quotations.value") || "value"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={fetchQuotations}
            className="h-9"
            title={t("quotations.refresh") || "Refresh"}
          >
            <RefreshCw className="w-4 h-4" />
          </Button>
          <Button
            size="sm"
            onClick={() => (window.location.href = "/quotes")}
            className="bg-copper-500 hover:bg-copper-600 text-foreground"
          >
            <Plus className="w-4 h-4 mr-1.5" />
            {t("quotations.newQuote") || "New Quote"}
          </Button>
        </div>
      </div>

      {/* ─── Filters ─── */}
      <div className="flex gap-2 flex-wrap items-center mb-4">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t("quotations.searchPlaceholder") || "Search quotes..."}
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

        {/* Status filter */}
        <div className="flex items-center gap-2 flex-wrap">
          <Filter className="w-4 h-4 text-muted-foreground" />
          {QUOTE_STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={cn(
                "text-xs px-2.5 py-1 rounded-full border transition-colors",
                statusFilter === s
                  ? "bg-copper-500/20 border-copper-500/40 text-copper-400"
                  : "border-border/40 text-muted-foreground hover:border-border hover:text-foreground"
              )}
            >
              {s === "all"
                ? t("common.all") || "All"
                : STATUS_LABELS[s] || s}
            </button>
          ))}
        </div>
      </div>

      {/* ─── KPI Cards ─── */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
        <Card className="bg-copper-500/5 border-copper-500/20">
          <CardContent className="p-4">
            <p className="text-xs text-copper-400">{t("quotations.total") || "Total"}</p>
            <p className="text-xl font-bold">{totalCount}</p>
          </CardContent>
        </Card>
        <Card className="bg-gray-500/5 border-gray-500/20">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">{STATUS_LABELS.draft}</p>
            <p className="text-xl font-bold">
              {quotations.filter((q) => q.status === "draft").length}
            </p>
          </CardContent>
        </Card>
        <Card className="bg-blue-500/5 border-blue-500/20">
          <CardContent className="p-4">
            <p className="text-xs text-blue-400">{STATUS_LABELS.sent}</p>
            <p className="text-xl font-bold">
              {quotations.filter((q) => q.status === "sent").length}
            </p>
          </CardContent>
        </Card>
        <Card className="bg-emerald-500/5 border-emerald-500/20">
          <CardContent className="p-4">
            <p className="text-xs text-emerald-400">{STATUS_LABELS.accepted}</p>
            <p className="text-xl font-bold">
              {quotations.filter((q) => q.status === "accepted").length}
            </p>
          </CardContent>
        </Card>
        <Card className="bg-rose-500/5 border-rose-500/20">
          <CardContent className="p-4">
            <p className="text-xs text-rose-400">{STATUS_LABELS.rejected}</p>
            <p className="text-xl font-bold">
              {quotations.filter((q) => q.status === "rejected").length}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ─── Content ─── */}
      {quotations.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="p-12 text-center">
            <FileText className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-muted-foreground text-sm font-medium">
              {t("quotations.noQuotations") || "No quotations found"}
            </p>
            <p className="text-muted-foreground/60 text-xs mt-1">
              {t("quotations.noQuotationsDesc") ||
                "Create a new quote to get started"}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {quotations.map((q) => {
            const statusStyle = STATUS_STYLES[q.status] || STATUS_STYLES.draft;
            const isValid =
              q.valid_until &&
              new Date(q.valid_until) >= new Date();
            const isExpiringSoon =
              q.valid_until &&
              new Date(q.valid_until) <=
                new Date(Date.now() + 7 * 86400000) &&
              new Date(q.valid_until) >= new Date();

            return (
              <Card
                key={q.id}
                className="bg-card border-border hover:border-border/60 transition-colors cursor-pointer"
                onClick={() =>
                  (window.location.href = `/quotations/${q.id}`)
                }
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <div className="space-y-1 flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <FileText className="w-4 h-4 text-copper-400 shrink-0" />
                        <span className="font-medium text-foreground font-mono">
                          {q.quote_no || "—"}
                        </span>
                        <Badge
                          className={cn(
                            "text-[10px] px-1.5 py-0.5 font-medium border",
                            statusStyle.color,
                            statusStyle.bg,
                            statusStyle.border
                          )}
                        >
                          {STATUS_LABELS[q.status] || q.status}
                        </Badge>
                        {q.version && q.version > 1 && (
                          <span className="text-[10px] text-muted-foreground">
                            v{q.version}
                          </span>
                        )}
                        {!isValid && q.valid_until && (
                          <Badge
                            variant="outline"
                            className="text-[10px] text-rose-400 border-rose-500/30"
                          >
                            Expired
                          </Badge>
                        )}
                        {isExpiringSoon && isValid && (
                          <Badge
                            variant="outline"
                            className="text-[10px] text-amber-400 border-amber-500/30"
                          >
                            <Clock className="w-3 h-3 mr-1" />
                            Expiring soon
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm text-foreground">
                        {getCustomerName(q)}
                      </p>
                      <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
                        <span className="flex items-center gap-1">
                          <DollarSign className="w-3 h-3" />
                          {fmtAED(q.total_amount)}
                        </span>
                        <span className="flex items-center gap-1">
                          <Calendar className="w-3 h-3" />
                          {t("quotations.validUntil") || "Valid until"}:{" "}
                          {fmtDate(q.valid_until)}
                        </span>
                        <span className="flex items-center gap-1">
                          <Calendar className="w-3 h-3" />
                          {t("quotations.created") || "Created"}:{" "}
                          {fmtDate(q.created_at)}
                        </span>
                        {q.sent_at && (
                          <span className="flex items-center gap-1 text-blue-400">
                            <Clock className="w-3 h-3" />
                            Sent: {fmtDate(q.sent_at)}
                          </span>
                        )}
                      </div>
                      {q.notes && (
                        <p className="text-xs text-muted-foreground truncate mt-1">
                          {q.notes}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0 ml-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 w-8 p-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          window.location.href = `/quotations/${q.id}`;
                        }}
                      >
                        <Eye className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* ─── Pagination ─── */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4 px-1">
          <span className="text-xs text-muted-foreground">
            {t("common.page") || "Page"} {page} / {totalPages} ({totalCount}{" "}
            {t("quotations.total") || "total"})
          </span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="h-8 text-xs"
            >
              <ChevronLeft className="w-3.5 h-3.5 mr-1" />
              {t("common.prev") || "Prev"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="h-8 text-xs"
            >
              {t("common.next") || "Next"}
              <ChevronRight className="w-3.5 h-3.5 ml-1" />
            </Button>
          </div>
        </div>
      )}

      <Toaster position="top-center" richColors />
    </div>
  );
}
