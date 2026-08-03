"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import { useParams } from "next/navigation";
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";
import Link from "next/link";
import {
  ArrowLeft, FileText, DollarSign, Calendar, User, Clock, CheckCircle2,
  XCircle, Ban, Bell, AlertTriangle, CheckCircle, Download, ShieldCheck, Upload,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { useRequireRole } from "@/hooks/useRequireRole";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { toast } from "sonner";
import { Toaster } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { fmtAED } from "@/shared/utils/format";
import {
  createUploadAttempt,
  uploadContractFile,
} from "@/lib/client-request-integrity";
import type { UploadAttempt } from "@/lib/client-request-integrity";
import { hasNotificationWarning } from "@/lib/contract-approval-result";

/* ─── Types ─── */
interface DetailResponse {
  contract: ContractDetail;
  installments: Installment[];
  payments: Payment[];
  approvals: Approval[];
  canManage: boolean;
}

interface ContractDetail {
  contract_amount: number | null;
  contract_date: string | null;
  contract_no: string;
  currency: string | null;
  file_url: string | null;
  leads: { id: string; customer_name: string | null; source: string | null } | null;
  party_a_contact: string | null;
  party_a_name: string | null;
  party_b_contact: string | null;
  party_b_name: string | null;
  profiles: { full_name: string | null; email: string | null } | null;
  sealed_file_url: string | null;
  signed_at: string | null;
  status: string;
}

interface Installment {
  id: string;
  seq: number;
  amount: number;
  due_date: string;
  status: string;
  paid_amount: number;
  allocated_amount: number;
  description: string | null;
}

interface Payment {
  id: string;
  amount: number;
  payment_date: string;
  payment_method: string | null;
  reference_no: string | null;
  confirmed: boolean;
  confirmed_at: string | null;
  confirmed_by: string | null;
  installment_plan_id: string | null;
  created_at: string;
  confirmer_name?: string | null;
}

interface Approval {
  id: string;
  step: string;
  status: string;
  notes: unknown;
  reviewed_at: string | null;
  created_at: string;
  approver_name?: string | null;
}

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  bank_transfer: "Bank Transfer",
  cash: "Cash",
  cheque: "Cheque",
  card: "Card",
  other: "Other",
};

export default function ContractDetailPage() {
  const { loading: roleLoading, blocked } = useRequireRole([
    "admin", "boss", "sales", "finance", "operator",
  ]);
  const params = useParams();
  const { t } = useLanguage();

  const contractId = String(params?.id ?? "");

  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<string | null>(null);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectNotes, setRejectNotes] = useState("");
  const [revokeDialogOpen, setRevokeDialogOpen] = useState(false);
  const [revokeReason, setRevokeReason] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadAttemptRef = useRef<UploadAttempt | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/contracts/${contractId}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to load contract");
      }
      setData(await res.json());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [contractId, t]);

  useEffect(() => {
    if (!contractId) return;
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [contractId, load]);

  if (roleLoading || blocked) return null;

  if (loading) {
    return (
      <div className="text-muted-foreground p-8 text-sm">{t("common.loading")}</div>
    );
  }

  if (error || !data) {
    return (
      <ErrorState
        message={error || t("common.loadFailed")}
        onRetry={() => window.location.reload()}
      />
    );
  }

  const { contract, installments, payments, approvals, canManage } = data;
  const today = new Date().toISOString().slice(0, 10);

  const STATUS_LABELS: Record<string, string> = {
    draft: t("contracts.statusDraft"),
    signed: t("contracts.statusSigned"),
    pending_admin: t("contracts.statusPendingAdmin"),
    pending_ceo: t("contracts.statusPendingCeo"),
    active: t("contracts.statusActive"),
    approved: t("contracts.statusApproved"),
    completed: t("contracts.statusCompleted"),
    terminated: t("contracts.statusTerminated"),
    rejected: t("contracts.statusRejected"),
    revoking: t("contracts.statusRevoking"),
    superseded: t("contracts.statusSuperseded"),
    suspended: t("contracts.statusSuspended"),
    cancelled: t("contracts.statusCancelled") || "Cancelled",
  };
  const confirmStatusMessage = t("contracts.confirmStatusChange");

  /* ── Payment status roll-up ── */
  const totalContract = Number(contract.contract_amount ?? 0);
  const collected = installments.reduce((s, i) => s + Number(i.paid_amount ?? 0), 0);
  const outstanding = Math.max(0, totalContract - collected);
  const overdueAmt = installments.reduce((s, i) => {
    const isOverdue =
      i.status === "overdue" ||
      (i.status !== "paid" && i.due_date < today && Number(i.paid_amount ?? 0) < Number(i.amount));
    return isOverdue ? s + (Number(i.amount) - Number(i.paid_amount ?? 0)) : s;
  }, 0);
  const collectedPct = totalContract > 0 ? Math.round((collected / totalContract) * 100) : 0;

  /* ── Action helpers (reuse existing endpoints) ── */
  async function postAction(path: string, body: Record<string, unknown>, successMsg: string) {
    setActing(true);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const responseBody: unknown = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.success(successMsg);
        if (hasNotificationWarning(responseBody)) {
          toast.warning("Action saved; notification delivery failed.");
        }
        await load();
      } else {
        const errorCode = responseBody !== null
          && typeof responseBody === "object"
          && "error" in responseBody
          && typeof responseBody.error === "string"
          ? responseBody.error
          : t("common.operationFailed");
        toast.error(errorCode);
      }
    } catch {
      toast.error(t("login.networkError"));
    } finally {
      setActing(false);
    }
  }

  /* ── Upload contract file ── */
  function startUpload() {
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
      fileInputRef.current.click();
    }
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadProgress(0);
    try {
      uploadAttemptRef.current ??= createUploadAttempt();
      await uploadContractFile(
        contractId,
        file,
        uploadAttemptRef.current,
        setUploadProgress,
      );
      uploadAttemptRef.current = null;
      toast.success(t("contracts.uploadSuccess"));
      await load();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : t("contracts.uploadFailed"));
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  }

  /* ── Status change ── */
  function changeStatus(newStatus: string) {
    if (!canManage) return;
    setPendingStatus(newStatus);
    setConfirmDialogOpen(true);
  }

  async function confirmStatusChange() {
    if (!pendingStatus) return;
    const newStatus = pendingStatus;
    setConfirmDialogOpen(false);
    setActing(true);
    try {
      const res = await fetch(`/api/contracts/${contractId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (res.ok) {
        toast.success(t("contracts.statusUpdated") || "Status updated");
        await load();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || t("common.operationFailed"));
      }
    } catch {
      toast.error(t("login.networkError"));
    } finally {
      setActing(false);
      setPendingStatus(null);
    }
  }

  async function submitRejection() {
    setRejectDialogOpen(false);
    await postAction(
      `/api/contracts/${contractId}/approve`,
      { action: "reject", notes: rejectNotes || undefined },
      t("contracts.approvalSuccess"),
    );
    setRejectNotes("");
  }

  async function submitRevocation() {
    if (!revokeReason) return;
    setRevokeDialogOpen(false);
    await postAction(
      `/api/contracts/${contractId}/revoke`,
      { reason: revokeReason },
      t("contracts.revokeSuccess"),
    );
    setRevokeReason("");
  }

  const showApprove =
    canManage &&
    ((contract.status === "pending_admin" && true) ||
      contract.status === "pending_ceo");

  const showUploadButton =
    canManage && ["draft", "pending_admin", "pending_ceo"].includes(contract.status);

  const showStatusActions = canManage && contract.status !== "completed" && contract.status !== "terminated";

  return (
    <DashboardScrollContainer className="space-y-5 max-w-5xl">
      <Toaster position="top-center" richColors />

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
        onChange={handleFileSelected}
      />

      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="space-y-1">
          <button
            onClick={() => { window.location.href = "/contracts"; }}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            {t("contracts.title")}
          </button>
          <div className="flex items-center gap-2 flex-wrap">
            <FileText className="w-5 h-5 text-copper-400" />
            <h1 className="text-xl font-bold text-foreground">{contract.contract_no}</h1>
            <span className="text-[11px] px-2 py-0.5 rounded bg-copper-500/10 text-copper-400 border border-copper-500/20">
              {STATUS_LABELS[contract.status] || contract.status}
            </span>
          </div>
        </div>

        {/* Quick actions */}
        <div className="flex items-center gap-2 flex-wrap">
          {showApprove && (
            <>
              <Button
                size="sm" variant="outline" disabled={acting}
                onClick={() => postAction(`/api/contracts/${contractId}/approve`, { action: "approve" }, t("contracts.approvalSuccess"))}
                className="border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 h-8"
              >
                <CheckCircle2 className="w-3.5 h-3.5 mr-1" />{t("contracts.approve")}
              </Button>
              <Button
                size="sm" variant="outline" disabled={acting}
                onClick={() => {
                  setRejectNotes("");
                  setRejectDialogOpen(true);
                }}
                className="border-rose-500/30 text-rose-400 hover:bg-rose-500/10 h-8"
              >
                <XCircle className="w-3.5 h-3.5 mr-1" />{t("contracts.reject")}
              </Button>
            </>
          )}
          {showUploadButton && (
            <Button
              size="sm" variant="outline" disabled={uploading}
              onClick={startUpload}
              className="border-blue-500/30 text-blue-400 hover:bg-blue-500/10 h-8"
            >
              {uploading ? (
                <>{t("contracts.uploading")} {uploadProgress}%</>
              ) : (
                <><Upload className="w-3.5 h-3.5 mr-1" />{t("contracts.uploadContract")}</>
              )}
            </Button>
          )}
          <Button
            size="sm" variant="outline" disabled={acting}
            onClick={() => postAction(`/api/contracts/${contractId}/remind-payment`, {}, t("contracts.reminderSent"))}
            className="border-copper-500/30 text-copper-400 hover:bg-copper-500/10 h-8"
          >
            <Bell className="w-3.5 h-3.5 mr-1" />{t("contracts.remind")}
          </Button>
          {canManage && ["active", "approved"].includes(contract.status) && (
            <Button
              size="sm" variant="outline" disabled={acting}
              onClick={() => {
                setRevokeReason("");
                setRevokeDialogOpen(true);
              }}
              className="border-orange-500/30 text-orange-400 hover:bg-orange-500/10 h-8"
            >
              <Ban className="w-3.5 h-3.5 mr-1" />{t("contracts.revoke")}
            </Button>
          )}
        </div>
      </div>

      {/* ── KPI cards: payment status ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <DollarSign className="w-3 h-3" />{t("analytics.totalValue")}
            </p>
            <p className="text-xl font-bold text-foreground mt-1">{fmtAED(totalContract)}</p>
          </CardContent>
        </Card>
        <Card className="bg-emerald-500/5 border-emerald-500/20">
          <CardContent className="p-4">
            <p className="text-xs text-emerald-400 flex items-center gap-1">
              <CheckCircle className="w-3 h-3" />{t("analytics.collected")}
            </p>
            <p className="text-xl font-bold text-foreground mt-1">{fmtAED(collected)}</p>
          </CardContent>
        </Card>
        <Card className="bg-amber-500/5 border-amber-500/20">
          <CardContent className="p-4">
            <p className="text-xs text-amber-400 flex items-center gap-1">
              <Clock className="w-3 h-3" />{t("analytics.outstanding")}
            </p>
            <p className="text-xl font-bold text-foreground mt-1">{fmtAED(outstanding)}</p>
          </CardContent>
        </Card>
        <Card className={overdueAmt > 0 ? "bg-rose-500/5 border-rose-500/20" : "bg-card border-border"}>
          <CardContent className="p-4">
            <p className={`text-xs flex items-center gap-1 ${overdueAmt > 0 ? "text-rose-400" : "text-muted-foreground"}`}>
              <AlertTriangle className="w-3 h-3" />{t("analytics.overdueStatus")}
            </p>
            <p className="text-xl font-bold text-foreground mt-1">{fmtAED(overdueAmt)}</p>
          </CardContent>
        </Card>
      </div>

      {/* ── Collection progress ── */}
      <Card className="bg-card border-border">
        <CardContent className="p-4 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{t("analytics.collectionRate")}</span>
            <span className="font-semibold text-foreground">{collectedPct}%</span>
          </div>
          <div className="h-2.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all duration-500"
              style={{ width: `${collectedPct}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{fmtAED(collected)} {t("analytics.paid")}</span>
            <span>{fmtAED(totalContract)}</span>
          </div>
        </CardContent>
      </Card>

      {/* ── Contract info + parties ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card className="bg-card border-border">
          <CardContent className="p-4 space-y-2 text-sm">
            <div className="flex items-center gap-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">
              <ShieldCheck className="w-3.5 h-3.5" />{t("contracts.title")}
            </div>
            <InfoRow icon={<Calendar className="w-3.5 h-3.5" />} label={t("contracts.contractDate")} value={contract.contract_date?.slice(0, 10)} />
            <InfoRow icon={<User className="w-3.5 h-3.5" />} label={t("contracts.partyA")} value={contract.party_a_name} sub={contract.party_a_contact} />
            <InfoRow icon={<User className="w-3.5 h-3.5" />} label={t("contracts.partyB")} value={contract.party_b_name} sub={contract.party_b_contact} />
            <InfoRow icon={<DollarSign className="w-3.5 h-3.5" />} label={t("contracts.amount")} value={fmtAED(totalContract)} sub={contract.currency} />
            {contract.signed_at && (
              <InfoRow icon={<CheckCircle className="w-3.5 h-3.5" />} label={t("contracts.signedAt") || "Signed At"} value={contract.signed_at?.slice(0, 10)} />
            )}
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardContent className="p-4 space-y-2 text-sm">
            <div className="flex items-center gap-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">
              <User className="w-3.5 h-3.5" />{t("leadDetail.customer")}
            </div>
            {contract.leads ? (
              <>
                <InfoRow icon={<User className="w-3.5 h-3.5" />} label={t("leadDetail.customerName")} value={contract.leads.customer_name || "—"} />
                <InfoRow icon={<FileText className="w-3.5 h-3.5" />} label={t("leads.source")} value={contract.leads.source || "—"} />
                <Link prefetch={false} href={`/leads/${contract.leads.id}`} className="inline-flex items-center gap-1 text-xs text-copper-400 hover:underline mt-1">
                  {t("leadDetail.viewLead")} →
                </Link>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">—</p>
            )}
            <div className="border-t border-border/40 pt-2 mt-2">
              <InfoRow icon={<User className="w-3.5 h-3.5" />} label={t("contracts.sales")} value={contract.profiles?.full_name || contract.profiles?.email || "—"} />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Status change (admin/manager only) ── */}
      {showStatusActions && canManage && (
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-1 h-4 rounded-full bg-amber-400" />
              <h2 className="text-sm font-semibold text-foreground">{t("contracts.changeStatus") || "Change Status"}</h2>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {["draft", "signed", "pending_admin", "pending_ceo", "approved", "active", "completed", "terminated", "cancelled"].map((s) => (
                <Button
                  key={s}
                  size="sm" variant="outline"
                  disabled={acting || contract.status === s}
                  onClick={() => changeStatus(s)}
                  className={`text-xs h-7 ${
                    contract.status === s
                      ? "border-copper-500/50 text-copper-400 bg-copper-500/10"
                      : "border-border/40 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {STATUS_LABELS[s] || s}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Installment tracking ── */}
      <Card className="bg-card border-border">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-1 h-4 rounded-full bg-copper-400" />
            <h2 className="text-sm font-semibold text-foreground">{t("contracts.installments")}</h2>
            <span className="text-[11px] text-muted-foreground">({installments.length})</span>
          </div>

          {installments.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">{t("contracts.noInstallments")}</p>
          ) : (
            <div className="space-y-2">
              {installments.map((ip) => {
                const ipPct = ip.amount > 0 ? Math.min(100, Math.round((Number(ip.paid_amount) / Number(ip.amount)) * 100)) : 0;
                const isOverdue = ip.status !== "paid" && ip.due_date < today && Number(ip.paid_amount) < Number(ip.amount);
                const badge = installmentBadge(ip.status, isOverdue, t);
                return (
                  <div key={ip.id} className="rounded-lg border border-border/40 p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-copper-400">#{ip.seq}</span>
                        <span className="text-sm font-medium text-foreground">{fmtAED(Number(ip.amount))}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${badge.color} inline-flex items-center gap-1`}>
                          {badge.icon}{badge.label}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Calendar className="w-3 h-3" />{ip.due_date?.slice(0, 10)}
                        </span>
                        {Number(ip.paid_amount) > 0 && (
                          <span className="text-emerald-400">{fmtAED(Number(ip.paid_amount))} {t("analytics.paid")}</span>
                        )}
                      </div>
                    </div>
                    {/* Progress bar */}
                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full transition-all duration-500 ${isOverdue ? "bg-rose-500" : "bg-emerald-500"}`}
                        style={{ width: `${ipPct}%` }}
                      />
                    </div>
                    {ip.description && (
                      <p className="text-[11px] text-muted-foreground">{ip.description}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Payments + approvals ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-1 h-4 rounded-full bg-emerald-400" />
              <h2 className="text-sm font-semibold text-foreground">{t("contracts.payments")}</h2>
              <span className="text-[11px] text-muted-foreground">({payments.length})</span>
            </div>
            {payments.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">{t("contracts.noPayments")}</p>
            ) : (
              <div className="space-y-2">
                {payments.map((p) => (
                  <div key={p.id} className="flex items-center justify-between gap-2 rounded-lg border border-border/40 p-2.5">
                    <div className="space-y-0.5 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground">{fmtAED(Number(p.amount))}</span>
                        {p.confirmed ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 inline-flex items-center gap-1">
                            <CheckCircle className="w-2.5 h-2.5" />{t("analytics.paid")}
                          </span>
                        ) : (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 inline-flex items-center gap-1">
                            <Clock className="w-2.5 h-2.5" />{t("contracts.pendingConfirm")}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="flex items-center gap-1"><Calendar className="w-3 h-3" />{p.payment_date?.slice(0, 10)}</span>
                        {p.payment_method && <span>{PAYMENT_METHOD_LABEL[p.payment_method] || p.payment_method}</span>}
                        {p.reference_no && <span>· #{p.reference_no}</span>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-1 h-4 rounded-full bg-blue-400" />
              <h2 className="text-sm font-semibold text-foreground">{t("contracts.approvalHistory")}</h2>
            </div>
            {approvals.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">{t("contracts.noApprovals")}</p>
            ) : (
              <div className="space-y-2">
                {approvals.map((a) => {
                  const b = approvalBadge(a.status);
                  return (
                    <div key={a.id} className="flex items-center justify-between gap-2 rounded-lg border border-border/40 p-2.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${b.color}`}>{b.label}</span>
                        <span className="text-xs text-muted-foreground capitalize">{a.step.replace("_", " ")}</span>
                      </div>
                      <span className="text-[11px] text-muted-foreground shrink-0">
                        {a.reviewed_at ? a.reviewed_at.slice(0, 10) : a.created_at?.slice(0, 10)}
                        {a.approver_name ? ` · ${a.approver_name}` : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Contract file ── */}
      {(contract.file_url || contract.sealed_file_url) && (
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-1 h-4 rounded-full bg-purple-400" />
              <h2 className="text-sm font-semibold text-foreground">{t("contracts.contractFile")}</h2>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {contract.sealed_file_url && (
                <a href={contract.sealed_file_url} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 text-xs">
                  <ShieldCheck className="w-3.5 h-3.5" />{t("contracts.sealedFile")}
                </a>
              )}
              {contract.file_url && (
                <a href={contract.file_url} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-blue-500/30 text-blue-400 hover:bg-blue-500/10 text-xs">
                  <Download className="w-3.5 h-3.5" />{t("contracts.downloadFile")}
                </a>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={confirmDialogOpen} onOpenChange={setConfirmDialogOpen}>
        <DialogContent className="bg-card border-border">
          <DialogHeader>
            <DialogTitle>{t("common.confirm")}</DialogTitle>
            <DialogDescription>
              {confirmStatusMessage === "contracts.confirmStatusChange"
                ? `Change status to ${pendingStatus ? STATUS_LABELS[pendingStatus] || pendingStatus : ""}?`
                : confirmStatusMessage}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={acting} onClick={() => setConfirmDialogOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" disabled={acting || !pendingStatus} onClick={confirmStatusChange}>
              {t("common.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
        <DialogContent className="bg-card border-border">
          <DialogHeader>
            <DialogTitle>{t("contracts.rejectPrompt")}</DialogTitle>
          </DialogHeader>
          <Textarea
            value={rejectNotes}
            onChange={(event) => setRejectNotes(event.target.value)}
            placeholder={t("contracts.rejectPrompt")}
            aria-label={t("contracts.rejectPrompt")}
            rows={4}
          />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={acting} onClick={() => setRejectDialogOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" variant="destructive" disabled={acting} onClick={submitRejection}>
              {t("contracts.reject")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={revokeDialogOpen} onOpenChange={setRevokeDialogOpen}>
        <DialogContent className="bg-card border-border">
          <DialogHeader>
            <DialogTitle>{t("contracts.revokePrompt")}</DialogTitle>
          </DialogHeader>
          <Textarea
            value={revokeReason}
            onChange={(event) => setRevokeReason(event.target.value)}
            placeholder={t("contracts.revokePrompt")}
            aria-label={t("contracts.revokePrompt")}
            rows={4}
          />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={acting} onClick={() => setRevokeDialogOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" variant="destructive" disabled={acting || !revokeReason} onClick={submitRevocation}>
              {t("contracts.revoke")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardScrollContainer>
  );
}

/* ─── Small helpers ─── */
function InfoRow({ icon, label, value, sub }: {
  icon: React.ReactNode; label: string; value?: string | null; sub?: string | null;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {icon}{label}
      </span>
      <span className="text-foreground text-right truncate">
        {value || "—"}
        {sub ? <span className="block text-[10px] text-muted-foreground">{sub}</span> : null}
      </span>
    </div>
  );
}

function installmentBadge(status: string, isOverdue: boolean, t: (p: string) => string) {
  if (status === "paid") return { color: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30", label: t("analytics.paid"), icon: <CheckCircle className="w-2.5 h-2.5" /> };
  if (isOverdue || status === "overdue") return { color: "bg-rose-500/10 text-rose-400 border-rose-500/30", label: t("analytics.overdueStatus"), icon: <AlertTriangle className="w-2.5 h-2.5" /> };
  if (status === "partial") return { color: "bg-amber-500/10 text-amber-400 border-amber-500/30", label: t("contracts.partial"), icon: <Clock className="w-2.5 h-2.5" /> };
  return { color: "bg-muted text-muted-foreground border-border/30", label: t("analytics.pending"), icon: <Clock className="w-2.5 h-2.5" /> };
}

function approvalBadge(status: string) {
  if (status === "approved") return { color: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30", label: "Approved" };
  if (status === "rejected") return { color: "bg-rose-500/10 text-rose-400 border-rose-500/30", label: "Rejected" };
  return { color: "bg-amber-500/10 text-amber-400 border-amber-500/30", label: "Pending" };
}
