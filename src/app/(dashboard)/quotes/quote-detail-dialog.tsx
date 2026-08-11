"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn, fmtDubai } from "@/lib/utils";
import {
  ChevronDown, ChevronUp, Download, FileSpreadsheet,
  FileText, Send, CheckCircle, XCircle, Calendar,
  DollarSign, Hash, Clock, ExternalLink,
} from "lucide-react";
import { DEVICE_CATALOG } from "@/lib/device-catalog";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { toast } from "sonner";
import { fmtAED } from "@/shared/utils/format";

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
  devices_json: Record<string, { name: string; qty: number; unit_price: number; line_total: number; unit?: string }> | null;
  notes: string | null;
  contract_id?: string | null;
  contract_no?: string | null;
  created_at: string;
  leads: { customer_name: string | null; phone: string | null } | null;
}

/**
 * One row of the payment schedule the conversion requires.
 *
 * Round-3 P1-5: this dialog used to POST /convert with no body at all, the route
 * turned that into `installments: []`, and convert_quotation_to_contract() created
 * a contract with an approval row and no schedule that nothing could repair. The
 * schedule is now part of the request, the amounts must add up to the quotation
 * total before the button enables, and the routine re-checks the same invariant
 * inside the conversion's transaction against the authoritative total.
 */
interface Installment {
  seq: number;
  amount: number;
  due_date: string;
  description: string;
}

/** The default split: 50% on signing, 30% at delivery, 20% on completion. */
const DEFAULT_SPLIT = [
  { fraction: 0.5, description: "On signing", offsetDays: 0 },
  { fraction: 0.3, description: "On delivery", offsetDays: 30 },
  { fraction: 0.2, description: "On completion", offsetDays: 60 },
];

/** Cents, so a percentage split of an odd total still sums to the total exactly. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function defaultSchedule(total: number): Installment[] {
  const today = new Date();
  const rows = DEFAULT_SPLIT.map((part, index) => {
    const due = new Date(today);
    due.setDate(due.getDate() + part.offsetDays);
    return {
      seq: index + 1,
      amount: round2(total * part.fraction),
      due_date: due.toISOString().slice(0, 10),
      description: part.description,
    };
  });
  // The rounding remainder goes on the last row, so the sum is the total.
  const drift = round2(total - rows.reduce((sum, row) => sum + row.amount, 0));
  if (drift !== 0 && rows.length > 0) {
    rows[rows.length - 1].amount = round2(rows[rows.length - 1].amount + drift);
  }
  return rows;
}

interface QuoteDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quote: Quotation | null;
  onStatusChange: (id: string, newStatus: string) => void;
}

/* ─── Status config ─── */
const STATUS_STYLES: Record<string, { color: string; bg: string; border: string }> = {
  draft: { color: "text-muted-foreground", bg: "bg-gray-500/10", border: "border-gray-500/20" },
  sent: { color: "text-blue-400", bg: "bg-blue-500/10", border: "border-blue-500/20" },
  accepted: { color: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/20" },
  rejected: { color: "text-rose-400", bg: "bg-rose-500/10", border: "border-rose-500/20" },
  expired: { color: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/20" },
  contract_created: { color: "text-purple-400", bg: "bg-purple-500/10", border: "border-purple-500/20" },
  won: { color: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/20" },
};
const QUOTE_STATUSES = ["draft", "sent", "accepted", "rejected", "expired", "contract_created", "won"];

/* ─── Helpers ─── */
function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  return fmtDubai(d, { locale: "en-US", month: "short", day: "numeric", year: "numeric" });
}

function getCategoryIcon(key: string): string {
  const cat = DEVICE_CATALOG.find((c) => c.key === key);
  return cat?.icon ?? "📦";
}
function getCategoryLabel(key: string): string {
  const cat = DEVICE_CATALOG.find((c) => c.key === key);
  return cat?.label ?? key;
}

/* ─── Component ─── */
export default function QuoteDetailDialog({ open, onOpenChange, quote, onStatusChange }: QuoteDetailDialogProps) {
  const { t } = useLanguage();
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [loadingDownload, setLoadingDownload] = useState<string | null>(null);
  const [loadingConvert, setLoadingConvert] = useState(false);
  const [activeStatus, setActiveStatus] = useState("");
  const [schedule, setSchedule] = useState<Installment[] | null>(null);

  useEffect(() => {
    if (quote) {
      setActiveStatus(quote.status);
      // Auto-expand all categories
      const cats = new Set<string>();
      if (quote.devices_json) {
        Object.keys(quote.devices_json).forEach((deviceId) => {
          for (const cat of DEVICE_CATALOG) {
            if (cat.devices.some((d) => d.id === deviceId)) {
              cats.add(cat.key);
            }
          }
        });
      }
      setExpandedCategories(cats);
    }
  }, [quote]);

  if (!quote) return null;

  const statusStyle = STATUS_STYLES[quote.status] || STATUS_STYLES.draft;
  const customerName = quote.leads?.customer_name || t("contracts.unnamed");

  // Group line items by category
  const categoryGroups: Record<string, { label: string; icon: string; items: any[]; subtotal: number }> = {};
  if (quote.devices_json) {
    for (const [deviceId, info] of Object.entries(quote.devices_json)) {
      let catKey = "other";
      for (const cat of DEVICE_CATALOG) {
        if (cat.devices.some((d) => d.id === deviceId)) {
          catKey = cat.key;
          break;
        }
      }
      if (!categoryGroups[catKey]) {
        categoryGroups[catKey] = {
          label: getCategoryLabel(catKey),
          icon: getCategoryIcon(catKey),
          items: [],
          subtotal: 0,
        };
      }
      categoryGroups[catKey].items.push({ id: deviceId, ...info });
      categoryGroups[catKey].subtotal += info.line_total;
    }
  }

  const toggleCategory = (key: string) => {
    const next = new Set(expandedCategories);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setExpandedCategories(next);
  };

  const handleDownload = async (type: "pdf" | "ppt") => {
    const url = type === "pdf" ? quote.pdf_url : quote.ppt_url;
    if (!url) return;

    setLoadingDownload(type);
    try {
      const res = await fetch("/api/cos/download-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: url, expires: 3600 }),
      });
      const data = await res.json();
      if (data.url) {
        window.open(data.url, "_blank");
      } else {
        // Fallback: try direct URL
        window.open(url, "_blank");
      }
    } catch {
      window.open(url, "_blank");
    } finally {
      setLoadingDownload(null);
    }
  };

  const handleStatusChange = (newStatus: string) => {
    setActiveStatus(newStatus);
    onStatusChange(quote.id, newStatus);
    toast.success(`${t("quotes.statusChangedTo")} ${t("quotes." + newStatus)}`);
  };

  const quoteTotal = round2(quote.total_amount || 0);
  const scheduleTotal = round2((schedule ?? []).reduce((sum, row) => sum + (row.amount || 0), 0));
  const scheduleRemainder = round2(quoteTotal - scheduleTotal);
  const scheduleIsValid =
    schedule !== null &&
    schedule.length > 0 &&
    schedule.every((row) => Number.isFinite(row.amount) && row.amount > 0) &&
    Math.abs(scheduleRemainder) <= 0.01;

  const updateInstallment = (index: number, patch: Partial<Installment>) => {
    setSchedule((rows) =>
      (rows ?? []).map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  };

  const addInstallment = () => {
    setSchedule((rows) => {
      const current = rows ?? [];
      return [
        ...current,
        {
          seq: current.length + 1,
          amount: Math.max(round2(scheduleRemainder), 0),
          due_date: new Date().toISOString().slice(0, 10),
          description: "",
        },
      ];
    });
  };

  const removeInstallment = (index: number) => {
    setSchedule((rows) =>
      (rows ?? [])
        .filter((_, i) => i !== index)
        .map((row, i) => ({ ...row, seq: i + 1 })),
    );
  };

  const handleConvert = async () => {
    // The schedule is the request. Without it the routine answers 22023 and
    // writes nothing, so the button must not be reachable in that state.
    if (!schedule || !scheduleIsValid) return;
    setLoadingConvert(true);
    try {
      const res = await fetch(`/api/quotations/${quote.id}/convert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          installments: schedule.map((row, index) => ({
            seq: index + 1,
            amount: row.amount,
            due_date: row.due_date || null,
            description: row.description,
          })),
          first_payment_due_date: schedule[0]?.due_date || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Conversion failed");
      toast.success(
        data.already_converted
          ? `Contract ${data.contract_no} already existed; missing records were repaired`
          : `Contract ${data.contract_no} created successfully`,
      );
      setSchedule(null);
      onStatusChange(quote.id, "contract_created");
      setActiveStatus("contract_created");
    } catch (err: any) {
      toast.error(err.message || "Failed to convert to contract");
    } finally {
      setLoadingConvert(false);
    }
  };

  // Calculate service amounts (approximate from engine defaults)
  const devicesTotal = quote.subtotal || 0;
  const discountAmt = quote.discount_amount || 0;
  const taxAmt = quote.tax_amount || 0;
  // Estimate services from total - devices + discount - tax
  const estimatedServices = (quote.total_amount || 0) - devicesTotal + discountAmt - taxAmt;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="text-lg flex items-center gap-2">
                <Hash className="w-4 h-4 text-copper-400" />
                {quote.quote_no || "—"}
              </DialogTitle>
              <p className="text-sm text-muted-foreground mt-0.5">
                {customerName} · v{quote.version || 1} · {fmtDate(quote.created_at)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={activeStatus}
                onChange={(e) => handleStatusChange(e.target.value)}
                className="h-8 px-2 text-xs rounded-lg border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-copper-500"
              >
                {QUOTE_STATUSES.map((s) => (
                  <option key={s} value={s}>{t("quotes." + s)}</option>
                ))}
              </select>
              <Badge className={cn("text-xs", statusStyle.color, statusStyle.bg, statusStyle.border)}>
                {t("quotes." + quote.status)}
              </Badge>
            </div>
          </div>
        </DialogHeader>

        {/* ═══════════ Summary Bar ═══════════ */}
        <div className="grid grid-cols-5 gap-3 p-4 rounded-xl bg-muted/60 border border-border/30">
          <div className="text-center">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">{t("quotes.devices")}</p>
            <p className="text-sm font-medium text-foreground">{fmtAED(devicesTotal)}</p>
          </div>
          <div className="text-center">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">{t("quotes.discount")}</p>
            <p className="text-sm font-medium text-rose-400">−{fmtAED(discountAmt)}</p>
          </div>
          <div className="text-center">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">{t("quotes.servicesTax")}</p>
            <p className="text-sm font-medium text-foreground">{fmtAED(estimatedServices)}</p>
          </div>
          <div className="text-center col-span-1">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">{t("quotes.tax")}</p>
            <p className="text-sm font-medium text-amber-400">{fmtAED(taxAmt)}</p>
          </div>
          <div className="text-center bg-copper-500/10 rounded-lg p-2 -m-1">
            <p className="text-[10px] text-copper-400 uppercase tracking-wider mb-0.5">{t("quotes.total")}</p>
            <p className="text-lg font-bold text-copper-400">
              {fmtAED(quote.total_amount)}
            </p>
          </div>
        </div>

        {/* ═══════════ Line Items (Collapsible by Category) ═══════════ */}
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <FileText className="w-4 h-4 text-muted-foreground" />
            {t("quotes.lineItems")}
          </h3>

          {Object.keys(categoryGroups).length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              {t("quotes.noLineItems")}
            </div>
          ) : (
            Object.entries(categoryGroups).map(([catKey, group]) => {
              const isExpanded = expandedCategories.has(catKey);
              return (
                <div key={catKey} className="rounded-lg border border-border/30 overflow-hidden">
                  {/* Category header */}
                  <button
                    onClick={() => toggleCategory(catKey)}
                    className="w-full flex items-center justify-between px-4 py-2.5 bg-muted/40 hover:bg-muted/60 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm">{group.icon}</span>
                      <span className="text-sm font-medium text-foreground">{group.label}</span>
                      <span className="text-xs text-muted-foreground">({group.items.length} items)</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium text-foreground">{fmtAED(group.subtotal)}</span>
                      {isExpanded ? (
                        <ChevronUp className="w-4 h-4 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="w-4 h-4 text-muted-foreground" />
                      )}
                    </div>
                  </button>

                  {/* Category detail rows */}
                  {isExpanded && (
                    <div className="border-t border-border/20">
                      {group.items.map((item) => (
                        <div
                          key={item.id}
                          className="flex items-center justify-between px-4 py-2 hover:bg-muted/30 transition-colors"
                        >
                          <div className="flex-1">
                            <p className="text-sm text-foreground">{item.name}</p>
                          </div>
                          <div className="flex items-center gap-4 text-xs text-muted-foreground">
                            <span>{fmtAED(item.unit_price)} × {item.qty}</span>
                            <span className="text-sm font-medium text-foreground w-20 text-right">
                              {fmtAED(item.line_total)}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* ═══════════ Info Grid ═══════════ */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">{t("quotes.validUntil")}</p>
            <p className="text-sm text-foreground flex items-center gap-1">
              <Calendar className="w-3 h-3 text-muted-foreground" />
              {fmtDate(quote.valid_until)}
            </p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">{t("quotes.payment")}</p>
            <p className="text-sm text-foreground">{quote.payment_terms || "—"}</p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">{t("quotes.delivery")}</p>
            <p className="text-sm text-foreground">{quote.delivery_terms || "—"}</p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">{t("quotes.discount")}</p>
            <p className="text-sm text-foreground">{quote.discount_rate || 0}%</p>
          </div>
        </div>

        {quote.notes && (
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">{t("quotes.notes")}</p>
            <p className="text-sm text-foreground bg-muted/30 rounded-lg p-3">{quote.notes}</p>
          </div>
        )}

        {/* ═══════════ Actions Row ═══════════ */}
        <div className="flex items-center gap-2 pt-2 border-t border-border/30">
          {/* Quick status actions */}
          <Button
            size="sm"
            variant="outline"
            className="text-xs gap-1.5"
            onClick={() => handleStatusChange("sent")}
            disabled={quote.status === "sent"}
          >
            <Send className="w-3 h-3" /> Send to Client
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-xs gap-1.5 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/10"
            onClick={() => handleStatusChange("accepted")}
            disabled={quote.status === "accepted"}
          >
            <CheckCircle className="w-3 h-3" /> Accept
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-xs gap-1.5 text-rose-400 border-rose-500/20 hover:bg-rose-500/10"
            onClick={() => handleStatusChange("rejected")}
            disabled={quote.status === "rejected"}
          >
            <XCircle className="w-3 h-3" /> Reject
          </Button>

          {/* Convert to Contract — opens the schedule step; the POST needs it */}
          {quote.status === "accepted" && !quote.contract_id && (
            <Button
              size="sm"
              variant="outline"
              className="text-xs gap-1.5 text-purple-400 border-purple-500/20 hover:bg-purple-500/10"
              onClick={() => setSchedule(schedule ? null : defaultSchedule(quoteTotal))}
              disabled={loadingConvert}
            >
              <FileText className="w-3 h-3" />
              {schedule ? "Cancel conversion" : "Convert to Contract"}
            </Button>
          )}

          {/* Contract link */}
          {quote.contract_id && (
            <a
              href="/contracts"
              className="inline-flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
            >
              <ExternalLink className="w-3 h-3" />
              {quote.contract_no || "View Contract"}
            </a>
          )}

          <div className="flex-1" />

          {/* Downloads */}
          {quote.pdf_url && (
            <Button
              size="sm"
              variant="secondary"
              className="text-xs gap-1.5"
              onClick={() => handleDownload("pdf")}
              disabled={loadingDownload === "pdf"}
            >
              <FileSpreadsheet className="w-3 h-3" />
              {loadingDownload === "pdf" ? "..." : t("quotes.quoteXls")}
            </Button>
          )}
          {quote.ppt_url && (
            <Button
              size="sm"
              variant="secondary"
              className="text-xs gap-1.5"
              onClick={() => handleDownload("ppt")}
              disabled={loadingDownload === "ppt"}
            >
              <Download className="w-3 h-3" />
              {loadingDownload === "ppt" ? "..." : t("quotes.designPpt")}
            </Button>
          )}
          {!quote.pdf_url && !quote.ppt_url && (
            <span className="text-xs text-muted-foreground">{t("quotes.noFilesAttached")}</span>
          )}
        </div>

        {/* ── Payment schedule step (required for a conversion) ───────────── */}
        {schedule && (
          <div className="mt-4 rounded-lg border border-purple-500/20 bg-purple-500/[0.04] p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-purple-300">Payment schedule</p>
              <p className="text-xs text-muted-foreground">
                Quotation total {fmtAED(quoteTotal)}
              </p>
            </div>

            {schedule.map((row, index) => (
              <div key={index} className="flex items-center gap-2">
                <span className="w-5 text-xs text-muted-foreground">#{index + 1}</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={Number.isFinite(row.amount) ? row.amount : ""}
                  onChange={(e) => updateInstallment(index, { amount: Number(e.target.value) })}
                  className="h-8 w-32 px-2 text-xs rounded-lg border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-copper-500"
                  aria-label={`Installment ${index + 1} amount`}
                />
                <input
                  type="date"
                  value={row.due_date}
                  onChange={(e) => updateInstallment(index, { due_date: e.target.value })}
                  className="h-8 px-2 text-xs rounded-lg border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-copper-500"
                  aria-label={`Installment ${index + 1} due date`}
                />
                <input
                  type="text"
                  value={row.description}
                  onChange={(e) => updateInstallment(index, { description: e.target.value })}
                  placeholder="Description"
                  className="h-8 flex-1 px-2 text-xs rounded-lg border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-copper-500"
                  aria-label={`Installment ${index + 1} description`}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-xs text-rose-400 hover:bg-rose-500/10"
                  onClick={() => removeInstallment(index)}
                  disabled={schedule.length <= 1}
                >
                  <XCircle className="w-3 h-3" />
                </Button>
              </div>
            ))}

            <div className="flex items-center gap-2 pt-1">
              <Button size="sm" variant="secondary" className="text-xs" onClick={addInstallment}>
                Add installment
              </Button>
              <span
                className={cn(
                  "text-xs",
                  Math.abs(scheduleRemainder) <= 0.01 ? "text-emerald-400" : "text-amber-400",
                )}
              >
                {Math.abs(scheduleRemainder) <= 0.01
                  ? `Scheduled ${fmtAED(scheduleTotal)} — matches the quotation total`
                  : `Scheduled ${fmtAED(scheduleTotal)} — ${fmtAED(Math.abs(scheduleRemainder))} ${
                      scheduleRemainder > 0 ? "unallocated" : "over the quotation total"
                    }`}
              </span>
              <div className="flex-1" />
              <Button
                size="sm"
                className="text-xs gap-1.5"
                onClick={handleConvert}
                disabled={loadingConvert || !scheduleIsValid}
              >
                <FileText className="w-3 h-3" />
                {loadingConvert ? "Converting..." : "Create contract"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
