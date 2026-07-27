"use client";

import { useState, useMemo, useEffect, useReducer } from "react";
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
import { Separator } from "@/components/ui/separator";
import {
  ChevronDown, ChevronUp, Plus, Minus, Search, X,
  Save, FileDown, Send, Check, ArrowLeft, ArrowRight,
  Home, Layers, Package, Calculator, FileText,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { DEVICE_CATALOG, findDevice, QUOTATION_DEFAULTS } from "@/lib/device-catalog";
import { calculateQuotation, type CalculateResult } from "@/lib/quotation-engine";
import { useLanguage } from "@/lib/i18n/LanguageContext";

interface Lead { id: string; customer_name: string | null; phone: string | null; }
interface Room { id: string; name: string; type: string; floor: number; }

interface QuoteWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
  initialLeadId?: string;
}

const ROOM_TYPES = [
  { value: "living", label: "🛋️ Living Room" }, { value: "bedroom", label: "🛏️ Bedroom" },
  { value: "kitchen", label: "🍳 Kitchen" }, { value: "bathroom", label: "🚿 Bathroom" },
  { value: "corridor", label: "🚪 Corridor" }, { value: "outdoor", label: "🌿 Outdoor" },
  { value: "garage", label: "🚗 Garage" }, { value: "study", label: "📚 Study" },
  { value: "majlis", label: "🛋️ Majlis" }, { value: "dining", label: "🍽️ Dining" },
  { value: "gym", label: "🏋️ Gym" }, { value: "cinema", label: "🎬 Cinema" },
  { value: "maid", label: "🧹 Maid Room" },
];

const STEPS = [
  { num: 1, label: "Project", icon: Home }, { num: 2, label: "Rooms", icon: Layers },
  { num: 3, label: "Devices", icon: Package }, { num: 4, label: "Services", icon: Calculator },
  { num: 5, label: "Review", icon: FileText },
];

function fmtCurrency(v: number): string {
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + "M";
  if (v >= 1_000) return (v / 1_000).toFixed(2) + "K";
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

let _rid = 0;
function genRoomId() { return `rm_${++_rid}_${Date.now().toString(36)}`; }

interface WState {
  step: number; selectedLeadId: string; customerName: string;
  propertyType: "villa" | "apartment"; area: number; floors: number;
  rooms: Room[]; quantities: Record<string, Record<string, number>>;
  selectedRoomIndex: number; discountRate: number;
  saving: boolean; savedQuoteId: string | null;
  deviceSearch: string; openSections: Record<string, boolean>;
}

const initState: WState = {
  step: 1, selectedLeadId: "", customerName: "", propertyType: "villa",
  area: 0, floors: 1, rooms: [], quantities: {}, selectedRoomIndex: 0,
  discountRate: 5, saving: false, savedQuoteId: null, deviceSearch: "", openSections: {},
};

type WAction =
  | { type: "S"; step: number } | { type: "L"; leadId: string }
  | { type: "N"; name: string } | { type: "P"; ptype: "villa" | "apartment" }
  | { type: "A"; area: number } | { type: "F"; floors: number }
  | { type: "RS"; rooms: Room[] } | { type: "AR"; room: Room }
  | { type: "RR"; roomId: string } | { type: "SI"; index: number }
  | { type: "DQ"; roomId: string; deviceId: string; qty: number }
  | { type: "DR"; rate: number } | { type: "OS"; sections: Record<string, boolean> }
  | { type: "TS"; key: string } | { type: "DS"; search: string }
  | { type: "SV"; saving: boolean } | { type: "SQ"; id: string | null }
  | { type: "R" };

function wizRed(state: WState, action: WAction): WState {
  switch (action.type) {
    case "S": return { ...state, step: action.step };
    case "L": return { ...state, selectedLeadId: action.leadId };
    case "N": return { ...state, customerName: action.name };
    case "P": return { ...state, propertyType: action.ptype };
    case "A": return { ...state, area: action.area };
    case "F": return { ...state, floors: action.floors };
    case "RS": return { ...state, rooms: action.rooms };
    case "AR": return { ...state, rooms: [...state.rooms, action.room] };
    case "RR": {
      const rooms = state.rooms.filter((r) => r.id !== action.roomId);
      const q = { ...state.quantities }; delete q[action.roomId];
      return { ...state, rooms, quantities: q, selectedRoomIndex: Math.min(state.selectedRoomIndex, rooms.length - 1) };
    }
    case "SI": return { ...state, selectedRoomIndex: action.index };
    case "DQ": {
      const q = { ...state.quantities };
      if (!q[action.roomId]) q[action.roomId] = {};
      if (action.qty <= 0) delete q[action.roomId][action.deviceId];
      else q[action.roomId] = { ...q[action.roomId], [action.deviceId]: action.qty };
      if (Object.keys(q[action.roomId]).length === 0) delete q[action.roomId];
      return { ...state, quantities: q };
    }
    case "DR": return { ...state, discountRate: action.rate };
    case "OS": return { ...state, openSections: action.sections };
    case "TS": return { ...state, openSections: { ...state.openSections, [action.key]: !state.openSections[action.key] } };
    case "DS": return { ...state, deviceSearch: action.search };
    case "SV": return { ...state, saving: action.saving };
    case "SQ": return { ...state, savedQuoteId: action.id };
    case "R": return { ...initState };
    default: return state;
  }
}

export default function QuoteWizard({ open, onOpenChange, onSaved, initialLeadId }: QuoteWizardProps) {
  const { t, lang } = useLanguage();
  const supabase = createClient();
  const isEmbedded = !!initialLeadId;
  const [s, d] = useReducer(wizRed, initState);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [newRoomType, setNewRoomType] = useState("living");
  const [newRoomFloor, setNewRoomFloor] = useState(1);

  useEffect(() => {
    if (!open) return;
    if (isEmbedded) {
      supabase.from("leads").select("id, customer_name, phone, property_type, property_size_sqm")
        .eq("id", initialLeadId).single()
        .then(({ data }) => {
          if (data) {
            d({ type: "L", leadId: data.id });
            d({ type: "N", name: data.customer_name || data.phone || "" });
            if (data.property_type === "villa" || data.property_type === "apartment")
              d({ type: "P", ptype: data.property_type });
            if (data.property_size_sqm) d({ type: "A", area: data.property_size_sqm });
          }
        });
    } else {
      supabase.from("leads").select("id, customer_name, phone")
        .order("customer_name", { ascending: true })
        .then(({ data }) => { if (data) setLeads(data as Lead[]); });
    }
  }, [open, supabase, isEmbedded, initialLeadId]);

  const totalDeviceCount = useMemo(() =>
    Object.values(s.quantities).reduce((sum, q) => sum + Object.values(q).reduce((a, b) => a + b, 0), 0), [s.quantities]);

  const flatQ = useMemo(() => {
    const f: Record<string, number> = {};
    for (const rm of s.rooms) {
      const rq = s.quantities[rm.id];
      if (rq) for (const [id, qty] of Object.entries(rq)) f[id] = (f[id] || 0) + qty;
    }
    return f;
  }, [s.rooms, s.quantities]);

  const calc: CalculateResult = useMemo(() =>
    calculateQuotation({ devices: flatQ, discount_rate: s.discountRate }), [flatQ, s.discountRate]);

  const curRoom = s.rooms[s.selectedRoomIndex];

  const canNext = () => {
    switch (s.step) {
      case 1: return !!s.selectedLeadId && !!s.customerName && s.area > 0;
      case 2: return s.rooms.length > 0;
      case 3: return totalDeviceCount > 0;
      default: return true;
    }
  };

  const handleLead = (leadId: string) => {
    d({ type: "L", leadId });
    const lead = leads.find((l) => l.id === leadId);
    d({ type: "N", name: lead?.customer_name || lead?.phone || "" });
  };

  const addRoom = () => {
    const cnt = s.rooms.filter((r) => r.floor === newRoomFloor).length + 1;
    const t = ROOM_TYPES.find((r) => r.value === newRoomType);
    const base = t ? t.label.split(" ").slice(1).join(" ") : newRoomType;
    d({ type: "AR", room: { id: genRoomId(), name: `${base} ${cnt}`, type: newRoomType, floor: newRoomFloor } });
  };

  const updRoom = (rid: string, field: "name" | "type", val: string) => {
    d({ type: "RS", rooms: s.rooms.map((r) => r.id === rid ? { ...r, [field]: val } : r) });
  };

  const setQty = (rid: string, did: string, qty: number) => d({ type: "DQ", roomId: rid, deviceId: did, qty: Math.max(0, qty) });
  const incQ = (rid: string, did: string) => setQty(rid, did, (s.quantities[rid]?.[did] || 0) + 1);
  const decQ = (rid: string, did: string) => {
    const cur = s.quantities[rid]?.[did] || 0;
    if (cur > 0) setQty(rid, did, cur - 1);
  };

  const reset = () => { _rid = 0; d({ type: "R" }); };
  const goStep = (st: number) => { if (st > s.step && !canNext()) return; if (st >= 1 && st <= 5) d({ type: "S", step: st }); };
  const toggleSec = (k: string) => d({ type: "TS", key: k });

  const filtered = useMemo(() => {
    if (!s.deviceSearch.trim()) return DEVICE_CATALOG;
    const q = s.deviceSearch.toLowerCase();
    return DEVICE_CATALOG.map((c) => ({ ...c, devices: c.devices.filter((d) => d.name.toLowerCase().includes(q) || d.id.includes(q)) })).filter((c) => c.devices.length > 0);
  }, [s.deviceSearch]);

  const handleSave = async () => {
    if (!s.selectedLeadId) return;
    d({ type: "SV", saving: true });
    try {
      const { data: rpcQuoteNo, error: rpcError } = await supabase.rpc('next_quote_no');
      if (rpcError || !rpcQuoteNo) { console.error("RPC error:", rpcError); toast.error(t("quotes.calc.saveFailed") + (rpcError?.message || "Failed to generate quote number")); return; }
      const qn = rpcQuoteNo as string;
      const dp = Object.entries(flatQ).map(([id, qty]) => {
        const dev = findDevice(id);
        return { device_id: id, name: dev?.name || id, price: dev?.price || 0, quantity: qty, unit: dev?.unit || "pcs", subtotal: (dev?.price || 0) * qty };
      });
      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await supabase.from("quotations").insert({
        lead_id: s.selectedLeadId, quote_no: qn, version: 1,
        subtotal: calc.subtotal, discount_rate: s.discountRate,
        discount_amount: calc.discount_amount, tax_rate: 5, tax_amount: calc.tax_amount,
        total_amount: calc.total, currency: "AED", status: "draft",
        devices_json: dp, created_by: user?.id || null,
        notes: `${t("quotes.calc.property")}: ${s.propertyType === "villa" ? t("quotes.calc.villaType") : t("quotes.calc.apartmentType")}, ${t("quotes.calc.area")}: ${s.area}㎡\n${t("quotes.calc.installLabor")} (30%): ${calc.install_labor.toFixed(2)} AED\n${t("quotes.calc.knxCommissioning")} (12%): ${calc.commissioning.toFixed(2)} AED\n${t("quotes.calc.projectMgmt")} (8%): ${calc.project_management.toFixed(2)} AED`,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      if (error) { console.error("Save error:", error); toast.error(t("quotes.calc.saveFailed") + error.message); return; }
      // Notify about new quotation
      import("@/lib/notify").then(({ notify }) => {
        notify({ type: "quote_created", quote_id: qn, lead_id: s.selectedLeadId, quote_no: qn });
      }).catch(() => {});
      d({ type: "SQ", id: qn }); onSaved?.(); onOpenChange(false);
    } finally { d({ type: "SV", saving: false }); }
  };

  const handleExp = () => {
    if (!s.savedQuoteId) { toast.error(t("quotes.saveFirst")); return; }
    window.open(`/api/quotations/export?id=${s.savedQuoteId}`, "_blank");
  };
  const handleSend = () => {
    if (!s.savedQuoteId) { toast.error(t("quotes.saveFirst")); return; }
    const url = `${window.location.origin}/quotes?id=${s.savedQuoteId}`;
    navigator.clipboard.writeText(url).then(
      () => toast.success(t("quotes.linkCopied")),
      () => toast.info(url)
    );
  };

  const cBtn = (open: boolean) =>
    open ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />;

  /* Step indicator */
  const stepInd = (
    <div className="flex items-center justify-center gap-0 py-3">
      {STEPS.map((st, i) => (
        <div key={st.num} className="flex items-center">
          <button onClick={() => goStep(st.num)}
            disabled={st.num > s.step && !(st.num === s.step + 1 && canNext()) && st.num !== s.step}
            className={cn("flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-all",
              s.step === st.num ? "bg-copper-500/20 text-copper-300 border border-copper-500/30" :
              s.step > st.num ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" :
              "text-muted-foreground border border-transparent")}>
            <span className={cn("flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold",
              s.step === st.num ? "bg-copper-500 text-foreground" :
              s.step > st.num ? "bg-emerald-500 text-foreground" : "bg-accent/60 text-muted-foreground")}>
              {s.step > st.num ? <Check className="w-3 h-3" /> : st.num}
            </span>
            <span className="hidden sm:inline">{st.label}</span>
          </button>
          {i < STEPS.length - 1 && <div className={cn("w-6 h-px mx-0.5", s.step > st.num ? "bg-emerald-500/40" : "bg-border/40")} />}
        </div>
      ))}
    </div>
  );

  /* ═══ Step 1 ═══ */
  const st1 = (
    <div className="space-y-4">
      <div className="rounded-lg border border-border/40 p-4 space-y-4">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Home className="w-4 h-4 text-copper-400" /> Project Information</h3>
        {!isEmbedded && (
          <div>
            <label className="text-xs font-medium text-foreground mb-1.5 block">{t("quotes.calc.customerLead")} <span className="text-rose-400">*</span></label>
            <select value={s.selectedLeadId} onChange={(e) => handleLead(e.target.value)}
              className="w-full h-9 px-2.5 text-sm rounded-lg border border-input bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary">
              <option value="">{t("quotes.calc.selectCustomer")}</option>
              {leads.map((l) => <option key={l.id} value={l.id}>{l.customer_name || "—"} {l.phone ? `(${l.phone})` : ""}</option>)}
            </select>
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-foreground mb-1.5 block">{t("quotes.calc.customerName")} <span className="text-rose-400">*</span></label>
            <Input value={s.customerName} onChange={(e) => d({ type: "N", name: e.target.value })} placeholder={t("quotes.calc.autoFillOrManual")} className="h-9 text-sm" />
          </div>
          <div>
            <label className="text-xs font-medium text-foreground mb-1.5 block">{t("quotes.calc.propertyType")}</label>
            <select value={s.propertyType} onChange={(e) => d({ type: "P", ptype: e.target.value as "villa" | "apartment" })}
              className="w-full h-9 px-2.5 text-sm rounded-lg border border-input bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary">
              <option value="villa">🏠 {t("quotes.calc.villa")}</option>
              <option value="apartment">🏢 {t("quotes.calc.apartment")}</option>
            </select>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-foreground mb-1.5 block">{t("quotes.calc.areaSqm")} <span className="text-rose-400">*</span></label>
            <Input type="number" min={0} value={s.area || ""} onChange={(e) => d({ type: "A", area: parseFloat(e.target.value) || 0 })} placeholder={t("quotes.calc.enterArea")} className="h-9 text-sm" />
          </div>
          <div>
            <label className="text-xs font-medium text-foreground mb-1.5 block">{t("quotes.floors")}</label>
            <select value={s.floors} onChange={(e) => d({ type: "F", floors: parseInt(e.target.value) || 1 })}
              className="w-full h-9 px-2.5 text-sm rounded-lg border border-input bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary">
              {[1, 2, 3, 4].map((f) => <option key={f} value={f}>{f} {f === 1 ? t("quotes.floor") : t("quotes.floors")}</option>)}
            </select>
          </div>
        </div>
      </div>
    </div>
  );

  /* ═══ Step 2 ═══ */
  const st2 = (
    <div className="space-y-4">
      <div className="rounded-lg border border-border/40 p-4 space-y-4">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Layers className="w-4 h-4 text-copper-400" /> Room Layout</h3>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[140px]">
            <label className="text-xs font-medium text-foreground mb-1 block">{t("quotes.type")}</label>
            <select value={newRoomType} onChange={(e) => setNewRoomType(e.target.value)}
              className="w-full h-8 px-2 text-xs rounded-lg border border-input bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary">
              {ROOM_TYPES.map((rt) => <option key={rt.value} value={rt.value}>{rt.label}</option>)}
            </select>
          </div>
          <div className="w-[100px]">
            <label className="text-xs font-medium text-foreground mb-1 block">{t("quotes.floor")}</label>
            <select value={newRoomFloor} onChange={(e) => setNewRoomFloor(parseInt(e.target.value))}
              className="w-full h-8 px-2 text-xs rounded-lg border border-input bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary">
              {Array.from({ length: s.floors }, (_, i) => i + 1).map((f) => <option key={f} value={f}>F{f}</option>)}
            </select>
          </div>
          <Button size="sm" onClick={addRoom} className="gap-1 h-8"><Plus className="w-3.5 h-3.5" /> Add</Button>
        </div>
        {s.rooms.length > 0 ? (
          <div className="space-y-2">
            {(() => {
              const floors = [...new Set(s.rooms.map((r) => r.floor))].sort();
              return floors.map((fl) => (
                <div key={fl} className="rounded-lg border border-border/30 p-3">
                  <p className="text-xs font-semibold text-muted-foreground mb-2">Floor {fl}: {s.rooms.filter((r) => r.floor === fl).length} rooms</p>
                  <div className="space-y-1.5">
                    {s.rooms.filter((r) => r.floor === fl).map((rm) => (
                      <div key={rm.id} className="flex items-center gap-2 bg-accent/20 rounded-md px-3 py-2">
                        <div className="flex-1 min-w-0 flex items-center gap-2">
                          <input value={rm.name} onChange={(e) => updRoom(rm.id, "name", e.target.value)}
                            className="h-7 px-2 text-xs rounded border border-border/30 bg-background text-foreground flex-1 min-w-0 focus:outline-none focus:ring-1 focus:ring-primary" />
                          <select value={rm.type} onChange={(e) => updRoom(rm.id, "type", e.target.value)}
                            className="h-7 px-1.5 text-[10px] rounded border border-border/30 bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary max-w-[90px]">
                            {ROOM_TYPES.map((rt) => <option key={rt.value} value={rt.value}>{rt.label.split(" ").slice(1).join(" ")}</option>)}
                          </select>
                        </div>
                        <button onClick={() => d({ type: "RR", roomId: rm.id })}
                          className="p-1 rounded text-muted-foreground hover:text-rose-400 hover:bg-rose-500/10 transition-colors"><X className="w-3.5 h-3.5" /></button>
                      </div>
                    ))}
                  </div>
                </div>
              ));
            })()}
          </div>
        ) : (
          <div className="text-center py-8 text-xs text-muted-foreground">
            <Layers className="w-8 h-8 mx-auto mb-2 text-muted-foreground/30" />No rooms added yet.
          </div>
        )}
        <div className="rounded-lg border border-dashed border-copper-500/20 bg-copper-500/5 p-3 text-center">
          <p className="text-[10px] text-copper-400/70">📐 {t("quotes.calc.cadComingSoon")}</p>
        </div>
      </div>
    </div>
  );

  /* ═══ Step 3 ═══ */
  const st3 = (() => {
    if (s.rooms.length === 0) return <div className="text-center py-12 text-sm text-muted-foreground"><Package className="w-10 h-10 mx-auto mb-2 text-muted-foreground/30" />Add rooms first in Step 2.</div>;

    const roomTotal = (rid: string) => {
      const rq = s.quantities[rid]; if (!rq) return 0;
      return Object.entries(rq).reduce((sum, [id, qty]) => sum + (findDevice(id)?.price || 0) * qty, 0);
    };

    return (
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <div className="lg:col-span-1 space-y-1">
          <h3 className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5"><Layers className="w-3.5 h-3.5 text-copper-400" /> Rooms</h3>
          <div className="space-y-1 max-h-[400px] overflow-y-auto">
            {s.rooms.map((rm, i) => (
              <button key={rm.id} onClick={() => d({ type: "SI", index: i })}
                className={cn("w-full text-left px-3 py-2 rounded-lg text-xs transition-colors border",
                  s.selectedRoomIndex === i ? "bg-copper-500/10 border-copper-500/30 text-copper-300" : "bg-accent/20 border-transparent text-foreground hover:bg-accent/40")}>
                <p className="font-medium truncate">{rm.name}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">F{rm.floor} · AED {fmtCurrency(roomTotal(rm.id))}</p>
              </button>
            ))}
          </div>
          {totalDeviceCount > 0 && (
            <div className="mt-3 rounded-lg border border-copper-500/20 bg-copper-500/5 p-2.5 text-center">
              <p className="text-[10px] text-muted-foreground">{t("quotes.totalDevices")}</p>
              <p className="text-sm font-bold text-copper-400">{totalDeviceCount} pcs · AED {fmtCurrency(calc.subtotal)}</p>
            </div>
          )}
        </div>
        <div className="lg:col-span-3 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-foreground flex items-center gap-1.5">
              <Package className="w-3.5 h-3.5 text-copper-400" /> {curRoom ? `${curRoom.name} — ${t("quotes.devices")}` : "Select a room"}</h3>
            <span className="text-[10px] text-muted-foreground">Room AED {fmtCurrency(curRoom ? roomTotal(curRoom.id) : 0)}</span>
          </div>
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder={t("quotes.calc.searchDevices")} value={s.deviceSearch} onChange={(e) => d({ type: "DS", search: e.target.value })} className="pl-9 h-8 text-xs" />
            {s.deviceSearch && <button onClick={() => d({ type: "DS", search: "" })} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><X className="w-3.5 h-3.5" /></button>}
          </div>
          <div className="space-y-1 max-h-[420px] overflow-y-auto pr-1">
            {filtered.map((cat) => {
              const open = s.openSections[cat.key] !== false;
              return (
                <Collapsible key={cat.key} open={open} onOpenChange={() => toggleSec(cat.key)} className="rounded-lg border border-border/30">
                  <CollapsibleTrigger className="flex items-center justify-between w-full px-3 py-2 text-xs font-medium text-foreground hover:bg-accent/50 rounded-t-lg transition-colors [&[data-state=closed]]:rounded-lg">
                    <span className="flex items-center gap-1.5"><span className="text-sm">{cat.icon}</span> {cat.label}</span>
                    {cBtn(open)}
                  </CollapsibleTrigger>
                  <CollapsibleContent className="px-2 pb-2 space-y-1">
                    {cat.devices.map((dev) => {
                      const qty = curRoom ? (s.quantities[curRoom.id]?.[dev.id] || 0) : 0;
                      return (
                        <div key={dev.id} className={cn("flex items-center justify-between px-2 py-1.5 rounded-md text-xs transition-colors",
                          qty > 0 ? "bg-copper-500/10 border border-copper-500/20" : "hover:bg-accent/30")}>
                          <div className="flex-1 min-w-0">
                            <p className="text-foreground truncate">{dev.name}</p>
                            <p className="text-muted-foreground text-[10px]">AED {dev.price.toLocaleString()}{dev.unit ? ` /${dev.unit}` : ""}</p>
                          </div>
                          <div className="flex items-center gap-1 ml-2 shrink-0">
                            <button onClick={() => curRoom && decQ(curRoom.id, dev.id)} disabled={qty <= 0}
                              className={cn("w-6 h-6 flex items-center justify-center rounded border border-border/50 transition-colors",
                                qty > 0 ? "hover:bg-accent text-foreground" : "text-muted-foreground/30 cursor-not-allowed")}><Minus className="w-3 h-3" /></button>
                            <Input type="number" min={0} max={999} value={qty || ""}
                              onChange={(e) => curRoom && setQty(curRoom.id, dev.id, parseInt(e.target.value) || 0)}
                              className="w-12 h-6 text-xs text-center px-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
                            <button onClick={() => curRoom && incQ(curRoom.id, dev.id)}
                              className="w-6 h-6 flex items-center justify-center rounded border border-border/50 hover:bg-accent text-foreground transition-colors"><Plus className="w-3 h-3" /></button>
                          </div>
                        </div>
                      );
                    })}
                  </CollapsibleContent>
                </Collapsible>
              );
            })}
          </div>
        </div>
      </div>
    );
  })();

  /* ═══ Step 4 ═══ */
  const st4 = (
    <div className="space-y-4">
      <div className="rounded-lg border border-border/40 p-4 space-y-4">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2"><Calculator className="w-4 h-4 text-copper-400" /> Service Fees & Pricing</h3>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-foreground">{t("quotes.discountRate")}</label>
            <div className="flex items-center gap-1">
              <Input type="number" min={0} max={20} step={0.5} value={s.discountRate}
                onChange={(e) => d({ type: "DR", rate: parseFloat(e.target.value) || 0 })} className="w-16 h-7 text-xs text-right" /><span className="text-xs text-muted-foreground">%</span>
            </div>
          </div>
          <input type="range" min={0} max={20} step={0.5} value={s.discountRate}
            onChange={(e) => d({ type: "DR", rate: parseFloat(e.target.value) })}
            className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-copper-500 bg-border" />
        </div>
        <div className="rounded-lg bg-accent/20 p-3 space-y-1.5">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{t("quotes.serviceRates")}</p>
          <div className="flex items-center justify-between text-xs"><span className="text-muted-foreground">{t("quotes.installationLabor")}</span><span className="text-foreground font-medium">{QUOTATION_DEFAULTS.install_labor_pct}%</span></div>
          <div className="flex items-center justify-between text-xs"><span className="text-muted-foreground">{t("quotes.knxCommissioning")}</span><span className="text-foreground font-medium">{QUOTATION_DEFAULTS.commissioning_pct}%</span></div>
          <div className="flex items-center justify-between text-xs"><span className="text-muted-foreground">{t("quotes.projectManagement")}</span><span className="text-foreground font-medium">{QUOTATION_DEFAULTS.pm_pct}%</span></div>
        </div>
        <div className="rounded-lg border border-border/30 p-4 space-y-2">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">📊 Price Breakdown</p>
          <div className="flex items-center justify-between text-xs"><span className="text-muted-foreground">{t("quotes.deviceSubtotal")}</span><span className="text-foreground font-medium">AED {fmtCurrency(calc.subtotal)}</span></div>
          {s.discountRate > 0 && <div className="flex items-center justify-between text-xs"><span className="text-muted-foreground">{t("quotes.discount")} ({s.discountRate}%)</span><span className="text-rose-400 font-medium">-AED {fmtCurrency(calc.discount_amount)}</span></div>}
          <Separator className="my-1" />
          <div className="flex items-center justify-between text-xs"><span className="text-muted-foreground">{t("quotes.afterDiscount")}</span><span className="text-foreground font-semibold">AED {fmtCurrency(calc.after_discount)}</span></div>
          <div className="border-t border-border/20 pt-2 space-y-1">
            <div className="flex items-center justify-between text-xs"><span className="text-muted-foreground">{t("quotes.calc.installLabor")}</span><span className="text-foreground">+AED {fmtCurrency(calc.install_labor)}</span></div>
            <div className="flex items-center justify-between text-xs"><span className="text-muted-foreground">{t("quotes.calc.knxCommissioning")}</span><span className="text-foreground">+AED {fmtCurrency(calc.commissioning)}</span></div>
            <div className="flex items-center justify-between text-xs"><span className="text-muted-foreground">{t("quotes.calc.projectMgmt")}</span><span className="text-foreground">+AED {fmtCurrency(calc.project_management)}</span></div>
            <Separator className="my-1" />
            <div className="flex items-center justify-between text-xs"><span className="text-muted-foreground">{t("quotes.calc.serviceSubtotal")}</span><span className="text-foreground font-medium">AED {fmtCurrency(calc.subtotal_services)}</span></div>
          </div>
          <div className="border-t border-border/20 pt-2 space-y-1">
            <div className="flex items-center justify-between text-xs"><span className="text-muted-foreground">{t("quotes.calc.taxable")}</span><span className="text-foreground">AED {fmtCurrency(calc.taxable)}</span></div>
            <div className="flex items-center justify-between text-xs"><span className="text-muted-foreground">VAT (5%)</span><span className="text-foreground">+AED {fmtCurrency(calc.tax_amount)}</span></div>
          </div>
          <div className="border-t-2 border-copper-500/40 pt-2 mt-1">
            <div className="flex items-center justify-between"><span className="text-sm font-bold text-foreground">{t("quotes.calc.grandTotal")}</span><span className="text-lg font-bold text-copper-400">AED {fmtCurrency(calc.total)}</span></div>
          </div>
        </div>
      </div>
    </div>
  );

  /* ═══ Step 5 ═══ */
  const st5 = (
    <div className="space-y-4">
      <div className="rounded-lg border border-border/40 p-4 space-y-4">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2"><FileText className="w-4 h-4 text-copper-400" /> Quotation Preview</h3>
        <div className="rounded-lg bg-accent/20 p-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div><p className="text-[10px] text-muted-foreground">{t("quotes.customer")}</p><p className="text-xs font-medium text-foreground">{s.customerName}</p></div>
          <div><p className="text-[10px] text-muted-foreground">{t("quotes.property")}</p><p className="text-xs font-medium text-foreground">{s.propertyType === "villa" ? "🏠 Villa" : "🏢 Apartment"} · {s.area}㎡</p></div>
          <div><p className="text-[10px] text-muted-foreground">{t("quotes.floors")}</p><p className="text-xs font-medium text-foreground">{s.floors}</p></div>
          <div><p className="text-[10px] text-muted-foreground">{t("quotes.rooms")}</p><p className="text-xs font-medium text-foreground">{s.rooms.length}</p></div>
        </div>
        {calc.breakdown.length > 0 && (
          <div className="space-y-2">
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{t("quotes.devices")}</p>
            {calc.breakdown.map((cat) => (
              <div key={cat.category} className="rounded-lg border border-border/30">
                <div className="px-3 py-1.5 bg-accent/20 text-xs font-medium text-foreground flex items-center justify-between">
                  <span>{cat.category}</span><span className="text-copper-400">AED {fmtCurrency(cat.subtotal)}</span>
                </div>
                <div className="px-3 py-1.5 space-y-1">
                  {cat.items.map((item) => (
                    <div key={item.device_id} className="flex items-center justify-between text-[11px]">
                      <span className="text-foreground truncate mr-2">{item.name}</span>
                      <span className="text-muted-foreground shrink-0">{item.qty} × AED {item.unit_price.toLocaleString()}<span className="text-copper-400 font-medium ml-1">= AED {fmtCurrency(item.line_total)}</span></span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="space-y-1">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{t("quotes.rooms")}</p>
          {s.rooms.map((rm) => {
            const rq = s.quantities[rm.id];
            const cnt = rq ? Object.values(rq).reduce((a, b) => a + b, 0) : 0;
            return <div key={rm.id} className="flex items-center justify-between text-xs px-2 py-1 rounded bg-accent/10"><span className="text-foreground">{rm.name} (F{rm.floor})</span><span className="text-muted-foreground">{cnt} devices</span></div>;
          })}
        </div>
        <div className="rounded-lg border border-copper-500/20 bg-copper-500/5 p-4 space-y-1.5">
          <div className="flex items-center justify-between text-xs"><span className="text-muted-foreground">{t("quotes.deviceSubtotal")}</span><span className="text-foreground">AED {fmtCurrency(calc.subtotal)}</span></div>
          {s.discountRate > 0 && <div className="flex items-center justify-between text-xs"><span className="text-muted-foreground">{t("quotes.discount")} ({s.discountRate}%)</span><span className="text-rose-400">-AED {fmtCurrency(calc.discount_amount)}</span></div>}
          <div className="flex items-center justify-between text-xs"><span className="text-muted-foreground">{t("quotes.services")}</span><span className="text-foreground">AED {fmtCurrency(calc.subtotal_services)}</span></div>
          <div className="flex items-center justify-between text-xs"><span className="text-muted-foreground">VAT (5%)</span><span className="text-foreground">AED {fmtCurrency(calc.tax_amount)}</span></div>
          <Separator className="my-1" />
          <div className="flex items-center justify-between"><span className="text-sm font-bold text-foreground">{t("quotes.total")}</span><span className="text-lg font-bold text-copper-400">AED {fmtCurrency(calc.total)}</span></div>
        </div>
        <div className="flex flex-wrap gap-2 justify-end">
          <Button variant="outline" size="sm" onClick={handleExp} disabled={!s.savedQuoteId} className="gap-1.5"><FileDown className="w-3.5 h-3.5" /> {t("quotes.calc.exportExcel")}</Button>
          <Button variant="outline" size="sm" onClick={handleSend} disabled={!s.savedQuoteId} className="gap-1.5"><Send className="w-3.5 h-3.5" /> {t("quotes.calc.sendToClient")}</Button>
          <Button onClick={handleSave} disabled={!s.selectedLeadId || s.saving || totalDeviceCount === 0} size="sm" className="gap-1.5">
            <Save className="w-3.5 h-3.5" /> {s.saving ? t("quotes.calc.saving") : t("quotes.calc.saveQuote")}
          </Button>
        </div>
      </div>
    </div>
  );

  const stepContent = [st1, st2, st3, st4, st5];

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="sm:max-w-5xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg"><Calculator className="w-5 h-5 text-copper-400" /> {t("quotes.calc.title")}</DialogTitle>
          <DialogDescription>{t("quotes.calc.desc")}</DialogDescription>
        </DialogHeader>
        {stepInd}
        <div className="min-h-[300px]">{stepContent[s.step - 1]}</div>
        <DialogFooter className="flex items-center justify-between gap-2 border-t border-border/20 pt-4 mt-4">
          <div className="flex items-center gap-2">
            {s.step > 1 && <Button variant="outline" size="sm" onClick={() => goStep(s.step - 1)} className="gap-1"><ArrowLeft className="w-3.5 h-3.5" /> Previous</Button>}
            <button onClick={reset} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-border/50 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"><X className="w-3.5 h-3.5" /> {t("quotes.calc.reset")}</button>
          </div>
          <div className="flex items-center gap-2">
            {s.step < 5 ? <Button size="sm" onClick={() => goStep(s.step + 1)} disabled={!canNext()} className="gap-1">{t("quotes.next")} <ArrowRight className="w-3.5 h-3.5" /></Button>
            : <DialogClose render={<Button variant="outline" size="sm" />}>{t("quotes.close")}</DialogClose>}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
