"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { createClient } from "@/lib/supabase";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { ErrorState } from "@/components/ui/error-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn, fmtDubai } from "@/lib/utils";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import {
  Search, X, Plus, FileText, Calendar, DollarSign,
  Hash, User, Clock, RefreshCw, Eye, Download, MoreHorizontal,
  Trash2,
} from "lucide-react";
import QuoteCalculator from "./quote-calculator";
import QuoteWizard from "./quote-wizard";
import QuoteDetailDialog from "./quote-detail-dialog";
import { fmtAED } from "@/shared/utils/format";

/* ─── Types ─── */
interface Lead {
  id: string;
  customer_name: string | null;
  phone: string | null;
}

interface Quotation {
  id: string;
  lead_id: string | null;
  customer_id: string | null;
  created_by: string | null;
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
  devices_json: any;
  notes: string | null;
  internal_notes: string | null;
  created_at: string;
  updated_at: string;
  leads: { customer_name: string | null; phone: string | null } | null;
}

/* ─── Status config ─── */
const STATUS_STYLES: Record<string, { color: string; bg: string; border: string }> = {
  draft: { color: "text-muted-foreground", bg: "bg-gray-500/10", border: "border-gray-500/20" },
  sent: { color: "text-blue-400", bg: "bg-blue-500/10", border: "border-blue-500/20" },
  accepted: { color: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/20" },
  rejected: { color: "text-rose-400", bg: "bg-rose-500/10", border: "border-rose-500/20" },
  expired: { color: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/20" },
};
const STATUS_LABEL_KEYS: Record<string, string> = {
  draft: "quotes.draft",
  sent: "quotes.sent",
  accepted: "quotes.accepted",
  rejected: "quotes.rejected",
  expired: "quotes.expired",
};
const QUOTE_STATUSES = ["draft", "sent", "accepted", "rejected", "expired"];

/* ─── Helpers ─── */
function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  return fmtDubai(d, { locale: "en-US", month: "short", day: "numeric", year: "numeric" });
}

function isPlaceholder(v: string | null | undefined): boolean {
  if (!v) return true;
  const lower = v.toLowerCase().trim();
  return lower === "unknown" || lower === "n/a" || lower === "" || lower === "-";
}

function daysUntil(d: string | null | undefined): number | null {
  if (!d) return null;
  try {
    const target = new Date(d);
    const now = new Date();
    return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  } catch { return null; }
}

/* ─── Props ─── */
interface QuotesClientProps {
  initialData: Quotation[];
  fetchError?: string | null;
  userRole?: string;
}

/* ════════════════════════════════════════ */
export default function QuotesClient({ initialData, fetchError, userRole }: QuotesClientProps) {
  const supabase = createClient();
  const { t, lang } = useLanguage();

  /* ─── State ─── */
  const [quotations, setQuotations] = useState<Quotation[]>(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(fetchError ? (fetchError.includes(".") ? t(fetchError) : fetchError) : null);

  // Filters
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  // Detail dialog
  const [detailQuote, setDetailQuote] = useState<Quotation | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState({
    leadId: "",
    subtotal: 0,
    discountRate: 0,
    taxRate: 0,
    currency: "AED",
    validUntil: "",
    paymentTerms: "",
    deliveryTerms: "",
    notes: "",
  });

  // Calculator dialog
  const [calculatorOpen, setCalculatorOpen] = useState(false);
  // Wizard dialog
  const [wizardOpen, setWizardOpen] = useState(false);

  // Row download loading
  const [downloadLoading, setDownloadLoading] = useState<string | null>(null);

  // Current user ID for creator delete
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [deletingQuoteId, setDeletingQuoteId] = useState<string | null>(null);

  // Auth — role is detected by layout; passed via props or context.
  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) setCurrentUserId(user.id);
    });
  }, [supabase]);

  /* ─── Fetch data ─── */
  const fetchQuotes = useCallback(async () => {
    setLoading(true);
    setError(null);
    let q = supabase
      .from("quotations")
      .select("*, leads(customer_name, phone)")
      .order("created_at", { ascending: false })
      .limit(500);
    const { data, error: err } = await q;
    if (err) {
      console.error("Failed to fetch quotes:", err);
      setError(t("common.loadFailedRetry"));
      setLoading(false);
      return;
    }
    if (data) setQuotations(data as Quotation[]);
    setLoading(false);
  }, [supabase]);

  const fetchLeads = useCallback(async () => {
    const { data } = await supabase
      .from("leads")
      .select("id, customer_name, phone")
      .order("customer_name", { ascending: true });
    if (data) setLeads(data as Lead[]);
  }, [supabase]);

  /* ─── Filters ─── */
  const filtered = useMemo(() => {
    let result = [...quotations];
    if (statusFilter !== "all") result = result.filter((q) => q.status === statusFilter);
    if (dateFrom) result = result.filter((q) => q.created_at && q.created_at >= dateFrom);
    if (dateTo) result = result.filter((q) => q.created_at && q.created_at <= dateTo + "T23:59:59");
    if (search.trim()) {
      const s = search.toLowerCase().trim();
      result = result.filter((q) => {
        const name = q.leads?.customer_name || "";
        const no = q.quote_no || "";
        return name.toLowerCase().includes(s) || no.toLowerCase().includes(s);
      });
    }
    return result;
  }, [quotations, search, statusFilter, dateFrom, dateTo]);

  const totalValue = useMemo(
    () => filtered.reduce((sum, q) => sum + (q.total_amount || 0), 0),
    [filtered]
  );

  /* ─── Create quote ─── */
  const handleCreateQuote = async () => {
    if (!createForm.leadId) return;
    setCreating(true);
    try {
      const subtotal = createForm.subtotal || 0;
      const discountRate = createForm.discountRate || 0;
      const discountAmount = subtotal * (discountRate / 100);
      const taxRate = createForm.taxRate || 0;
      const taxableBase = subtotal - discountAmount;
      const taxAmount = taxableBase * (taxRate / 100);
      const totalAmount = taxableBase + taxAmount;

      const { data: { user } } = await supabase.auth.getUser();

      const { data: quote, error: err } = await supabase.from("quotations").insert({
        lead_id: createForm.leadId,
        quote_no: "ALLOCATED_BY_DATABASE",
        version: 1,
        subtotal, discount_rate: discountRate, discount_amount: discountAmount,
        tax_rate: taxRate, tax_amount: taxAmount,
        total_amount: totalAmount,
        currency: createForm.currency,
        valid_until: createForm.validUntil || undefined,
        payment_terms: createForm.paymentTerms || null,
        delivery_terms: createForm.deliveryTerms || null,
        notes: createForm.notes || null,
        status: "draft",
        created_by: user?.id || undefined,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).select("id, quote_no").single();
      if (err || !quote?.quote_no) { console.error("Create quote error:", err); toast.error(t("quotes.createFailed")); return; }
      // Notify about new quotation
      void import("@/lib/notify")
        .then(({ notify }) => notify({ type: "quote_created", quote_id: quote.id, lead_id: createForm.leadId, quote_no: quote.quote_no }))
        .catch((notifyError) => console.error("quote_notification_failed", notifyError));
      setCreateOpen(false);
      resetCreateForm();
      fetchQuotes();
    } finally { setCreating(false); }
  };

  const resetCreateForm = () => {
    setCreateForm({
      leadId: "", subtotal: 0, discountRate: 0, taxRate: 0,
      currency: "AED", validUntil: "", paymentTerms: "", deliveryTerms: "", notes: "",
    });
  };

  /* ─── Status update ─── */
  const handleStatusChange = async (id: string, newStatus: string) => {
    const { error: err } = await supabase
      .from("quotations")
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (!err) {
      // Cascade to lead: if quote accepted, advance lead stage to quotation_submitted
      if (newStatus === "accepted") {
        const { data: quote } = await supabase.from("quotations").select("lead_id, quote_no").eq("id", id).single();
        if (quote?.lead_id) {
          const { data: { user } } = await supabase.auth.getUser();
          await supabase.from("lead_milestones").insert({
            lead_id: quote.lead_id,
            milestone_key: "quotation",
            completed_by: user?.id || null,
            notes: `${lang === "zh" ? "报价已生成" : "Quote generated"} #${quote.quote_no || ""}`,
          });
        }
      }
      fetchQuotes();
    }
  };

  /* ─── Open create dialog ─── */
  const openCreateDialog = () => {
    fetchLeads();
    resetCreateForm();
    setCreateOpen(true);
  };

  /* ─── Get customer name ─── */
  const getCustomerName = (q: Quotation): string => {
    const name = q.leads?.customer_name;
    if (name && !isPlaceholder(name)) return name;
    return t("common.unnamed");
  };

  /* ─── Open detail ─── */
  const openDetail = (quote: Quotation) => {
    setDetailQuote(quote);
    setDetailOpen(true);
  };

  /* ─── Row Download handler ─── */
  const handleRowDownload = async (e: React.MouseEvent, quote: Quotation, type: "pdf" | "ppt") => {
    e.stopPropagation();
    const url = type === "pdf" ? quote.pdf_url : quote.ppt_url;
    if (!url) return;
    const key = `${quote.id}-${type}`;
    setDownloadLoading(key);
    try {
      const res = await fetch("/api/cos/download-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: url, expires: 3600 }),
      });
      const data = await res.json();
      window.open(data.url || url, "_blank");
    } catch {
      window.open(url, "_blank");
    } finally {
      setDownloadLoading(null);
    }
  };

  /* ─── Delete quote (creator only) ─── */
  const handleDeleteQuote = async (e: React.MouseEvent, quote: Quotation) => {
    e.stopPropagation();
    if (deletingQuoteId) return; // prevent double-click
    if (!confirm(t("quotes.confirmDelete"))) return;
    setDeletingQuoteId(quote.id);
    try {
      const { error: err } = await supabase.from("quotations").delete().eq("id", quote.id);
      if (err) throw err;
      setQuotations(prev => prev.filter(q => q.id !== quote.id));
      toast.success(t("quotes.deletedSuccess"));
    } catch (err) {
      console.error("Failed to delete quote:", err);
      toast.error(t("quotes.deleteFailed"));
    } finally {
      setDeletingQuoteId(null);
    }
  };

  /* ─── Render ─── */
  return (
    <div className="space-y-4">
      {/* ─── Header ─── */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight">
            {t("quotes.title")}
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {filtered.length} {t("quotes.title").toLowerCase()} · {fmtAED(totalValue)} {t("quotes.total").toLowerCase()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={fetchQuotes}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-border/50 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            title={t("quotes.refresh")}>
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => setCalculatorOpen(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-copper-500 text-foreground rounded-lg hover:bg-copper-600 transition-colors">
            <Plus className="w-3.5 h-3.5" />
            {t("quotes.createQuote")}
          </button>
        </div>
      </div>

      {/* ─── Filters ─── */}
      <div className="flex gap-2 flex-wrap items-center">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t("quotes.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9 text-sm"
          />
          {search && (
            <button onClick={() => setSearch("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-9 px-2 text-xs rounded-lg border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-copper-500 max-w-[130px]"
        >
          <option value="all">{t("quotes.allStatuses")}</option>
          {QUOTE_STATUSES.map((s) => (
            <option key={s} value={s}>{t(`quotes.${s}`)}</option>
          ))}
        </select>
        <div className="flex items-center gap-1">
          <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
            className="h-9 text-xs w-[140px]" />
          <span className="text-xs text-muted-foreground">—</span>
          <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
            className="h-9 text-xs w-[140px]" />
          {(dateFrom || dateTo) && (
            <button onClick={() => { setDateFrom(""); setDateTo(""); }}
              className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <span className="text-xs text-muted-foreground ml-auto">
          {filtered.length} {t("quotes.results")}
        </span>
      </div>

      {/* ─── Content ─── */}
      {error ? (
        <ErrorState message={error} onRetry={fetchQuotes} />
      ) : loading ? (
        <div className="text-center text-muted-foreground py-16 text-sm">{t("common.loading")}</div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <FileText className="w-12 h-12 text-muted-foreground/30 mb-3" />
          <p className="text-muted-foreground text-sm font-medium">{t("quotes.noQuotesFound")}</p>
          <p className="text-muted-foreground/60 text-xs mt-1">{t("quotes.noQuotesFoundDesc")}</p>
          <button onClick={openCreateDialog}
            className="mt-4 inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-copper-500 text-foreground rounded-lg hover:bg-copper-600 transition-colors">
            <Plus className="w-3.5 h-3.5" /> {t("quotes.createQuote")}
          </button>
        </div>
      ) : (
        /* ─── Rich Table ─── */
        <div className="rounded-xl border border-border/30 overflow-hidden">
          {/* Table Header */}
          <div className="grid grid-cols-12 gap-3 px-4 py-3 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/40 border-b border-border/30">
            <div className="col-span-2 flex items-center gap-1.5"><Hash className="w-3 h-3" />{t("quotes.quoteNoShort")}</div>
            <div className="col-span-2 flex items-center gap-1.5"><User className="w-3 h-3" />{t("quotes.customer")}</div>
            <div className="col-span-1.5 flex items-center gap-1.5"><Clock className="w-3 h-3" />{t("quotes.status")}</div>
            <div className="col-span-2 text-right flex items-center gap-1.5 justify-end"><DollarSign className="w-3 h-3" />{t("quotes.totalAmount")}</div>
            <div className="col-span-2 flex items-center gap-1.5"><Calendar className="w-3 h-3" />{t("quotes.validUntil")}</div>
            <div className="col-span-1.5 flex items-center gap-1.5"><Calendar className="w-3 h-3" />{t("quotes.createdDate")}</div>
            <div className="col-span-1 flex items-center justify-end"> </div>
          </div>

          {/* Table Body */}
          {filtered.map((quote) => {
            const statusStyle = STATUS_STYLES[quote.status] || STATUS_STYLES.draft;
            const remaining = daysUntil(quote.valid_until);
            const isExpiringSoon = remaining !== null && remaining <= 7 && remaining >= 0;
            const isExpired = remaining !== null && remaining < 0;

            return (
              <div
                key={quote.id}
                className="grid grid-cols-12 gap-3 px-4 py-3 items-center border-b border-border/20 hover:bg-muted/30 transition-colors cursor-pointer group"
                onClick={() => openDetail(quote)}
              >
                {/* Quote No */}
                <div className="col-span-2">
                  <span className="text-sm font-mono font-medium text-foreground">
                    {quote.quote_no || "—"}
                  </span>
                </div>

                {/* Customer */}
                <div className="col-span-2">
                  <span className="text-sm text-foreground truncate block">
                    {getCustomerName(quote)}
                  </span>
                </div>

                {/* Status */}
                <div className="col-span-1.5">
                  <Badge className={cn(
                    "text-[10px] px-1.5 py-0.5 font-medium border",
                    statusStyle.color, statusStyle.bg, statusStyle.border
                  )}>
                    {t(`quotes.${quote.status}`)}
                  </Badge>
                </div>

                {/* Total */}
                <div className="col-span-2 text-right">
                  <span className={cn(
                    "text-sm font-semibold",
                    quote.status === "accepted" ? "text-emerald-400" : "text-copper-400"
                  )}>
                    {fmtAED(quote.total_amount)}
                  </span>
                </div>

                {/* Valid Until */}
                <div className="col-span-2">
                  {quote.valid_until ? (
                    <div className="flex items-center gap-1.5">
                      <span className={cn(
                        "text-xs",
                        isExpired ? "text-rose-400" : isExpiringSoon ? "text-amber-400" : "text-muted-foreground"
                      )}>
                        {fmtDate(quote.valid_until)}
                      </span>
                      {isExpired && (
                        <Badge className="text-[9px] bg-rose-500/10 text-rose-400 border-rose-500/20">{t("quotes.expired")}</Badge>
                      )}
                      {isExpiringSoon && (
                        <Badge className="text-[9px] bg-amber-500/10 text-amber-400 border-amber-500/20">{remaining}d</Badge>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </div>

                {/* Created */}
                <div className="col-span-1.5">
                  <span className="text-xs text-muted-foreground">
                    {fmtDate(quote.created_at)}
                  </span>
                </div>

                {/* Actions */}
                <div className="col-span-1 flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {quote.pdf_url && (
                    <button
                      onClick={(e) => handleRowDownload(e, quote, "pdf")}
                      className={`p-1.5 rounded-lg hover:bg-muted transition-colors ${
                        downloadLoading === `${quote.id}-pdf`
                          ? "text-copper-400"
                          : "text-muted-foreground hover:text-copper-400"
                      }`}
                      title={t("quotes.quoteXls")}
                    >
                      <Download className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {quote.ppt_url && (
                    <button
                      onClick={(e) => handleRowDownload(e, quote, "ppt")}
                      className={`p-1.5 rounded-lg hover:bg-muted transition-colors ${
                        downloadLoading === `${quote.id}-ppt`
                          ? "text-copper-400"
                          : "text-muted-foreground hover:text-copper-400"
                      }`}
                      title={t("quotes.designPpt")}
                    >
                      <Download className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); openDetail(quote); }}
                    className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-copper-400 transition-colors"
                    title={t("quotes.viewDetails")}
                  >
                    <Eye className="w-4 h-4" />
                  </button>
                  {(currentUserId && quote.created_by === currentUserId) ||
                   userRole === "admin" || userRole === "boss" || userRole === "operator" ? (
                    <button
                      onClick={(e) => handleDeleteQuote(e, quote)}
                      disabled={deletingQuoteId === quote.id}
                      className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-rose-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      title={t("quotes.deleteQuote")}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ─── Create Quote Dialog ─── */}
      <Dialog open={createOpen} onOpenChange={(open) => { setCreateOpen(open); if (!open) resetCreateForm(); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("quotes.createQuote")}</DialogTitle>
            <DialogDescription>{t("quotes.selectLeadAndAmounts")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-xs font-medium text-foreground mb-1.5 block">{t("quotes.lead")} *</label>
              <select
                value={createForm.leadId}
                onChange={(e) => setCreateForm({ ...createForm, leadId: e.target.value })}
                className="w-full h-9 px-2.5 text-sm rounded-lg border border-input bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-copper-500"
              >
                <option value="">{t("quotes.selectLeadPlaceholder")}</option>
                {leads.map((lead) => (
                  <option key={lead.id} value={lead.id}>
                    {!isPlaceholder(lead.customer_name) ? lead.customer_name : (lead.phone || "—")}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-foreground mb-1.5 block">{t("quotes.subtotal")} (AED)</label>
                <Input type="number" min="0" step="0.01"
                  value={createForm.subtotal || ""}
                  onChange={(e) => setCreateForm({ ...createForm, subtotal: parseFloat(e.target.value) || 0 })}
                  className="h-9" />
              </div>
              <div>
                <label className="text-xs font-medium text-foreground mb-1.5 block">{t("quotes.discount")} (%)</label>
                <Input type="number" min="0" max="100" step="0.1"
                  value={createForm.discountRate || ""}
                  onChange={(e) => setCreateForm({ ...createForm, discountRate: parseFloat(e.target.value) || 0 })}
                  className="h-9" />
              </div>
              <div>
                <label className="text-xs font-medium text-foreground mb-1.5 block">{t("quotes.tax")} (%)</label>
                <Input type="number" min="0" max="100" step="0.1"
                  value={createForm.taxRate || ""}
                  onChange={(e) => setCreateForm({ ...createForm, taxRate: parseFloat(e.target.value) || 0 })}
                  className="h-9" />
              </div>
              <div>
                <label className="text-xs font-medium text-foreground mb-1.5 block">{t("quotes.currency")}</label>
                <select value={createForm.currency}
                  onChange={(e) => setCreateForm({ ...createForm, currency: e.target.value })}
                  className="w-full h-9 px-2.5 text-sm rounded-lg border border-input bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-copper-500">
                  <option value="AED">AED</option>
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-foreground mb-1.5 block">{t("quotes.validUntil")}</label>
              <Input type="date" value={createForm.validUntil}
                onChange={(e) => setCreateForm({ ...createForm, validUntil: e.target.value })}
                className="h-9" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-foreground mb-1.5 block">{t("quotes.paymentTerms")}</label>
                <Input value={createForm.paymentTerms}
                  onChange={(e) => setCreateForm({ ...createForm, paymentTerms: e.target.value })}
                  className="h-9" placeholder="e.g., 50% deposit" />
              </div>
              <div>
                <label className="text-xs font-medium text-foreground mb-1.5 block">{t("quotes.deliveryTerms")}</label>
                <Input value={createForm.deliveryTerms}
                  onChange={(e) => setCreateForm({ ...createForm, deliveryTerms: e.target.value })}
                  className="h-9" placeholder="e.g., 4-6 weeks" />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-foreground mb-1.5 block">{t("quotes.notes")}</label>
              <textarea value={createForm.notes}
                onChange={(e) => setCreateForm({ ...createForm, notes: e.target.value })}
                className="w-full min-h-[60px] rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 placeholder:text-muted-foreground resize-none"
                rows={2} />
            </div>
            {createForm.subtotal > 0 && (
              <div className="p-3 rounded-lg bg-muted/30 border border-border/30">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{t("quotes.subtotal")}</span><span>{fmtAED(createForm.subtotal)}</span>
                </div>
                {createForm.discountRate > 0 && (
                  <div className="flex items-center justify-between text-xs text-muted-foreground mt-1">
                    <span>{t("quotes.discount")} ({createForm.discountRate}%)</span>
                    <span className="text-rose-400">- {fmtAED(createForm.subtotal * createForm.discountRate / 100)}</span>
                  </div>
                )}
                <div className="flex items-center justify-between text-sm font-semibold text-copper-400 mt-2 pt-2 border-t border-border/30">
                  <span>{t("quotes.total")}</span>
                  <span>{fmtAED(
                    (createForm.subtotal - createForm.subtotal * createForm.discountRate / 100) *
                    (1 + createForm.taxRate / 100)
                  )}</span>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>{t("common.cancel")}</DialogClose>
            <Button onClick={handleCreateQuote} disabled={!createForm.leadId || creating}>
              {creating ? t("common.creating") : t("quotes.createQuote")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Quote Detail Dialog (L2) ─── */}
      <QuoteDetailDialog
        open={detailOpen}
        onOpenChange={(open) => { setDetailOpen(open); if (!open) fetchQuotes(); }}
        quote={detailQuote}
        onStatusChange={handleStatusChange}
      />

      {/* ─── Quote Calculator ─── */}
      <QuoteCalculator
        open={calculatorOpen}
        onOpenChange={setCalculatorOpen}
        onSaved={fetchQuotes}
      />

      {/* ─── Quote Wizard ─── */}
      <QuoteWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        onSaved={fetchQuotes}
      />
    </div>
  );
}
