"use client";

import { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card, CardContent, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";
import { ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Toaster } from "sonner";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { useRequireRole } from "@/hooks/useRequireRole";
import {
  buildPercentageInstallments,
  createSubmissionSession,
  submissionIdempotencyKey,
} from "@/lib/client-request-integrity";

const DEFAULT_PCTS = [50, 30, 20];
const DEFAULT_DAYS = [0, 30, 60];

interface LeadOption {
  id: string;
  customer_name: string | null;
  phone: string | null;
  quotation_value: number | null;
}

interface ContractCreatePayload {
  lead_id: string;
  amount: number;
  currency: string;
  party_a_name: string;
  party_a_contact: string | null;
  party_b_name: string;
  installments: Array<{
    seq: number;
    amount: number;
    due_date: string;
    description: string;
  }>;
}

interface ContractCreateAttempt {
  inputIdentity: string;
  payload: ContractCreatePayload;
  workflowKey: string;
}

function NewContractPageInner() {
  const { loading: roleLoading, blocked } = useRequireRole(["admin", "boss"]);
  const searchParams = useSearchParams();
  const presetLeadId = searchParams.get("lead_id");
  const { t } = useLanguage();
  const [saving, setSaving] = useState(false);
  const [leads, setLeads] = useState<LeadOption[]>([]);
  const [showLeadPicker, setShowLeadPicker] = useState(false);
  const [selectedLead, setSelectedLead] = useState<LeadOption | null>(null);
  const createAttemptRef = useRef<ContractCreateAttempt | null>(null);

  // Form fields
  const [contractAmount, setContractAmount] = useState("");
  const [partyAName, setPartyAName] = useState("");
  const [partyAPhone, setPartyAPhone] = useState("");
  const [pcts, setPcts] = useState(DEFAULT_PCTS.join(", "));
  const [dueDays, setDueDays] = useState(DEFAULT_DAYS.join(", "));

  useEffect(() => {
    const supabase = createClient();
    // Fetch eligible leads (not won/lost, or those with quotation_value)
    const fetchLeads = async () => {
      try {
        const { data, error } = await supabase.from("leads")
          .select("id, customer_name, phone, quotation_value")
          .not("quotation_value", "is", null)
          .gt("quotation_value", 0)
          .or("final_status.eq.won,current_milestone.in.(quotation_submitted,negotiation,pending_decision)")
          .order("customer_name", { ascending: true })
          .limit(100);
        if (error) console.error("Failed to fetch leads:", error);
        if (data) setLeads(data as LeadOption[]);

        // Pre-select a lead passed via ?lead_id= (e.g. navigated from a won lead)
        if (presetLeadId) {
          const { data: preset } = await supabase.from("leads")
            .select("id, customer_name, phone, quotation_value")
            .eq("id", presetLeadId)
            .maybeSingle();
          if (preset) {
            const lead = preset as LeadOption;
            setSelectedLead(lead);
            // Use functional updaters so we don't read state directly (keeps
            // the effect's dep array correct). Only prefill when still empty.
            // Narrow into locals first — TS doesn't preserve property-access
            // narrowing (lead.customer_name) inside the updater closures.
            if (lead.quotation_value) {
              const amount = String(lead.quotation_value);
              setContractAmount((prev) => prev || amount);
            }
            if (lead.customer_name) {
              const name = lead.customer_name;
              setPartyAName((prev) => prev || name);
            }
            if (lead.phone) {
              const phone = lead.phone;
              setPartyAPhone((prev) => prev || phone);
            }
          }
        }
      } catch (err) {
        console.error("Network error fetching leads:", err);
      }
    };
    fetchLeads();
  }, [presetLeadId]);

  if (roleLoading || blocked) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);

    if (!selectedLead) {
      toast.error(t("contracts.selectLead"));
      setSaving(false);
      return;
    }

    const amount = parseFloat(contractAmount);
    const amountCents = Math.round(amount * 100);
    if (!Number.isFinite(amount) || amount <= 0
      || Math.abs(amount * 100 - amountCents) > 1e-6) {
      toast.error(t("contracts.validAmount"));
      setSaving(false);
      return;
    }

    const pctList = pcts.split(",").map((value) => Number(value.trim()));
    const dayList = dueDays.split(",").map((value) => Number(value.trim()));

    if (pctList.length < 1 || pctList.length !== dayList.length
      || pctList.some((percentage) => !Number.isInteger(percentage) || percentage <= 0)
      || dayList.some((days) => !Number.isInteger(days) || days < 0)
      || pctList.reduce((sum, percentage) => sum + percentage, 0) !== 100) {
      toast.error(t("contracts.invalidInstallment"));
      setSaving(false);
      return;
    }

    // Create contract via the tenant-bound atomic workflow endpoint.
    let res: Response;
    try {
      const inputIdentity = JSON.stringify({
        lead_id: selectedLead.id,
        amount_cents: amountCents,
        party_a_name: partyAName || selectedLead.customer_name || "Unknown",
        party_a_contact: partyAPhone || selectedLead.phone || null,
        percentages: pctList,
        due_days: dayList,
      });
      let attempt = createAttemptRef.current;
      if (!attempt || attempt.inputIdentity !== inputIdentity) {
        const baseInstallments = buildPercentageInstallments(
          amountCents / 100,
          pctList,
          dayList,
          new Date(),
        );
        const payload: ContractCreatePayload = {
          lead_id: selectedLead.id,
          amount: amountCents / 100,
          currency: "AED",
          party_a_name: partyAName || selectedLead.customer_name || "Unknown",
          party_a_contact: partyAPhone || selectedLead.phone || null,
          party_b_name: "NewMe Smart Home FZCO",
          installments: baseInstallments.map((installment, index) => ({
            ...installment,
            description: index === 0
              ? t("contracts.installmentFirst")
              : index === baseInstallments.length - 1
                ? t("contracts.installmentLast")
                : t("contracts.installmentNth").replace("{n}", String(index + 1)),
          })),
        };
        attempt = {
          inputIdentity,
          payload,
          workflowKey: await submissionIdempotencyKey(
            "contract.create.ui",
            createSubmissionSession(),
            payload,
          ),
        };
        createAttemptRef.current = attempt;
      }
      res = await fetch("/api/contracts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": attempt.workflowKey,
        },
        body: JSON.stringify(attempt.payload),
      });
    } catch {
      toast.error(t("contracts.createFailed") || "Network error");
      setSaving(false);
      return;
    }

    const result = await res.json();

    if (!res.ok) {
      toast.error(result.error || t("contracts.createFailed"));
      setSaving(false);
      return;
    }

    createAttemptRef.current = null;
    toast.success(t("contracts.created").replace("{no}", result.contract_no));
    setSaving(false);
    window.location.href = "/contracts";
  }

  return (
    <DashboardScrollContainer className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => window.location.href = "/contracts"} className="text-muted-foreground">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h1 className="text-2xl font-bold">{t("contracts.new")}</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Lead selection */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">{t("contracts.customerLead")}</CardTitle>
          </CardHeader>
          <CardContent>
            {selectedLead ? (
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-foreground font-medium">{selectedLead.customer_name || t("contracts.unnamed")}</p>
                  <p className="text-xs text-muted-foreground">{selectedLead.phone || t("contracts.noPhone")} · {t("contracts.quotation")}: AED {selectedLead.quotation_value?.toLocaleString() || "—"}</p>
                </div>
                <Button type="button" size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setSelectedLead(null)}>
                  {t("contracts.change")}
                </Button>
              </div>
            ) : (
              <Button type="button" variant="outline" className="w-full border-border text-muted-foreground" onClick={() => setShowLeadPicker(true)}>
                {t("contracts.selectLead")}
              </Button>
            )}
          </CardContent>
        </Card>

        {/* Contract amount */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">{t("contracts.contractInfo")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-muted-foreground text-xs">{t("contracts.contractAmount")}</Label>
              <Input
                type="number" step="0.01" required
                value={contractAmount}
                onChange={(e) => setContractAmount(e.target.value)}
                placeholder={t("contracts.amountPlaceholder")}
                className="bg-muted border-border text-foreground h-9"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-muted-foreground text-xs">{t("contracts.partyAName")}</Label>
                <Input
                  value={partyAName}
                  onChange={(e) => setPartyAName(e.target.value)}
                  placeholder={t("contracts.partyANamePlaceholder")}
                  className="bg-muted border-border text-foreground h-9"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-muted-foreground text-xs">{t("contracts.partyAContact")}</Label>
                <Input
                  value={partyAPhone}
                  onChange={(e) => setPartyAPhone(e.target.value)}
                  placeholder={t("contracts.partyAContactPlaceholder")}
                  className="bg-muted border-border text-foreground h-9"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Payment terms */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">{t("contracts.paymentPlan")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-muted-foreground text-xs">{t("contracts.pctLabel")}</Label>
              <Input
                value={pcts}
                onChange={(e) => setPcts(e.target.value)}
                placeholder="50, 30, 20"
                className="bg-muted border-border text-foreground h-9"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-muted-foreground text-xs">{t("contracts.daysLabel")}</Label>
              <Input
                value={dueDays}
                onChange={(e) => setDueDays(e.target.value)}
                placeholder="0, 30, 60"
                className="bg-muted border-border text-foreground h-9"
              />
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={() => window.location.href = "/contracts"} className="text-muted-foreground">
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={saving}
            className="bg-copper-500 hover:bg-copper-600 text-black font-medium">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
            {saving ? t("contracts.creating") : t("contracts.createContract")}
          </Button>
        </div>
      </form>

      {/* Lead picker dialog */}
      <Dialog open={showLeadPicker} onOpenChange={setShowLeadPicker}>
        <DialogContent className="sm:max-w-lg bg-card border-border text-gray-100 max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-foreground text-lg">{t("contracts.selectLeadShort")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 pt-2">
            {leads.length === 0 ? (
              <p className="text-muted-foreground text-sm text-center py-4">{t("contracts.noEligibleLeads")}</p>
            ) : leads.map((lead) => (
              <button key={lead.id} type="button"
                onClick={() => {
                  setSelectedLead(lead);
                  if (!contractAmount && lead.quotation_value) setContractAmount(String(lead.quotation_value));
                  if (!partyAName && lead.customer_name) setPartyAName(lead.customer_name);
                  if (!partyAPhone && lead.phone) setPartyAPhone(lead.phone);
                  setShowLeadPicker(false);
                }}
                className="w-full text-left p-3 rounded-lg bg-muted border border-border hover:border-copper-500/50 transition-colors">
                <p className="text-foreground text-sm font-medium">{lead.customer_name || t("contracts.unnamed")}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{lead.phone || t("contracts.noPhone")} · AED {lead.quotation_value?.toLocaleString() || "—"}</p>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <Toaster position="top-center" richColors />
    </DashboardScrollContainer>
  );
}

// Wrap in Suspense so useSearchParams() works without a CSR bailout error.
export default function NewContractPage() {
  return (
    <Suspense fallback={<div className="text-muted-foreground p-8">Loading…</div>}>
      <NewContractPageInner />
    </Suspense>
  );
}
