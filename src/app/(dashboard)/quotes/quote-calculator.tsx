"use client";

import { useState, useMemo, useEffect } from "react";
import { createClient } from "@/lib/supabase";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter, DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Collapsible, CollapsibleTrigger, CollapsibleContent,
} from "@/components/ui/collapsible";
import {
  ChevronDown, ChevronUp, Plus, Minus, Search,
  Save, FileDown, Send, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { DEVICE_CATALOG, findDevice, type DeviceInfo, type CategoryInfo } from "@/lib/device-catalog";

interface Lead { id: string; customer_name: string | null; phone: string | null; }

function fmtCurrency(v: number): string {
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + "M";
  if (v >= 1_000) return (v / 1_000).toFixed(2) + "K";
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface QuoteCalculatorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
  initialLeadId?: string;
}

export default function QuoteCalculator({ open, onOpenChange, onSaved, initialLeadId }: QuoteCalculatorProps) {
  const supabase = createClient();
  const { t } = useLanguage();
  const isEmbedded = !!initialLeadId;
  const [leads, setLeads] = useState<Lead[]>([]);
  const [selectedLeadId, setSelectedLeadId] = useState(initialLeadId || "");
  const [customerName, setCustomerName] = useState("");
  const [propertyType, setPropertyType] = useState<"villa" | "apartment">("villa");
  const [area, setArea] = useState(0);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [discountRate, setDiscountRate] = useState(5);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [savedQuoteId, setSavedQuoteId] = useState<string | null>(null);
  const [deviceSearch, setDeviceSearch] = useState("");

  useEffect(() => {
    if (!open) return;
    if (isEmbedded) {
      // Embedded mode: fetch this single lead's details
      supabase.from("leads").select("id, customer_name, phone, property_type, property_size_sqm")
        .eq("id", initialLeadId).single()
        .then(({ data }) => {
          if (data) {
            setCustomerName(data.customer_name || data.phone || "");
            if (data.property_type === "villa" || data.property_type === "apartment") setPropertyType(data.property_type);
            if (data.property_size_sqm) setArea(data.property_size_sqm);
          }
        });
    } else {
      supabase.from("leads").select("id, customer_name, phone")
        .order("customer_name", { ascending: true })
        .then(({ data }) => { if (data) setLeads(data as Lead[]); });
    }
  }, [open, supabase, isEmbedded, initialLeadId]);

  const handleLeadChange = (leadId: string) => {
    setSelectedLeadId(leadId);
    const lead = leads.find((l) => l.id === leadId);
    setCustomerName(lead?.customer_name || lead?.phone || "");
  };

  const getQty = (id: string) => quantities[id] || 0;

  const setQty = (id: string, val: number) => {
    if (val <= 0) {
      const copy = { ...quantities };
      delete copy[id];
      setQuantities(copy);
    } else setQuantities((p) => ({ ...p, [id]: val }));
  };

  const incQty = (id: string) => setQty(id, getQty(id) + 1);
  const decQty = (id: string) => setQty(id, getQty(id) - 1);

  const toggleSection = (cat: string) =>
    setOpenSections((p) => ({ ...p, [cat]: !p[cat] }));

  const calc = useMemo(() => {
    const ds = Object.entries(quantities).reduce(
      (s, [id, q]) => s + (findDevice(id)?.price || 0) * q, 0
    );
    const da = ds * discountRate / 100;
    const ad = ds - da;
    const il = ad * 0.30, co = ad * 0.12, pm = ad * 0.08;
    const ss = il + co + pm;
    const tb = ad + ss;
    const vt = tb * 0.05;
    return { deviceSubtotal: ds, discountAmount: da, afterDiscount: ad,
      installLabor: il, commissioning: co, pm, servicesSubtotal: ss, taxable: tb, vat: vt, total: tb + vt };
  }, [quantities, discountRate]);

  const totalDeviceCount = useMemo(() => Object.values(quantities).reduce((a, b) => a + b, 0), [quantities]);

  const filteredCatalog = useMemo(() => {
    if (!deviceSearch.trim()) return DEVICE_CATALOG;
    const s = deviceSearch.toLowerCase();
    return DEVICE_CATALOG.map((c) => ({
      ...c, devices: c.devices.filter((d) => d.name.toLowerCase().includes(s) || d.id.includes(s))
    })).filter((c) => c.devices.length > 0);
  }, [deviceSearch]);

  const handleSave = async () => {
    if (!selectedLeadId) return;
    setSaving(true);
    try {
      const quoteNo = `Q-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const devicesPayload = Object.entries(quantities).map(([id, qty]) => {
        const d = findDevice(id);
        return { device_id: id, name: d?.name || id, price: d?.price || 0,
          quantity: qty, unit: d?.unit || "pcs", subtotal: (d?.price || 0) * qty };
      });
      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await supabase.from("quotations").insert({
        lead_id: selectedLeadId, quote_no: quoteNo, version: 1,
        subtotal: calc.deviceSubtotal, discount_rate: discountRate,
        discount_amount: calc.discountAmount, tax_rate: 5, tax_amount: calc.vat,
        total_amount: calc.total, currency: "AED", status: "draft",
        devices_json: devicesPayload,
        created_by: user?.id || null,
notes: `${t("quotes.calc.property")}: ${propertyType === "villa" ? t("quotes.calc.villaType") : t("quotes.calc.apartmentType")}, ${t("quotes.calc.area")}: ${area}㎡\n${t("quotes.calc.installLabor")} (30%): ${calc.installLabor.toFixed(2)} AED\n${t("quotes.calc.knxCommissioning")} (12%): ${calc.commissioning.toFixed(2)} AED\n${t("quotes.calc.projectMgmt")} (8%): ${calc.pm.toFixed(2)} AED`,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      if (error) { console.error("Save error:", error); toast.error(t("quotes.calc.saveFailed") + error.message); return; }
      // Notify about new quotation
      import("@/lib/notify").then(({ notify }) => {
        notify({ type: "quote_created", quote_id: quoteNo, lead_id: selectedLeadId, quote_no: quoteNo });
      }).catch(() => {});
      setSavedQuoteId(quoteNo); onSaved?.(); onOpenChange(false);
    } finally { setSaving(false); }
  };

  const handleExport = () => {
    if (!savedQuoteId) { toast.error(t("quotes.saveFirst")); return; }
    window.open(`/api/quotations/export?id=${savedQuoteId}`, "_blank");
  };

  const handleSend = () => {
    if (!savedQuoteId) { toast.error(t("quotes.saveFirst")); return; }
    toast.success(t("quotes.calc.quoteSaved"));
  };

  const handleReset = () => { setQuantities({}); setDiscountRate(5); setDeviceSearch(""); setSavedQuoteId(null); };

  const collapseBtn = (open: boolean) =>
    open ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> :
           <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleReset(); onOpenChange(o); }}>
      <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">📊 {t("quotes.calc.title")}</DialogTitle>
          <DialogDescription>{t("quotes.calc.desc")}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* ─── LEFT: Lead Info + Device Picker ─── */}
          <div className="space-y-3">
            {/* Lead Selection — skipped in embedded mode */}
            {!isEmbedded && (
            <div className="rounded-lg border border-border/40 p-3 space-y-2">
              <div>
                <label className="text-xs font-medium text-foreground mb-1 block">
                  {t("quotes.calc.customerLead")} <span className="text-rose-400">*</span>
                </label>
                <select value={selectedLeadId} onChange={(e) => handleLeadChange(e.target.value)}
                  className="w-full h-9 px-2.5 text-sm rounded-lg border border-input bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary">
                  <option value="">{t("quotes.calc.selectCustomer")}</option>
                  {leads.map((lead) => (
                    <option key={lead.id} value={lead.id}>
                      {lead.customer_name || "—"} {lead.phone ? `(${lead.phone})` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs font-medium text-foreground mb-1 block">{t("quotes.calc.customerName")}</label>
                  <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)}
                    placeholder={t("quotes.calc.autoFillOrManual")} className="h-8 text-xs" />
                </div>
                <div>
                  <label className="text-xs font-medium text-foreground mb-1 block">{t("quotes.calc.propertyType")}</label>
                  <select value={propertyType} onChange={(e) => setPropertyType(e.target.value as "villa" | "apartment")}
                    className="w-full h-8 px-2 text-xs rounded-lg border border-input bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary">
                    <option value="villa">🏠 {t("quotes.calc.villa")}</option>
                    <option value="apartment">🏢 {t("quotes.calc.apartment")}</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-foreground mb-1 block">{t("quotes.calc.areaSqm")}</label>
                <Input type="number" min={0} value={area || ""}
                  onChange={(e) => setArea(parseFloat(e.target.value) || 0)}
                  placeholder={t("quotes.calc.enterArea")} className="h-8 text-xs" />
              </div>
            </div>
            )}

            {/* Device Search */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input placeholder={t("quotes.calc.searchDevices")} value={deviceSearch}
                onChange={(e) => setDeviceSearch(e.target.value)} className="pl-9 h-8 text-xs" />
              {deviceSearch && (
                <button onClick={() => setDeviceSearch("")}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Device Categories */}
            <div className="space-y-1 max-h-[400px] overflow-y-auto pr-1">
              {filteredCatalog.map((cat) => (
                <Collapsible key={cat.key}
                  open={openSections[cat.key] ?? true}
                  onOpenChange={() => toggleSection(cat.key)}
                  className="rounded-lg border border-border/30">
                  <CollapsibleTrigger className="flex items-center justify-between w-full px-3 py-2
                    text-xs font-medium text-foreground hover:bg-accent/50 rounded-t-lg transition-colors
                    [&[data-state=closed]]:rounded-lg">
                    <span className="flex items-center gap-1.5">
                      <span className="text-sm">{cat.icon}</span> {cat.label}
                      <span className="text-[10px] text-muted-foreground ml-1">
                        ({cat.devices.filter((d) => getQty(d.id) > 0).length})
                      </span>
                    </span>
                    {collapseBtn(openSections[cat.key] ?? true)}
                  </CollapsibleTrigger>
                  <CollapsibleContent className="px-2 pb-2 space-y-1">
                    {cat.devices.map((device) => {
                      const qty = getQty(device.id);
                      return (
                        <div key={device.id}
                          className={cn("flex items-center justify-between px-2 py-1.5 rounded-md text-xs transition-colors",
                            qty > 0 ? "bg-copper-500/10 border border-copper-500/20" : "hover:bg-accent/30")}>
                          <div className="flex-1 min-w-0">
                            <p className="text-foreground truncate">{device.name}</p>
                            <p className="text-muted-foreground text-[10px]">
                              AED {device.price.toLocaleString()}{device.unit ? ` /${device.unit}` : ""}
                            </p>
                          </div>
                          <div className="flex items-center gap-1 ml-2 shrink-0">
                            <button onClick={() => decQty(device.id)} disabled={qty <= 0}
                              className={cn("w-6 h-6 flex items-center justify-center rounded border border-border/50 transition-colors",
                                qty > 0 ? "hover:bg-accent text-foreground" : "text-muted-foreground/30 cursor-not-allowed")}>
                              <Minus className="w-3 h-3" />
                            </button>
                            <Input type="number" min={0} max={999} value={qty || ""}
                              onChange={(e) => setQty(device.id, parseInt(e.target.value) || 0)}
                              className="w-12 h-6 text-xs text-center px-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
                            <button onClick={() => incQty(device.id)}
                              className="w-6 h-6 flex items-center justify-center rounded border border-border/50 hover:bg-accent text-foreground transition-colors">
                              <Plus className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
          </div>

          {/* ─── RIGHT: Live Totals ─── */}
          <div className="space-y-3">
            {/* Device summary */}
            <div className="rounded-lg border border-border/40 p-3">
              <h3 className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5">
                <span className="text-sm">📦</span> {t("quotes.calc.deviceList")} ({totalDeviceCount})
              </h3>
              {totalDeviceCount > 0 ? (
                <div className="space-y-1 max-h-[200px] overflow-y-auto">
                  {Object.entries(quantities).map(([id, qty]) => {
                    const device = findDevice(id);
                    if (!device) return null;
                    return (
                      <div key={id} className="flex items-center justify-between text-xs py-0.5">
                        <span className="text-foreground truncate mr-2">{device.name}</span>
                        <span className="text-muted-foreground shrink-0">
                          {qty} × AED {device.price.toLocaleString()}
                          <span className="text-copper-400 font-medium ml-1">= AED {fmtCurrency(device.price * qty)}</span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-[10px] text-muted-foreground text-center py-4">{t("quotes.calc.selectFromLeft")}</p>
              )}
            </div>

            {/* Calculation breakdown */}
            <div className="rounded-lg border border-border/40 p-3 space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{t("quotes.calc.deviceTotal")}</span>
                <span className="text-foreground font-medium">AED {fmtCurrency(calc.deviceSubtotal)}</span>
              </div>

              {/* Discount */}
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{t("quotes.discountRate")}</span>
                <div className="flex items-center gap-2">
                  <Input type="number" min={0} max={20} step={0.5} value={discountRate}
                    onChange={(e) => setDiscountRate(parseFloat(e.target.value) || 0)}
                    className="w-14 h-6 text-xs text-right px-1 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
                  <span className="text-muted-foreground text-[10px]">%</span>
                  {calc.discountAmount > 0 && (
                    <span className="text-rose-400 font-medium text-xs">-AED {fmtCurrency(calc.discountAmount)}</span>
                  )}
                </div>
              </div>
              <input type="range" min={0} max={20} step={0.5} value={discountRate}
                onChange={(e) => setDiscountRate(parseFloat(e.target.value))}
                className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-copper-500 bg-border" />

              {/* Services */}
              <div className="border-t border-border/20 pt-1.5 space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{t("quotes.calc.installLabor")}</span>
                  <span className="text-foreground">+AED {fmtCurrency(calc.installLabor)}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{t("quotes.calc.knxCommissioning")}</span>
                  <span className="text-foreground">+AED {fmtCurrency(calc.commissioning)}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{t("quotes.calc.projectMgmt")}</span>
                  <span className="text-foreground">+AED {fmtCurrency(calc.pm)}</span>
                </div>
                <div className="flex items-center justify-between text-xs border-t border-border/20 pt-1">
                  <span className="text-muted-foreground">{t("quotes.calc.serviceSubtotal")}</span>
                  <span className="text-foreground font-medium">AED {fmtCurrency(calc.servicesSubtotal)}</span>
                </div>
              </div>

              {/* Tax */}
              <div className="border-t border-border/20 pt-1.5 space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{t("quotes.calc.taxable")}</span>
                  <span className="text-foreground">AED {fmtCurrency(calc.taxable)}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">VAT (5%)</span>
                  <span className="text-foreground">+AED {fmtCurrency(calc.vat)}</span>
                </div>
              </div>

              {/* Grand Total */}
              <div className="border-t-2 border-copper-500/40 pt-2 mt-1">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold text-foreground">{t("quotes.calc.grandTotal")}</span>
                  <span className="text-lg font-bold text-copper-400">AED {fmtCurrency(calc.total)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ─── Footer Actions ─── */}
        <DialogFooter className="flex-wrap gap-2">
          <button onClick={handleReset}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-border/50 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
            <X className="w-3.5 h-3.5" /> {t("quotes.calc.reset")}
          </button>
          <DialogClose render={<Button variant="outline" size="sm" />}>{t("common.cancel")}</DialogClose>
          <Button variant="outline" size="sm" onClick={handleExport} disabled={!savedQuoteId} className="gap-1.5">
            <FileDown className="w-3.5 h-3.5" /> {t("quotes.calc.exportExcel")}
          </Button>
          <Button variant="outline" size="sm" onClick={handleSend} disabled={!savedQuoteId} className="gap-1.5">
            <Send className="w-3.5 h-3.5" /> {t("quotes.calc.sendToClient")}
          </Button>
          <Button onClick={handleSave} disabled={!selectedLeadId || saving || totalDeviceCount === 0} size="sm" className="gap-1.5">
            <Save className="w-3.5 h-3.5" /> {saving ? t("quotes.calc.saving") : t("quotes.calc.saveQuote")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
