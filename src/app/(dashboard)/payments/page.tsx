"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { useRequireRole } from "@/hooks/useRequireRole";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ErrorState } from "@/components/ui/error-state";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import {
  CreditCard,
  DollarSign,
  Calendar,
  CheckCircle,
  Clock,
  Plus,
  AlertTriangle,
  FileText,
  ArrowRightLeft,
  Hash,
} from "lucide-react";
import { toast } from "sonner";
import { Toaster } from "sonner";
import { Textarea } from "@/components/ui/textarea";

// ─── Types ───────────────────────────────────────────────────────────

interface Contract {
  id: string;
  contract_no: string;
  contract_amount: number;
  status: string;
  party_a_name: string;
  sales_id: string;
}

interface Payment {
  id: string;
  contract_id: string;
  amount: number;
  payment_date: string;
  payment_method: string;
  reference_no: string | null;
  notes: string | null;
  confirmed: boolean;
  confirmed_by: string | null;
  confirmed_at: string | null;
  created_by: string;
  created_at: string;
  allocated_amount: number;
  contracts?: { contract_no: string; party_a_name: string } | null;
}

interface InstallmentPlan {
  id: string;
  contract_id: string;
  seq: number;
  amount: number;
  due_date: string;
  status: string;
  paid_amount: number;
  description: string | null;
}

// ─── Page Component ──────────────────────────────────────────────────

export default function PaymentsPage() {
  const { loading: roleLoading, blocked } = useRequireRole(["admin", "boss", "finance", "operator"]);
  const supabase = createClient();
  const { t } = useLanguage();

  // Core state
  const [payments, setPayments] = useState<Payment[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  // Tab filter
  const [activeTab, setActiveTab] = useState<"all" | "pending" | "confirmed">("all");

  // Record Payment dialog state
  const [recordDialogOpen, setRecordDialogOpen] = useState(false);
  const [recContractId, setRecContractId] = useState("");
  const [recAmount, setRecAmount] = useState("");
  const [recDate, setRecDate] = useState(new Date().toISOString().slice(0, 10));
  const [recMethod, setRecMethod] = useState("bank_transfer");
  const [recRefNo, setRecRefNo] = useState("");
  const [recNotes, setRecNotes] = useState("");
  const [recSaving, setRecSaving] = useState(false);

  // Confirm action state
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  // Allocate dialog state
  const [allocateDialogOpen, setAllocateDialogOpen] = useState(false);
  const [allocatePayment, setAllocatePayment] = useState<Payment | null>(null);
  const [installmentPlans, setInstallmentPlans] = useState<InstallmentPlan[]>([]);
  const [allocAmounts, setAllocAmounts] = useState<Record<string, number>>({});
  const [allocSaving, setAllocSaving] = useState(false);

  // ─── Auth & Data Loading ─────────────────────────────────────────

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return;
      setUserId(user.id);
      supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single()
        .then(({ data }) => setRole(data?.role ?? "sales"));
    });
  }, []);

  const fetchPayments = useCallback(async () => {
    try {
      const res = await fetch("/api/payments");
      if (!res.ok) throw new Error("Failed to fetch payments");
      const json = await res.json();
      setPayments(json.data || []);
    } catch (err) {
      console.error("Fetch payments failed:", err);
      setError(t("common.loadFailedRetry"));
    }
  }, [t]);

  const fetchContracts = useCallback(async () => {
    let q = supabase
      .from("contracts")
      .select("id, contract_no, contract_amount, status, party_a_name, sales_id")
      .in("status", ["signed", "active"])
      .order("contract_no", { ascending: true });

    if (role === "sales") q = q.eq("sales_id", userId!);

    const { data, error: err } = await q;
    if (err) console.error("Fetch contracts failed:", err);
    else setContracts((data as Contract[]) || []);
  }, [supabase, role, userId]);

  useEffect(() => {
    if (!userId || !role) return;
    Promise.all([fetchPayments(), fetchContracts()]).finally(() => setLoading(false));
  }, [userId, role, fetchPayments, fetchContracts]);

  if (roleLoading || blocked) return null;

  // ─── Helpers ─────────────────────────────────────────────────────

  const isPrivileged = role && ["admin", "boss", "finance", "operator"].includes(role);

  const fmtAED = (v: number) =>
    v >= 1_000_000
      ? `AED ${(v / 1_000_000).toFixed(1)}M`
      : `AED ${v.toLocaleString()}`;

  const methodLabel = (m: string) => {
    const map: Record<string, string> = {
      bank_transfer: "Bank Transfer",
      cash: "Cash",
      check: "Check",
      online: "Online",
    };
    return map[m] || m;
  };

  // Build a contract_no lookup map from the payments themselves
  // (API returns contract_id but the join data may not be present)
  const contractMap = new Map<string, string>();
  contracts.forEach((c) => contractMap.set(c.id, c.contract_no));
  // Also enrich from payments if they carry nested contract info
  payments.forEach((p) => {
    if (p.contracts?.contract_no) contractMap.set(p.contract_id, p.contracts.contract_no);
  });

  // ─── KPI Computed ────────────────────────────────────────────────

  const totalRecorded = payments.reduce((s, p) => s + p.amount, 0);
  const totalConfirmed = payments.filter((p) => p.confirmed).reduce((s, p) => s + p.amount, 0);
  const totalPending = payments.filter((p) => !p.confirmed).reduce((s, p) => s + p.amount, 0);
  const totalAllocated = payments
    .filter((p) => p.confirmed)
    .reduce((s, p) => s + (p.allocated_amount || 0), 0);

  // ─── Filtered Payments ───────────────────────────────────────────

  const filteredPayments = payments.filter((p) => {
    if (activeTab === "pending") return !p.confirmed;
    if (activeTab === "confirmed") return p.confirmed;
    return true;
  });

  // ─── Record Payment ─────────────────────────────────────────────

  function openRecordDialog() {
    setRecContractId(contracts[0]?.id || "");
    setRecAmount("");
    setRecDate(new Date().toISOString().slice(0, 10));
    setRecMethod("bank_transfer");
    setRecRefNo("");
    setRecNotes("");
    setRecordDialogOpen(true);
  }

  async function handleRecordPayment(e: React.FormEvent) {
    e.preventDefault();
    setRecSaving(true);

    const amount = parseFloat(recAmount);
    if (isNaN(amount) || amount <= 0) {
      toast.error(t("payment.validAmount"));
      setRecSaving(false);
      return;
    }

    try {
      const res = await fetch("/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contract_id: recContractId,
          amount,
          payment_date: recDate,
          payment_method: recMethod,
          reference_no: recRefNo || null,
          notes: recNotes || null,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || t("payment.recordFailed"));
        setRecSaving(false);
        return;
      }

      toast.success(t("payment.saved"));
      setRecordDialogOpen(false);
      await fetchPayments();
    } catch {
      toast.error(t("payment.recordFailed"));
    } finally {
      setRecSaving(false);
    }
  }

  // ─── Confirm Payment ────────────────────────────────────────────

  async function handleConfirm(paymentId: string) {
    setConfirmingId(paymentId);
    try {
      const res = await fetch(`/api/payments/${paymentId}/confirm`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to confirm");
        return;
      }
      toast.success("Payment confirmed");
      await fetchPayments();
    } catch {
      toast.error("Failed to confirm payment");
    } finally {
      setConfirmingId(null);
    }
  }

  // ─── Allocate Payment ───────────────────────────────────────────

  async function openAllocateDialog(payment: Payment) {
    setAllocatePayment(payment);
    setAllocAmounts({});
    setAllocSaving(false);

    // Fetch installment plans for this contract
    const { data, error: err } = await supabase
      .from("installment_plans")
      .select("*")
      .eq("contract_id", payment.contract_id)
      .order("seq", { ascending: true });

    if (err) {
      console.error("Fetch installment plans failed:", err);
      toast.error("Failed to load installment plans");
      return;
    }

    setInstallmentPlans((data as InstallmentPlan[]) || []);
    setAllocateDialogOpen(true);
  }

  function getAllocatedTotal() {
    return Object.values(allocAmounts).reduce((s, v) => s + (v || 0), 0);
  }

  async function handleAllocate(e: React.FormEvent) {
    e.preventDefault();
    if (!allocatePayment) return;
    setAllocSaving(true);

    const allocations = Object.entries(allocAmounts)
      .filter(([, amount]) => amount > 0)
      .map(([plan_id, amount]) => ({ plan_id, amount }));

    if (allocations.length === 0) {
      toast.error("Please allocate to at least one installment");
      setAllocSaving(false);
      return;
    }

    try {
      const res = await fetch(`/api/payments/${allocatePayment.id}/allocate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allocations }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Allocation failed");
        setAllocSaving(false);
        return;
      }

      toast.success("Payment allocated successfully");
      setAllocateDialogOpen(false);
      await fetchPayments();
    } catch {
      toast.error("Allocation failed");
    } finally {
      setAllocSaving(false);
    }
  }

  // ─── Render ─────────────────────────────────────────────────────

  if (loading) return <div className="text-muted-foreground p-8">{t("common.loading")}</div>;
  if (error) return <ErrorState message={error} onRetry={() => window.location.reload()} />;

  return (
    // T2-4: payments 根容器 = 普通 <div>，没有用 DashboardScrollContainer
    // → 走外层 viewport 滚动模式（与 leads/[id] 一致）。
    // sticky 元素 (page-title z-20) 直接锚定到 viewport 顶部。
    // payments 没有批量选择功能 → 无 bulk-bar；filter 是 Tabs 标签栏内嵌，
    // 不在 sticky 三件套范围内。
    <div>
      {/* T2-4: page-title sticky: 标题 + Record Payment 按钮
          滚到底也能看到自己在 payments 页面，并可随时触发 Record Payment。 */}
      <div
        data-sticky-region="page-title"
        className="sticky top-0 z-20 bg-background/95 backdrop-blur-sm border-b -mx-4 px-4 py-2 mb-6"
      >
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">{t("payment.title")}</h1>
          <Button
            size="sm"
            onClick={openRecordDialog}
            className="bg-copper-500 hover:bg-copper-600 text-black font-medium"
          >
            <Plus className="w-3.5 h-3.5 mr-1" />
            {t("payment.recordPayment")}
          </Button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <Card className="bg-copper-500/5 border-copper-500/20">
          <CardContent className="p-4">
            <p className="text-xs text-copper-400">Total Recorded</p>
            <p className="text-xl font-bold">{fmtAED(totalRecorded)}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">{payments.length} payments</p>
          </CardContent>
        </Card>
        <Card className="bg-emerald-500/5 border-emerald-500/20">
          <CardContent className="p-4">
            <p className="text-xs text-emerald-400">Total Confirmed</p>
            <p className="text-xl font-bold">{fmtAED(totalConfirmed)}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {payments.filter((p) => p.confirmed).length} payments
            </p>
          </CardContent>
        </Card>
        <Card className="bg-amber-500/5 border-amber-500/20">
          <CardContent className="p-4">
            <p className="text-xs text-amber-400">Total Pending</p>
            <p className="text-xl font-bold">{fmtAED(totalPending)}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {payments.filter((p) => !p.confirmed).length} payments
            </p>
          </CardContent>
        </Card>
        <Card className="bg-blue-500/5 border-blue-500/20">
          <CardContent className="p-4">
            <p className="text-xs text-blue-400">Total Allocated</p>
            <p className="text-xl font-bold">{fmtAED(totalAllocated)}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {totalConfirmed > 0
                ? `${Math.round((totalAllocated / totalConfirmed) * 100)}% of confirmed`
                : "—"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Status Filter Tabs */}
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as "all" | "pending" | "confirmed")}
      >
        <TabsList className="mb-4">
          <TabsTrigger value="all">
            All ({payments.length})
          </TabsTrigger>
          <TabsTrigger value="pending">
            <Clock className="w-3 h-3 mr-1" />
            Pending ({payments.filter((p) => !p.confirmed).length})
          </TabsTrigger>
          <TabsTrigger value="confirmed">
            <CheckCircle className="w-3 h-3 mr-1" />
            Confirmed ({payments.filter((p) => p.confirmed).length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value={activeTab}>
          {/* Payment Cards List */}
          <div className="space-y-2">
            {filteredPayments.length === 0 ? (
              <Card className="bg-card border-border">
                <CardContent className="p-8 text-center text-muted-foreground">
                  {t("payment.noPayments")}
                </CardContent>
              </Card>
            ) : (
              filteredPayments.map((payment) => {
                const cNo = contractMap.get(payment.contract_id) || "—";
                const remaining =
                  payment.confirmed && payment.allocated_amount != null
                    ? payment.amount - payment.allocated_amount
                    : null;

                return (
                  <Card
                    key={payment.id}
                    className={cn(
                      "bg-card border-border hover:border-border transition-colors",
                      !payment.confirmed && "border-amber-500/20"
                    )}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between">
                        <div className="space-y-1 flex-1 min-w-0">
                          {/* Contract & Status Row */}
                          <div className="flex items-center gap-2 flex-wrap">
                            <CreditCard className="w-4 h-4 text-copper-400 shrink-0" />
                            <span className="font-medium text-foreground">
                              {cNo}
                            </span>
                            {payment.confirmed ? (
                              <Badge className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 text-[10px] px-1.5 py-0">
                                <CheckCircle className="w-3 h-3 mr-0.5" />
                                Confirmed
                              </Badge>
                            ) : (
                              <Badge className="bg-amber-500/10 text-amber-400 border border-amber-500/30 text-[10px] px-1.5 py-0">
                                <Clock className="w-3 h-3 mr-0.5" />
                                Pending
                              </Badge>
                            )}
                          </div>

                          {/* Payment Details Row */}
                          <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
                            <span className="flex items-center gap-1">
                              <DollarSign className="w-3 h-3" />
                              {fmtAED(payment.amount)}
                            </span>
                            <span className="flex items-center gap-1">
                              <Calendar className="w-3 h-3" />
                              {payment.payment_date?.slice(0, 10)}
                            </span>
                            <span className="flex items-center gap-1">
                              <FileText className="w-3 h-3" />
                              {methodLabel(payment.payment_method)}
                            </span>
                            {payment.reference_no && (
                              <span className="flex items-center gap-1">
                                <Hash className="w-3 h-3" />
                                {payment.reference_no}
                              </span>
                            )}
                          </div>

                          {/* Allocation info for confirmed payments */}
                          {payment.confirmed && payment.allocated_amount != null && (
                            <div className="text-xs text-muted-foreground">
                              <span className="text-blue-400">
                                Allocated: {fmtAED(payment.allocated_amount)}
                              </span>
                              {remaining != null && remaining > 0 && (
                                <span className="text-amber-400 ml-2">
                                  Unallocated: {fmtAED(remaining)}
                                </span>
                              )}
                              {remaining === 0 && (
                                <span className="text-emerald-400 ml-2">Fully allocated</span>
                              )}
                            </div>
                          )}

                          {/* Notes */}
                          {payment.notes && (
                            <p className="text-[10px] text-gray-500">{payment.notes}</p>
                          )}
                        </div>

                        {/* Action Buttons */}
                        <div className="flex items-center gap-2 shrink-0 ml-2">
                          {!payment.confirmed && isPrivileged && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleConfirm(payment.id)}
                              disabled={confirmingId === payment.id}
                              className="border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 text-xs h-8"
                            >
                              <CheckCircle className="w-3 h-3 mr-1" />
                              {confirmingId === payment.id ? "..." : "Confirm"}
                            </Button>
                          )}
                          {payment.confirmed && isPrivileged && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => openAllocateDialog(payment)}
                              className="border-blue-500/30 text-blue-400 hover:bg-blue-500/10 text-xs h-8"
                            >
                              <ArrowRightLeft className="w-3 h-3 mr-1" />
                              Allocate
                            </Button>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })
            )}
          </div>
        </TabsContent>
      </Tabs>

      {/* T2-4: dialog 层级约定 — z-modal z-40
          Dialog 内部已固定 z-50 (overlay + popup)，本处约定为「modal 大类 = z-40」便于
          与 page-title (z-20) 协调 — dialog 永远盖在 page-title 上。 */}
      {/* ─── Record Payment Dialog ──────────────────────────────── */}
      <Dialog open={recordDialogOpen} onOpenChange={setRecordDialogOpen}>
        <DialogContent className="sm:max-w-md bg-card border-border text-gray-100">
          <DialogHeader>
            <DialogTitle className="text-foreground text-lg">
              {t("payment.recordPaymentTitle")}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleRecordPayment} className="space-y-4 pt-2">
            {/* Contract selector */}
            <div className="space-y-1.5">
              <Label className="text-muted-foreground text-xs">
                {t("payment.contract")} *
              </Label>
              <Select value={recContractId} onValueChange={(v: string | null) => v && setRecContractId(v)}>
                <SelectTrigger className="w-full bg-muted border-border text-foreground h-9">
                  <SelectValue placeholder="Select contract" />
                </SelectTrigger>
                <SelectContent>
                  {contracts.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.contract_no} — {fmtAED(c.contract_amount)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Amount */}
            <div className="space-y-1.5">
              <Label className="text-muted-foreground text-xs">
                {t("payment.amount")} *
              </Label>
              <Input
                type="number"
                step="0.01"
                required
                value={recAmount}
                onChange={(e) => setRecAmount(e.target.value)}
                placeholder="0.00"
                className="bg-muted border-border text-foreground h-9"
              />
            </div>

            {/* Payment Date */}
            <div className="space-y-1.5">
              <Label className="text-muted-foreground text-xs">
                {t("payment.paymentDate")} *
              </Label>
              <Input
                type="date"
                required
                value={recDate}
                onChange={(e) => setRecDate(e.target.value)}
                className="bg-muted border-border text-foreground h-9"
              />
            </div>

            {/* Payment Method */}
            <div className="space-y-1.5">
              <Label className="text-muted-foreground text-xs">
                Payment Method *
              </Label>
              <Select value={recMethod} onValueChange={(v: string | null) => v && setRecMethod(v)}>
                <SelectTrigger className="w-full bg-muted border-border text-foreground h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="check">Check</SelectItem>
                  <SelectItem value="online">Online</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Reference No */}
            <div className="space-y-1.5">
              <Label className="text-muted-foreground text-xs">
                Reference No ({t("payment.optional")})
              </Label>
              <Input
                placeholder="e.g. TXN-12345"
                value={recRefNo}
                onChange={(e) => setRecRefNo(e.target.value)}
                className="bg-muted border-border text-foreground h-9"
              />
            </div>

            {/* Notes */}
            <div className="space-y-1.5">
              <Label className="text-muted-foreground text-xs">
                {t("payment.notes")} ({t("payment.optional")})
              </Label>
              <Textarea
                placeholder={t("payment.optional")}
                value={recNotes}
                onChange={(e) => setRecNotes(e.target.value)}
                className="bg-muted border-border text-foreground min-h-16"
                rows={2}
              />
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-2 pt-2">
              <DialogClose>
                <Button type="button" variant="ghost" className="text-muted-foreground h-8">
                  {t("payment.cancel")}
                </Button>
              </DialogClose>
              <Button
                type="submit"
                disabled={recSaving || !recContractId}
                className="bg-copper-500 hover:bg-copper-600 text-black font-medium h-8 text-sm"
              >
                {recSaving ? t("payment.saving") : t("payment.confirmPayment")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* ─── Allocate Payment Dialog ────────────────────────────── */}
      {/* 同 Record Payment Dialog 注释：modal 大类 = z-40 (内部已 z-50) */}
      <Dialog open={allocateDialogOpen} onOpenChange={setAllocateDialogOpen}>
        <DialogContent className="sm:max-w-lg bg-card border-border text-gray-100">
          <DialogHeader>
            <DialogTitle className="text-foreground text-lg">
              Allocate Payment — {allocatePayment ? fmtAED(allocatePayment.amount) : ""}
            </DialogTitle>
          </DialogHeader>
          {allocatePayment && (
            <form onSubmit={handleAllocate} className="space-y-4 pt-2">
              {/* Summary */}
              <div className="text-sm text-muted-foreground bg-muted/50 rounded-lg p-3">
                <p>
                  Contract: <span className="text-foreground font-medium">{contractMap.get(allocatePayment.contract_id) || "—"}</span>
                </p>
                <p>
                  Payment amount: <span className="text-foreground font-medium">{fmtAED(allocatePayment.amount)}</span>
                </p>
                <p>
                  Previously allocated: <span className="text-foreground font-medium">{fmtAED(allocatePayment.allocated_amount || 0)}</span>
                </p>
              </div>

              {/* Installment Plans */}
              {installmentPlans.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  No installment plans found for this contract.
                </p>
              ) : (
                <div className="space-y-3 max-h-64 overflow-y-auto">
                  {installmentPlans.map((plan) => (
                    <div
                      key={plan.id}
                      className="flex items-center gap-3 bg-muted/30 rounded-lg p-3"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground">
                            Installment #{plan.seq}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            Due: {plan.due_date?.slice(0, 10)}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Amount: {fmtAED(plan.amount)} | Paid: {fmtAED(plan.paid_amount)} | Status: {plan.status}
                        </p>
                        {plan.description && (
                          <p className="text-[10px] text-gray-500 mt-0.5">{plan.description}</p>
                        )}
                      </div>
                      <div className="w-28 shrink-0">
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          placeholder="0.00"
                          value={allocAmounts[plan.id] ?? ""}
                          onChange={(e) =>
                            setAllocAmounts((prev) => ({
                              ...prev,
                              [plan.id]: parseFloat(e.target.value) || 0,
                            }))
                          }
                          className="bg-muted border-border text-foreground h-8 text-sm"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Remaining indicator */}
              <div className="flex items-center justify-between text-sm border-t border-border pt-3">
                <span className="text-muted-foreground">Allocating:</span>
                <span
                  className={cn(
                    "font-bold",
                    getAllocatedTotal() > allocatePayment.amount
                      ? "text-rose-400"
                      : "text-foreground"
                  )}
                >
                  {fmtAED(getAllocatedTotal())}
                  <span className="text-muted-foreground font-normal ml-2">
                    of {fmtAED(allocatePayment.amount)}
                  </span>
                </span>
              </div>
              {getAllocatedTotal() > allocatePayment.amount && (
                <div className="flex items-center gap-1 text-xs text-rose-400">
                  <AlertTriangle className="w-3 h-3" />
                  Total allocation exceeds payment amount
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center justify-end gap-2 pt-2">
                <DialogClose>
                  <Button type="button" variant="ghost" className="text-muted-foreground h-8">
                    {t("payment.cancel")}
                  </Button>
                </DialogClose>
                <Button
                  type="submit"
                  disabled={allocSaving || getAllocatedTotal() <= 0}
                  className="bg-blue-600 hover:bg-blue-700 text-white font-medium h-8 text-sm"
                >
                  {allocSaving ? t("payment.saving") : "Allocate"}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* T2-4: toast 层级约定 — z-toast z-50
          sonner Toaster 已固定高 z-index (默认 999999)，作为最高优先级反馈层，
          覆盖 page-title / modal / dropdown。 */}
      <Toaster position="top-center" richColors />
    </div>
  );
}
