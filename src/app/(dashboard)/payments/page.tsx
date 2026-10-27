"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { useRequireRole } from "@/hooks/useRequireRole";
import {
  PAYMENT_PAGE_ROLES,
  PAYMENT_UI_METHODS,
  paymentAmountMinorUnits,
} from "@/lib/payment-idempotency.mjs";
import {
  allocatedTotal,
  allocationDraftStatus,
  filterPaymentsByState,
  hasAllocationData,
  isFullyAllocated,
  paymentAllowsAllocate,
  paymentAllowsConfirm,
  paymentAllowsVoid,
  paymentState,
  paymentTotals,
  unallocatedTotal,
} from "@/lib/payment-state.mjs";
import type {
  PaymentContractOption,
  PaymentListResponse,
  PaymentListRow,
  PaymentStateFilter,
} from "@/types/payments";
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";
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
  Ban,
} from "lucide-react";
import { toast } from "sonner";
import { Toaster } from "sonner";
import { Textarea } from "@/components/ui/textarea";
import { confirmPayment, allocatePayment as allocatePaymentAction } from "@/app/actions/payments";
import { fmtAED } from "@/shared/utils/format";

// ─── Types ───────────────────────────────────────────────────────────
//
// Round-4 B8: the row and contract shapes used to be declared here as a second
// opinion about what GET /api/payments/list returns, and they were wrong — a
// non-optional `allocated_amount` no payments row carries, `confirmed: boolean`
// for a nullable column, and no void fields at all. The route returned a wildcard
// select, so voided_at/voided_by/void_reason were on the wire and this declaration
// is where they were lost. They now come from src/types/payments.ts, which the
// route's response is typed against, so the page can only read fields the route
// actually promises — and cannot fail to see the ones it does.

interface InstallmentPlan {
  id: string;
  contract_id: string;
  seq: number;
  amount: number;
  due_date: string;
  status: string;
  // What allocate_payment() and void_payment() recompute. `paid_amount` is the
  // legacy single-installment field, written only by the pre-allocation trigger in
  // 20260605000000 for payments that carry installment_plan_id, so displaying it
  // beside an allocation dialog would show a figure this dialog never moves.
  allocated_amount: number;
  paid_amount: number | null;
  description: string | null;
}

// ─── Page Component ──────────────────────────────────────────────────

/**
 * The roles confirm_payment() and allocate_payment() accept.
 *
 * A named constant so tests/security/money-grant-coupling.test.mjs can hold it
 * against the routines' own role lists instead of against a second copy of them.
 */
const SETTLEMENT_ROLES = ["admin", "boss", "finance"];

export default function PaymentsPage() {
  const { loading: roleLoading, blocked } = useRequireRole([...PAYMENT_PAGE_ROLES]);
  const supabase = createClient();
  const { t } = useLanguage();

  // Core state
  const [payments, setPayments] = useState<PaymentListRow[]>([]);
  const [contracts, setContracts] = useState<PaymentContractOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  // Tab filter. Four values, not three: a voided payment used to fall into
  // `pending`, where it was counted as money awaiting confirmation and offered a
  // Confirm button that confirm_payment() refuses with 22023.
  const [activeTab, setActiveTab] = useState<PaymentStateFilter>("all");

  // Record Payment dialog state
  const [recordDialogOpen, setRecordDialogOpen] = useState(false);
  const [recContractId, setRecContractId] = useState("");
  const [recAmount, setRecAmount] = useState("");
  const [recDate, setRecDate] = useState(new Date().toISOString().slice(0, 10));
  const [recMethod, setRecMethod] = useState("bank_transfer");
  const [recRefNo, setRecRefNo] = useState("");
  const [recNotes, setRecNotes] = useState("");
  const [recSaving, setRecSaving] = useState(false);
  // The idempotency key for the payment being recorded. Minted once per intent,
  // when the dialog opens — see openRecordDialog().
  const [recRequestKey, setRecRequestKey] = useState("");

  // Confirm action state
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  // Allocate dialog state
  const [allocateDialogOpen, setAllocateDialogOpen] = useState(false);
  const [allocatePayment, setAllocatePayment] = useState<PaymentListRow | null>(null);
  const [installmentPlans, setInstallmentPlans] = useState<InstallmentPlan[]>([]);
  const [allocAmounts, setAllocAmounts] = useState<Record<string, number>>({});
  const [allocSaving, setAllocSaving] = useState(false);

  // Void dialog state. void_payment() requires a reason and POST
  // /api/payments/[id]/void answers a blank one with 400, so the reason is part of
  // the dialog rather than something the operator discovers by being refused.
  const [voidDialogOpen, setVoidDialogOpen] = useState(false);
  const [voidTarget, setVoidTarget] = useState<PaymentListRow | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [voidSaving, setVoidSaving] = useState(false);

  // ─── Auth & Data Loading ─────────────────────────────────────────

  const fetchData = useCallback(async () => {
    try {
      // `no-store` on the request as well as on the response: every write below
      // ends with this call, and a money list served from a cache is the same
      // defect as a stale one computed from missing fields.
      const res = await fetch("/api/payments/list", { cache: "no-store" });
      if (!res.ok) throw new Error(t("payments.fetchFailed"));
      const json = (await res.json()) as PaymentListResponse;
      setPayments(json.payments ?? []);
      setContracts(json.contracts ?? []);
      setRole(json.role);
      setUserId(json.userId);
    } catch (err) {
      console.error(t("payments.fetchFailed"), err);
      setError(t("payments.fetchFailed"));
    }
  }, [t]);

  useEffect(() => {
    fetchData().finally(() => setLoading(false));
  }, [fetchData]);

  if (roleLoading || blocked) return null;

  // ─── Helpers ─────────────────────────────────────────────────────

  // Two different rules, and conflating them was round-3 finding P1-9.
  //
  // The page role list is the RECORDING and VISIBILITY rule. `canSettle` is the MONEY
  // rule: confirming a payment and allocating it to installments is admin, boss or
  // finance only. That is what src/app/actions/payments.ts enforces and what
  // confirm_payment() / allocate_payment() enforce since
  // supabase/migrations/20260814000000_l0_round3_authorization_and_integrity.sql.
  // The buttons used to be gated on the broader recording rule, so an operator was offered a
  // Confirm button the action rejected — and, before the migration narrowed the
  // routine's role list, an operator calling the RPC directly succeeded.
  const canSettle = role != null && SETTLEMENT_ROLES.includes(role);

  const methodLabel = (m: string) => {
    const map: Record<string, string> = {
      bank_transfer: t("payments.methodBankTransfer"),
      cash: t("payments.methodCash"),
      cheque: t("payments.methodCheck"),
      card: "Card",
      other: "Other",
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

  // One call, because every one of these figures has to use the predicate the
  // database uses. The reviewed page summed every row into Total Recorded and every
  // unconfirmed row into Total Pending, so a voided payment was counted as cash
  // twice; and it summed a field the route never sent, so Total Allocated was
  // always AED 0.00. See src/lib/payment-state.mjs.
  const totals = paymentTotals(payments);

  // ─── Filtered Payments ───────────────────────────────────────────

  const filteredPayments = filterPaymentsByState(payments, activeTab);

  // ─── Allocation Draft ────────────────────────────────────────────

  // The whole intended allocation for the open dialog, capped where the routine
  // caps it. Derived rather than stored, so the total, the warning and the submit
  // button cannot disagree about the same numbers.
  const allocateDraft = allocatePayment
    ? allocationDraftStatus({ amount: allocatePayment.amount, draft: allocAmounts })
    : null;

  // ─── Record Payment ─────────────────────────────────────────────

  function openRecordDialog() {
    setRecContractId(contracts[0]?.id || "");
    setRecAmount("");
    setRecDate(new Date().toISOString().slice(0, 10));
    setRecMethod("bank_transfer");
    setRecRefNo("");
    setRecNotes("");
    // One key per intent, minted here rather than per submit. A key minted inside
    // handleRecordPayment would be new on every attempt, so a double-clicked
    // button or a retried request would record two payments — which is the whole
    // defect. Opening the dialog again is a new intent and gets a new key.
    setRecRequestKey(crypto.randomUUID());
    setRecordDialogOpen(true);
  }

  async function handleRecordPayment(e: React.FormEvent) {
    e.preventDefault();
    setRecSaving(true);

    const amountMinor = paymentAmountMinorUnits(recAmount);
    if (amountMinor === null) {
      toast.error(t("payments.validAmount"));
      setRecSaving(false);
      return;
    }

    try {
      // POST /api/payments is the canonical recording boundary: it is where the
      // idempotency key becomes payments.request_key. The server action this
      // replaced inserted directly, with no key at all.
      const res = await fetch("/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contract_id: recContractId,
          amount: amountMinor / 100,
          payment_date: recDate,
          payment_method: recMethod,
          reference_no: recRefNo || null,
          notes: recNotes || null,
          idempotencyKey: recRequestKey,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || t("payments.recordFailed"));
        return;
      }

      toast.success(t("payments.saved"));
      setRecordDialogOpen(false);
      await fetchData();
    } catch {
      toast.error(t("login.networkError"));
    } finally {
      setRecSaving(false);
    }
  }

  // ─── Confirm Payment ────────────────────────────────────────────

  async function handleConfirm(paymentId: string) {
    setConfirmingId(paymentId);
    try {
      await confirmPayment(paymentId);
      toast.success(t("payments.confirmed"));
      await fetchData();
    } catch (err: any) {
      toast.error(err.message || t("payments.confirmFailed"));
    } finally {
      setConfirmingId(null);
    }
  }

  // ─── Allocate Payment ───────────────────────────────────────────

  async function openAllocateDialog(payment: PaymentListRow) {
    setAllocatePayment(payment);
    setAllocAmounts({});
    setAllocSaving(false);

    const { data, error: err } = await supabase
      .from("installment_plans")
      .select("id, contract_id, seq, amount, due_date, status, allocated_amount, paid_amount, description")
      .eq("contract_id", payment.contract_id)
      .order("seq", { ascending: true });

    if (err) {
      console.error(t("payments.loadInstallmentsFailed"), err);
      toast.error(t("payments.loadInstallmentsFailed"));
      return;
    }

    setInstallmentPlans(data ?? []);
    // Opening on the existing allocation is the correction, not a convenience:
    // allocate_payment() DELETEs every existing allocation for the payment before
    // inserting the submitted set, so a submission replaces the whole allocation.
    // The reviewed dialog opened empty and called that "allocate", which meant
    // allocating to installment 2 silently released installment 1 — and it showed
    // "Previously allocated" beside a total compared against the payment amount, as
    // though the two summed. The breakdown comes from the list route, which already
    // reads payment_allocations to compute the sum shown on the row.
    setAllocAmounts({ ...payment.allocations });
    setAllocateDialogOpen(true);
  }

  async function handleAllocate(e: React.FormEvent) {
    e.preventDefault();
    if (!allocatePayment) return;
    setAllocSaving(true);

    const draft = allocationDraftStatus({ amount: allocatePayment.amount, draft: allocAmounts });
    const allocations = Object.entries(allocAmounts)
      .filter(([, amount]) => amount > 0)
      .map(([plan_id, amount]) => ({ plan_id, amount }));

    if (draft.empty) {
      toast.error(t("payments.allocationRequired"));
      setAllocSaving(false);
      return;
    }
    // allocate_payment() refuses this with 22023. Refusing it here as well keeps a
    // submittable form from being the way an operator finds out.
    if (draft.exceeds) {
      toast.error(t("payments.allocationExceeds"));
      setAllocSaving(false);
      return;
    }

    try {
      await allocatePaymentAction(allocatePayment.id, allocations);

      toast.success(t("payments.allocatedSuccessfully"));
      setAllocateDialogOpen(false);
      await fetchData();
    } catch (err: any) {
      toast.error(err.message || t("payments.allocationFailed"));
    } finally {
      setAllocSaving(false);
    }
  }

  // ─── Void Payment ───────────────────────────────────────────────
  //
  // void_payment() existed, POST /api/payments/[id]/void existed, and the page had
  // no way to reach either — so the only reversal available through the UI was the
  // DELETE that round 3 revoked from every role. That is the other half of B8: a
  // voided payment displayed as pending, and no way to void one.

  function openVoidDialog(payment: PaymentListRow) {
    setVoidTarget(payment);
    setVoidReason("");
    setVoidSaving(false);
    setVoidDialogOpen(true);
  }

  async function handleVoid(e: React.FormEvent) {
    e.preventDefault();
    if (!voidTarget) return;

    // The route answers a blank reason with 400 and void_payment() records the
    // reason on the row, so it is required here rather than discovered by refusal.
    const reason = voidReason.trim();
    if (!reason) {
      toast.error(t("payments.voidReasonRequired"));
      return;
    }

    setVoidSaving(true);
    try {
      const res = await fetch(`/api/payments/${voidTarget.id}/void`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || t("payments.voidFailed"));
        return;
      }

      toast.success(t("payments.voided"));
      setVoidDialogOpen(false);
      await fetchData();
    } catch {
      toast.error(t("login.networkError"));
    } finally {
      setVoidSaving(false);
    }
  }

  // ─── Render ─────────────────────────────────────────────────────

  if (loading) return <div className="text-muted-foreground p-8">{t("common.loading")}</div>;
  if (error) return <ErrorState message={error} onRetry={() => window.location.reload()} />;

  return (
    // T3-1: payments 根容器 = <DashboardScrollContainer>
    // → 走外层 viewport 滚动模式（与 leads/[id] 一致）。
    // sticky 元素 (page-title z-20) 直接锚定到 viewport 顶部。
    // payments 没有批量选择功能 → 无 bulk-bar；filter 是 Tabs 标签栏内嵌，
    // 不在 sticky 三件套范围内。
    <DashboardScrollContainer>
      {/* T2-4: page-title sticky: 标题 + Record Payment 按钮
          滚到底也能看到自己在 payments 页面，并可随时触发 Record Payment。 */}
      <div
        data-sticky-region="page-title"
        className="sticky top-0 z-20 bg-background/95 backdrop-blur-sm border-b -mx-4 px-4 py-2 mb-6"
      >
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">{t("payments.title")}</h1>
          <Button
            size="sm"
            onClick={openRecordDialog}
            className="bg-copper-500 hover:bg-copper-600 text-black font-medium"
          >
            <Plus className="w-3.5 h-3.5 mr-1" />
            {t("payments.recordPayment")}
          </Button>
        </div>
      </div>

      {/* KPI Cards — every figure from `totals`, i.e. from the database's own
          predicate. Voided money is reported as its own sub-line rather than
          folded into the recorded total, which is where it was counted twice. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <Card className="bg-copper-500/5 border-copper-500/20">
          <CardContent className="p-4">
            <p className="text-xs text-copper-400">{t("payments.totalRecorded")}</p>
            <p className="text-xl font-bold">{fmtAED(totals.recorded)}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {totals.counts.all - totals.counts.voided} {t("payments.paymentCount")}
              {totals.counts.voided > 0 && (
                <span className="text-rose-400 ml-1">
                  · {fmtAED(totals.voided)} {t("payments.totalVoided")}
                </span>
              )}
            </p>
          </CardContent>
        </Card>
        <Card className="bg-emerald-500/5 border-emerald-500/20">
          <CardContent className="p-4">
            <p className="text-xs text-emerald-400">{t("payments.totalConfirmed")}</p>
            <p className="text-xl font-bold">{fmtAED(totals.confirmed)}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {totals.counts.confirmed} {t("payments.paymentCount")}
            </p>
          </CardContent>
        </Card>
        <Card className="bg-amber-500/5 border-amber-500/20">
          <CardContent className="p-4">
            <p className="text-xs text-amber-400">{t("payments.totalPending")}</p>
            <p className="text-xl font-bold">{fmtAED(totals.pending)}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {totals.counts.pending} {t("payments.paymentCount")}
            </p>
          </CardContent>
        </Card>
        <Card className="bg-blue-500/5 border-blue-500/20">
          <CardContent className="p-4">
            <p className="text-xs text-blue-400">{t("payments.totalAllocated")}</p>
            <p className="text-xl font-bold">{fmtAED(totals.allocated)}</p>
            {/* An incomplete aggregate is named, not averaged into a percentage.
                The reviewed page reported AED 0.00 with total confidence because
                the route never sent the field at all. */}
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {totals.allocationDataMissing > 0 ? (
                <span className="text-amber-400">{t("payments.allocationUnknown")}</span>
              ) : totals.confirmed > 0 ? (
                `${Math.round((totals.allocated / totals.confirmed) * 100)}% ${t("payments.ofConfirmed")}`
              ) : (
                "—"
              )}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Status Filter Tabs */}
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as PaymentStateFilter)}
      >
        <TabsList className="mb-4">
          <TabsTrigger value="all">
            {t("payments.all")} ({totals.counts.all})
          </TabsTrigger>
          <TabsTrigger value="pending">
            <Clock className="w-3 h-3 mr-1" />
            {t("payments.pending")} ({totals.counts.pending})
          </TabsTrigger>
          <TabsTrigger value="confirmed">
            <CheckCircle className="w-3 h-3 mr-1" />
            {t("payments.confirmedStatus")} ({totals.counts.confirmed})
          </TabsTrigger>
          {/* The fourth tab is the finding: a voided payment used to land in
              `pending`, counted as money awaiting confirmation. */}
          <TabsTrigger value="voided">
            <Ban className="w-3 h-3 mr-1" />
            {t("payments.voidedStatus")} ({totals.counts.voided})
          </TabsTrigger>
        </TabsList>

        <TabsContent value={activeTab}>
          {/* Payment Cards List */}
          <div className="space-y-2">
            {filteredPayments.length === 0 ? (
              <Card className="bg-card border-border">
                <CardContent className="p-8 text-center text-muted-foreground">
                  {t("payments.noPayments")}
                </CardContent>
              </Card>
            ) : (
              filteredPayments.map((payment) => {
                const cNo = contractMap.get(payment.contract_id) || "—";
                // Three states from the shared model, not `confirmed ? … : …`.
                // void_payment() also sets confirmed = false, so the two-state
                // rule rendered every reversed payment as pending cash.
                const state = paymentState(payment);
                const unallocated = unallocatedTotal(payment);

                return (
                  <Card
                    key={payment.id}
                    className={cn(
                      "bg-card border-border hover:border-border transition-colors",
                      state === "pending" && "border-amber-500/20",
                      state === "voided" && "border-rose-500/20 opacity-70"
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
                            {state === "voided" && (
                              <Badge className="bg-rose-500/10 text-rose-400 border border-rose-500/30 text-[10px] px-1.5 py-0">
                                <Ban className="w-3 h-3 mr-0.5" />
                                {t("payments.voidedStatus")}
                              </Badge>
                            )}
                            {state === "confirmed" && (
                              <Badge className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 text-[10px] px-1.5 py-0">
                                <CheckCircle className="w-3 h-3 mr-0.5" />
                                {t("payments.confirmedStatus")}
                              </Badge>
                            )}
                            {state === "pending" && (
                              <Badge className="bg-amber-500/10 text-amber-400 border border-amber-500/30 text-[10px] px-1.5 py-0">
                                <Clock className="w-3 h-3 mr-0.5" />
                                {t("payments.pending")}
                              </Badge>
                            )}
                          </div>

                          {/* Payment Details Row */}
                          <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
                            <span
                              className={cn(
                                "flex items-center gap-1",
                                state === "voided" && "line-through"
                              )}
                            >
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

                          {/* Allocation, for the payments that have any: a voided
                              payment's allocations were deleted by the routine, and
                              a pending one has nothing to allocate. */}
                          {state === "confirmed" && (
                            <div className="text-xs text-muted-foreground">
                              {hasAllocationData(payment) ? (
                                <>
                                  <span className="text-blue-400">
                                    {t("payments.allocated")}: {fmtAED(allocatedTotal(payment))}
                                  </span>
                                  {unallocated != null && unallocated > 0 && (
                                    <span className="text-amber-400 ml-2">
                                      {t("payments.unallocated")}: {fmtAED(unallocated)}
                                    </span>
                                  )}
                                  {isFullyAllocated(payment) && (
                                    <span className="text-emerald-400 ml-2">
                                      {t("payments.fullyAllocated")}
                                    </span>
                                  )}
                                </>
                              ) : (
                                <span className="text-amber-400">
                                  {t("payments.allocationUnknown")}
                                </span>
                              )}
                            </div>
                          )}

                          {/* Why it was reversed, and when. void_payment() records
                              both; the reviewed page displayed neither. */}
                          {state === "voided" && (
                            <div className="text-xs text-rose-400">
                              {t("payments.voidedOn")}: {payment.voided_at?.slice(0, 10)}
                              {payment.void_reason && (
                                <span className="text-muted-foreground ml-2">
                                  — {payment.void_reason}
                                </span>
                              )}
                            </div>
                          )}

                          {/* Notes */}
                          {payment.notes && (
                            <p className="text-[10px] text-gray-500">{payment.notes}</p>
                          )}
                        </div>

                        {/* Action Buttons.
                            Two rules, kept apart: `canSettle` is the role rule
                            (SETTLEMENT_ROLES, coupled to the routines by
                            tests/security/money-grant-coupling.test.mjs) and
                            paymentAllows* is the row rule (each mirrors one
                            routine's own guards, in src/lib/payment-state.mjs).
                            An offered button is therefore an action the database
                            will accept — the reviewed page offered Confirm on a
                            voided payment, which confirm_payment() answers with
                            22023. */}
                        <div className="flex items-center gap-2 shrink-0 ml-2">
                          {canSettle && paymentAllowsConfirm(payment) && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleConfirm(payment.id)}
                              disabled={confirmingId === payment.id}
                              className="border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 text-xs h-8"
                            >
                              <CheckCircle className="w-3 h-3 mr-1" />
                              {confirmingId === payment.id ? "..." : t("payments.confirm")}
                            </Button>
                          )}
                          {canSettle && paymentAllowsAllocate(payment) && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => openAllocateDialog(payment)}
                              className="border-blue-500/30 text-blue-400 hover:bg-blue-500/10 text-xs h-8"
                            >
                              <ArrowRightLeft className="w-3 h-3 mr-1" />
                              {t("payments.allocate")}
                            </Button>
                          )}
                          {canSettle && paymentAllowsVoid(payment) && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => openVoidDialog(payment)}
                              className="border-rose-500/30 text-rose-400 hover:bg-rose-500/10 text-xs h-8"
                            >
                              <Ban className="w-3 h-3 mr-1" />
                              {t("payments.voidPayment")}
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
              {t("payments.recordPaymentTitle")}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleRecordPayment} className="space-y-4 pt-2">
            {/* Contract selector */}
            <div className="space-y-1.5">
              <Label className="text-muted-foreground text-xs">
                {t("payments.contract")} *
              </Label>
              <Select value={recContractId} onValueChange={(v: string | null) => v && setRecContractId(v)}>
                <SelectTrigger className="w-full bg-muted border-border text-foreground h-9">
                  <SelectValue placeholder={t("payments.selectContract")} />
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
                {t("payments.amount")} *
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
                {t("payments.paymentDate")} *
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
                {t("payments.paymentMethod")} *
              </Label>
              <Select value={recMethod} onValueChange={(v: string | null) => v && setRecMethod(v)}>
                <SelectTrigger className="w-full bg-muted border-border text-foreground h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_UI_METHODS.map((method) => (
                    <SelectItem key={method} value={method}>
                      {methodLabel(method)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Reference No */}
            <div className="space-y-1.5">
              <Label className="text-muted-foreground text-xs">
                {t("payments.referenceNo")} ({t("payments.optional")})
              </Label>
              <Input
                placeholder={t("payments.referencePlaceholder")}
                value={recRefNo}
                onChange={(e) => setRecRefNo(e.target.value)}
                className="bg-muted border-border text-foreground h-9"
              />
            </div>

            {/* Notes */}
            <div className="space-y-1.5">
              <Label className="text-muted-foreground text-xs">
                {t("payments.notes")} ({t("payments.optional")})
              </Label>
              <Textarea
                placeholder={t("payments.optional")}
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
                  {t("payments.cancel")}
                </Button>
              </DialogClose>
              <Button
                type="submit"
                disabled={recSaving || !recContractId}
                className="bg-copper-500 hover:bg-copper-600 text-black font-medium h-8 text-sm"
              >
                {recSaving ? t("payments.saving") : t("payments.confirmPayment")}
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
              {t("payments.allocatePayment")} — {allocatePayment ? fmtAED(allocatePayment.amount) : ""}
            </DialogTitle>
          </DialogHeader>
          {allocatePayment && allocateDraft && (
            <form onSubmit={handleAllocate} className="space-y-4 pt-2">
              {/* Summary. "Previously allocated" is gone: it was displayed beside a
                  running total that was compared against the payment amount, as
                  though the existing allocation and the new one summed. They do
                  not — allocate_payment() replaces. The existing allocation is
                  now prefilled into the inputs below, where it is what the
                  operator is editing. */}
              <div className="text-sm text-muted-foreground bg-muted/50 rounded-lg p-3">
                <p>
                  {t("payments.contract")}: <span className="text-foreground font-medium">{contractMap.get(allocatePayment.contract_id) || "—"}</span>
                </p>
                <p>
                  {t("payments.paymentAmount")}: <span className="text-foreground font-medium">{fmtAED(allocatePayment.amount)}</span>
                </p>
                <p className="text-xs text-amber-400 mt-1">{t("payments.allocationReplaces")}</p>
              </div>

              {/* Installment Plans */}
              {installmentPlans.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  {t("payments.noInstallmentPlans")}
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
                            {t("payments.installment")} #{plan.seq}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            {t("payments.due")}: {plan.due_date?.slice(0, 10)}
                          </span>
                        </div>
                        {/* allocated_amount, not paid_amount: allocate_payment()
                            and void_payment() recompute the former from
                            payment_allocations, while paid_amount is only written
                            by the pre-allocation trigger in 20260605000000 — so
                            the reviewed dialog showed a "Paid" figure that nothing
                            it did could move. */}
                        <p className="text-xs text-muted-foreground">
                          {t("payments.amount")}: {fmtAED(plan.amount)} | {t("payments.allocated")}: {fmtAED(plan.allocated_amount)} | {t("payments.status")}: {plan.status}
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
                <span className="text-muted-foreground">{t("payments.allocating")}:</span>
                <span
                  className={cn("font-bold", allocateDraft.exceeds ? "text-rose-400" : "text-foreground")}
                >
                  {fmtAED(allocateDraft.total)}
                  <span className="text-muted-foreground font-normal ml-2">
                    {t("payments.of")} {fmtAED(allocatePayment.amount)}
                  </span>
                </span>
              </div>
              {allocateDraft.exceeds ? (
                <div className="flex items-center gap-1 text-xs text-rose-400">
                  <AlertTriangle className="w-3 h-3" />
                  {t("payments.allocationExceeds")}
                </div>
              ) : (
                allocateDraft.remaining > 0 && (
                  <div className="text-xs text-amber-400">
                    {t("payments.remainingToAllocate")}: {fmtAED(allocateDraft.remaining)}
                  </div>
                )
              )}

              {/* Actions */}
              <div className="flex items-center justify-end gap-2 pt-2">
                <DialogClose>
                  <Button type="button" variant="ghost" className="text-muted-foreground h-8">
                    {t("payments.cancel")}
                  </Button>
                </DialogClose>
                <Button
                  type="submit"
                  disabled={allocSaving || !allocateDraft.submittable}
                  className="bg-blue-600 hover:bg-blue-700 text-white font-medium h-8 text-sm"
                >
                  {allocSaving ? t("payments.saving") : t("payments.allocate")}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* ─── Void Payment Dialog ────────────────────────────────── */}
      {/* 同 Record Payment Dialog 注释：modal 大类 = z-40 (内部已 z-50) */}
      <Dialog open={voidDialogOpen} onOpenChange={setVoidDialogOpen}>
        <DialogContent className="sm:max-w-md bg-card border-border text-gray-100">
          <DialogHeader>
            <DialogTitle className="text-foreground text-lg">
              {t("payments.voidPaymentTitle")} — {voidTarget ? fmtAED(voidTarget.amount) : ""}
            </DialogTitle>
          </DialogHeader>
          {voidTarget && (
            <form onSubmit={handleVoid} className="space-y-4 pt-2">
              <div className="text-sm text-muted-foreground bg-muted/50 rounded-lg p-3">
                <p>
                  {t("payments.contract")}:{" "}
                  <span className="text-foreground font-medium">
                    {contractMap.get(voidTarget.contract_id) || "—"}
                  </span>
                </p>
                <p>
                  {t("payments.paymentDate")}:{" "}
                  <span className="text-foreground font-medium">
                    {voidTarget.payment_date?.slice(0, 10)}
                  </span>
                </p>
              </div>

              {/* What void_payment() actually does, said before it is done: it
                  deletes this payment's allocations and recomputes
                  installment_plans.allocated_amount, projects.paid_amount,
                  kpi_targets.actual_amount and contracts.first_payment_status. */}
              <div className="flex items-start gap-2 text-xs text-amber-400 bg-amber-500/5 border border-amber-500/20 rounded-lg p-3">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>{t("payments.voidWarning")}</span>
              </div>

              <div className="space-y-1.5">
                <Label className="text-muted-foreground text-xs">
                  {t("payments.voidReason")} *
                </Label>
                <Textarea
                  required
                  value={voidReason}
                  onChange={(e) => setVoidReason(e.target.value)}
                  placeholder={t("payments.voidReasonPlaceholder")}
                  className="bg-muted border-border text-foreground min-h-16"
                  rows={2}
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <DialogClose>
                  <Button type="button" variant="ghost" className="text-muted-foreground h-8">
                    {t("payments.cancel")}
                  </Button>
                </DialogClose>
                <Button
                  type="submit"
                  disabled={voidSaving || voidReason.trim().length === 0}
                  className="bg-rose-600 hover:bg-rose-700 text-white font-medium h-8 text-sm"
                >
                  {voidSaving ? t("payments.saving") : t("payments.voidConfirm")}
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
    </DashboardScrollContainer>
  );
}
