"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorState } from "@/components/ui/error-state";
import { cn } from "@/lib/utils";
import { CreditCard, DollarSign, Calendar, CheckCircle, AlertTriangle, Clock, Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Toaster } from "sonner";

interface Installment {
  id: string; contract_id: string; seq: number; amount: number;
  due_date: string; status: string; paid_amount: number; description: string | null;
  contracts?: { contract_no: string; contract_amount: number; party_a_name: string; lead_id: string } | null;
}

export default function PaymentsPage() {
  const supabase = createClient();
  const { t, lang } = useLanguage();
  const [installments, setInstallments] = useState<Installment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  // Payment recording dialog state
  const [recordDialogOpen, setRecordDialogOpen] = useState(false);
  const [selectedInst, setSelectedInst] = useState<Installment | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));
  const [payNotes, setPayNotes] = useState("");
  const [paySaving, setPaySaving] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return;
      setUserId(user.id);
      supabase.from("profiles").select("role").eq("id", user.id).single()
        .then(({ data }) => setRole(data?.role ?? "sales"));
    });
  }, []);

  useEffect(() => {
    if (!userId || !role) return;
    let q = supabase.from("installment_plans").select(`
      *, contracts(contract_no, contract_amount, party_a_name, lead_id, sales_id)
    `).order("due_date", { ascending: true });

    if (role === "sales") q = q.filter("contracts.sales_id", "eq", userId);

    q.then(({ data, error: err }) => {
      if (err) { setError(t("common.loadFailedRetry")); console.error(err); }
      else setInstallments(data as Installment[]);
      setLoading(false);
    });
  }, [userId, role]);

  // ─── Task 4: Overdue detection persistence ───
  useEffect(() => {
    if (!installments.length) return;
    const today = new Date().toISOString().slice(0, 10);
    const overdueIds = installments
      .filter(i => i.status === "pending" && i.due_date < today)
      .map(i => i.id);
    if (overdueIds.length === 0) return;
    supabase.from("installment_plans")
      .update({ status: "overdue" })
      .in("id", overdueIds)
      .then(({ error: err }) => {
        if (err) console.error("Overdue update failed:", err);
        else {
          // Notify about newly overdue installments
          const overdueInsts = installments.filter(i => overdueIds.includes(i.id));
          import("@/lib/notify").then(({ notify }) => {
            overdueInsts.forEach(inst => {
              const daysOverdue = Math.floor((Date.now() - new Date(inst.due_date).getTime()) / 86400000);
              notify({
                type: "payment_overdue",
                installment_id: inst.id,
                contract_id: inst.contract_id,
                amount: inst.amount,
                days_overdue: daysOverdue,
              });
            });
          });
          // Refresh local state
          setInstallments(prev => prev.map(i =>
            overdueIds.includes(i.id) ? { ...i, status: "overdue" } : i
          ));
        }
      });
  }, [installments.length]);

  async function openRecordDialog(inst: Installment) {
    setSelectedInst(inst);
    setPayAmount(String(inst.amount));
    setPayDate(new Date().toISOString().slice(0, 10));
    setPayNotes("");
    setRecordDialogOpen(true);
  }

  async function handleRecordPayment(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedInst) return;
    setPaySaving(true);

    const amount = parseFloat(payAmount);
    if (isNaN(amount) || amount <= 0) {
      toast.error(t("payment.validAmount"));
      setPaySaving(false);
      return;
    }

    const { data: payment, error: payErr } = await supabase.from("payments").insert({
      installment_id: selectedInst.id,
      contract_id: selectedInst.contract_id,
      amount,
      payment_date: payDate,
      notes: payNotes.trim() || null,
      confirmed: false,
    }).select().single();

    if (payErr) {
      console.error("Payment record failed:", payErr);
      toast.error(t("payment.recordFailed"));
      setPaySaving(false);
      return;
    }

    // Call the DB function to update installment status
    try {
      await supabase.rpc("update_installment_status", {
        p_installment_id: selectedInst.id,
        p_paid_amount: amount,
      });
    } catch {
      // Function might not exist, that's okay — the trigger handles it
      if (process.env.NODE_ENV !== "production") {
        console.debug("update_installment_status RPC not available, trigger should handle it");
      }
    }

    toast.success(t("payment.saved"));

    // Notify admins about payment received
    import("@/lib/notify").then(({ notify }) => {
      notify({
        type: "payment_received",
        payment_id: payment?.id,
        contract_id: selectedInst.contract_id,
        amount,
      });
    });

    setRecordDialogOpen(false);
    setPaySaving(false);

    // Refresh
    const { data } = await supabase.from("installment_plans").select(`
      *, contracts(contract_no, contract_amount, party_a_name, lead_id, sales_id)
    `).order("due_date", { ascending: true });
    if (data) setInstallments(data as Installment[]);
  }

  async function markOverdue() {
    const today = new Date().toISOString().slice(0, 10);
    const { error: err } = await supabase.from("installment_plans")
      .update({ status: "overdue" })
      .eq("status", "pending")
      .lt("due_date", today);

    if (err) {
      console.error("Mark overdue failed:", err);
      toast.error(t("payment.markOverdueFailed"));
    } else {
      toast.success(t("payment.overdueUpdated"));
      // Refresh
      const { data } = await supabase.from("installment_plans").select(`
        *, contracts(contract_no, contract_amount, party_a_name, lead_id, sales_id)
      `).order("due_date", { ascending: true });
      if (data) setInstallments(data as Installment[]);
    }
  }

  if (loading) return <div className="text-muted-foreground p-8">{t("common.loading")}</div>;
  if (error) return <ErrorState message={error} onRetry={() => window.location.reload()} />;

  const fmtAED = (v: number) => v >= 1_000_000 ? `AED ${(v/1_000_000).toFixed(1)}M` : `AED ${v.toLocaleString()}`;
  const totalPending = installments.filter(i => i.status === "pending").reduce((s, i) => s + i.amount, 0);
  const totalOverdue = installments.filter(i => i.status === "overdue").reduce((s, i) => s + i.amount, 0);
  const totalPaid = installments.filter(i => i.status === "paid").reduce((s, i) => s + i.paid_amount, 0);
  const today = new Date().toISOString().slice(0, 10);

  const statusIcon = (status: string) => {
    switch (status) {
      case "paid": return <CheckCircle className="w-4 h-4 text-emerald-400" />;
      case "overdue": return <AlertTriangle className="w-4 h-4 text-rose-400" />;
      case "pending": return <Clock className="w-4 h-4 text-amber-400" />;
      default: return <CreditCard className="w-4 h-4 text-muted-foreground" />;
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">{t("payment.title")}</h1>
        <Button size="sm" variant="outline" onClick={markOverdue}
          className="border-rose-500/30 text-rose-400 hover:bg-rose-500/10">
          <AlertTriangle className="w-3.5 h-3.5 mr-1" />{t("payment.markOverdue")}
        </Button>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <Card className="bg-copper-500/5 border-copper-500/20"><CardContent className="p-4"><p className="text-xs text-copper-400">{t("payment.pending")}</p><p className="text-xl font-bold">{fmtAED(totalPending)}</p></CardContent></Card>
        <Card className="bg-rose-500/5 border-rose-500/20"><CardContent className="p-4"><p className="text-xs text-rose-400">{t("payment.overdue")}</p><p className="text-xl font-bold">{fmtAED(totalOverdue)}</p></CardContent></Card>
        <Card className="bg-emerald-500/5 border-emerald-500/20"><CardContent className="p-4"><p className="text-xs text-emerald-400">{t("payment.collected")}</p><p className="text-xl font-bold">{fmtAED(totalPaid)}</p></CardContent></Card>
        <Card className="bg-copper-500/5 border-copper-500/20"><CardContent className="p-4"><p className="text-xs text-copper-400">{t("payment.installments")}</p><p className="text-xl font-bold">{installments.length}</p></CardContent></Card>
      </div>

      {/* Installment list */}
      <div className="space-y-2">
        {installments.length === 0 ? (
          <Card className="bg-card border-border"><CardContent className="p-8 text-center text-muted-foreground">{t("payment.noPayments")}</CardContent></Card>
        ) : installments.map(inst => {
          const isOverdue = inst.status === "pending" && inst.due_date < today;
          const displayStatus = isOverdue ? "overdue" : inst.status;
          return (
            <Card key={inst.id} className={cn("bg-card border-border hover:border-border transition-colors", isOverdue && "border-rose-500/30")}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between">
                  <div className="space-y-1 flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {statusIcon(displayStatus)}
                      <span className="font-medium text-foreground">{inst.contracts?.contract_no || "—"}</span>
                      <span className="text-[10px] text-muted-foreground">#{inst.seq}</span>
                      {displayStatus === "pending" && (
                        <span className="text-[10px] text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">{t("payment.pendingShort")}</span>
                      )}
                      {displayStatus === "overdue" && (
                        <span className="text-[10px] text-rose-400 bg-rose-500/10 px-1.5 py-0.5 rounded">{t("payment.overdueShort")}</span>
                      )}
                      {displayStatus === "paid" && (
                        <span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded">{t("payment.paidShort")}</span>
                      )}
                    </div>
                    <p className="text-sm text-foreground">{inst.contracts?.party_a_name || "—"}</p>
                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1"><DollarSign className="w-3 h-3" />{fmtAED(inst.amount)}</span>
                      <span className="flex items-center gap-1"><Calendar className="w-3 h-3" />{inst.due_date?.slice(0,10)}</span>
                      {inst.paid_amount > 0 && <span className="text-emerald-400">{t("payment.collected")}: {fmtAED(inst.paid_amount)}</span>}
                    </div>
                    {inst.description && <p className="text-[10px] text-gray-600">{inst.description}</p>}
                  </div>
                  {displayStatus !== "paid" && (
                    <Button size="sm" variant="outline"
                      onClick={() => openRecordDialog(inst)}
                      className="shrink-0 ml-2 border-copper-500/30 text-copper-400 hover:bg-copper-500/10 text-xs h-8">
                      <Plus className="w-3 h-3 mr-1" />{t("payment.recordPayment")}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Record Payment Dialog */}
      <Dialog open={recordDialogOpen} onOpenChange={setRecordDialogOpen}>
        <DialogContent className="sm:max-w-md bg-card border-border text-gray-100">
          <DialogHeader>
            <DialogTitle className="text-foreground text-lg">
              {t("payment.recordPaymentTitle")}
            </DialogTitle>
          </DialogHeader>
          {selectedInst && (
            <form onSubmit={handleRecordPayment} className="space-y-4 pt-2">
              <div className="text-sm text-muted-foreground">
                <p>{t("payment.contract")}: {selectedInst.contracts?.contract_no || "—"} #{selectedInst.seq}</p>
                <p>{t("payment.due")}: {selectedInst.due_date?.slice(0,10)}</p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-muted-foreground text-xs">{t("payment.amount")} *</Label>
                <Input
                  type="number" step="0.01" required
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                  className="bg-muted border-border text-foreground h-9"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-muted-foreground text-xs">{t("payment.paymentDate")} *</Label>
                <Input
                  type="date" required
                  value={payDate}
                  onChange={(e) => setPayDate(e.target.value)}
                  className="bg-muted border-border text-foreground h-9"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-muted-foreground text-xs">{t("payment.notes")}</Label>
                <Input
                  placeholder={t("payment.optional")}
                  value={payNotes}
                  onChange={(e) => setPayNotes(e.target.value)}
                  className="bg-muted border-border text-foreground h-9"
                />
              </div>
              <div className="flex items-center justify-end gap-2 pt-2">
                <DialogClose>
                  <Button type="button" variant="ghost" className="text-muted-foreground h-8">
                    {t("payment.cancel")}
                  </Button>
                </DialogClose>
                <Button type="submit" disabled={paySaving}
                  className="bg-copper-500 hover:bg-copper-600 text-black font-medium h-8 text-sm">
                  {paySaving ? t("payment.saving") : t("payment.confirmPayment")}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <Toaster position="top-center" richColors />
    </div>
  );
}
