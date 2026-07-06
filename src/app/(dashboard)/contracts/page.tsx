"use client";

import { useEffect, useState, useRef } from "react";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { useRequireRole } from "@/hooks/useRequireRole";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { FileText, DollarSign, Calendar, User, Clock, Briefcase, Plus, Bell, CheckCircle, AlertTriangle, Upload, Ban, CheckCircle2, XCircle, ChevronLeft, ChevronRight, Filter } from "lucide-react";
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";
import SubNavTabs from "@/components/SubNavTabs";
import Link from "next/link";
import { toast } from "sonner";
import { Toaster } from "sonner";
import { approveContract, revokeContract } from "@/app/actions/contracts";
import { fmtAED } from "@/shared/utils/format";

interface Contract {
  id: string; contract_no: string; contract_amount: number; status: string;
  party_a_name: string; contract_date: string; sales_id: string;
  lead_id: string; created_at: string;
  first_payment_status?: string; first_payment_due_date?: string;
  leads?: { customer_name: string | null } | null;
  profiles?: { full_name: string | null; email: string | null } | null;
  installment_plans?: { id: string; amount: number; due_date: string; status: string; paid_amount: number; seq: number }[] | null;
}

export default function ContractsPage() {
  const { loading: roleLoading, blocked } = useRequireRole(["admin", "boss"]);
  const { t, lang } = useLanguage();

  const STATUS_LABELS: Record<string, string> = {
    draft: t("contracts.statusDraft"),
    signed: t("contracts.statusSigned"),
    pending_admin: t("contracts.statusPendingAdmin"),
    pending_ceo: t("contracts.statusPendingCeo"),
    active: t("contracts.statusActive"),
    approved: t("contracts.statusApproved"),
    completed: t("contracts.statusCompleted"),
    terminated: t("contracts.statusTerminated"),
    expired: t("contracts.statusExpired"),
    rejected: t("contracts.statusRejected"),
    revoking: t("contracts.statusRevoking"),
    superseded: t("contracts.statusSuperseded"),
    suspended: t("contracts.statusSuspended"),
    cancelled: t("contracts.statusCancelled") || "Cancelled",
  };
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<string | null>(null);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadTargetId, setUploadTargetId] = useState<string | null>(null);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectNotes, setRejectNotes] = useState("");
  const [rejectContractId, setRejectContractId] = useState<string | null>(null);
  const [revokeDialogOpen, setRevokeDialogOpen] = useState(false);
  const [revokeReason, setRevokeReason] = useState("");
  const [revokeContractId, setRevokeContractId] = useState<string | null>(null);

  // Pagination + filtering state
  const [page, setPage] = useState(1);
  const [pageSize] = useState(10);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [totalCount, setTotalCount] = useState(0);

  const statusLabel = (s: string) => {
    return STATUS_LABELS[s] || s;
  };

  // First payment status helper
  const getFirstPaymentBadge = (c: Contract) => {
    const status = c.first_payment_status || "unpaid";
    const dueDate = c.first_payment_due_date;
    const today = new Date().toISOString().slice(0, 10);

    if (status === "paid") {
      return { color: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30", label: "✓ Paid", icon: <CheckCircle className="w-3 h-3" /> };
    }
    if (status === "partial") {
      return { color: "bg-amber-500/10 text-amber-400 border-amber-500/30", label: "⚠ Partial", icon: <AlertTriangle className="w-3 h-3" /> };
    }
    // unpaid
    if (dueDate && dueDate < today) {
      return { color: "bg-rose-500/10 text-rose-400 border-rose-500/30", label: "Overdue", icon: <AlertTriangle className="w-3 h-3" /> };
    }
    if (dueDate && dueDate <= new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)) {
      return { color: "bg-amber-500/10 text-amber-400 border-amber-500/30", label: "Due Soon", icon: <Clock className="w-3 h-3" /> };
    }
    return { color: "bg-muted text-muted-foreground border-border/30", label: "Unpaid", icon: <Clock className="w-3 h-3" /> };
  };

  async function sendReminder(contractId: string) {
    try {
      const res = await fetch(`/api/contracts/${contractId}/remind-payment`, {
        method: "POST",
      });
      if (res.ok) {
        toast.success(t("contracts.reminderSent"));
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || t("contracts.reminderFailed"));
      }
    } catch {
      toast.error(t("login.networkError"));
    }
  }

  // Approval / Reject action
  async function handleApproval(contractId: string, action: "approve" | "reject", notes?: string) {
    try {
      await approveContract(contractId, action, notes);
      toast.success(t("contracts.approvalSuccess"));
      window.location.reload();
    } catch (err: any) {
      toast.error(err.message || t("contracts.approvalFailed"));
    }
  }

  // Revoke action
  async function handleRevoke(contractId: string, reason: string) {
    try {
      await revokeContract(contractId, reason);
      toast.success(t("contracts.revokeSuccess"));
      window.location.reload();
    } catch (err: any) {
      toast.error(err.message || t("contracts.revokeFailed"));
    }
  }

  function openRejectDialog(contractId: string) {
    setRejectContractId(contractId);
    setRejectNotes("");
    setRejectDialogOpen(true);
  }

  function submitRejection() {
    if (!rejectContractId) return;
    const notes = rejectNotes.trim() || undefined;
    void handleApproval(rejectContractId, "reject", notes);
    setRejectDialogOpen(false);
  }

  function openRevokeDialog(contractId: string) {
    setRevokeContractId(contractId);
    setRevokeReason("");
    setRevokeDialogOpen(true);
  }

  function submitRevocation() {
    const reason = revokeReason.trim();
    if (!revokeContractId || !reason) return;
    void handleRevoke(revokeContractId, reason);
    setRevokeDialogOpen(false);
  }

  // Upload contract file
  function startUpload(contractId: string) {
    setUploadTargetId(contractId);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
      fileInputRef.current.click();
    }
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !uploadTargetId) return;
    const id = uploadTargetId;
    setUploadingId(id);
    setUploadProgress(0);
    try {
      // 1. Get presigned URL
      const urlRes = await fetch(`/api/contracts/${id}/upload-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name }),
      });
      if (!urlRes.ok) {
        const err = await urlRes.json().catch(() => ({}));
        toast.error(err.error || t("contracts.uploadFailed"));
        setUploadingId(null);
        return;
      }
      const { url, key } = await urlRes.json();

      // 2. Upload to COS with progress
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", url);
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) setUploadProgress(Math.round((ev.loaded / ev.total) * 100));
        };
        xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("Upload failed")));
        xhr.onerror = () => reject(new Error("Upload failed"));
        xhr.send(file);
      });

      // 3. Confirm upload
      const confirmRes = await fetch(`/api/contracts/${id}/confirm-upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, filename: file.name, size: file.size }),
      });
      if (confirmRes.ok) {
        toast.success(t("contracts.uploadSuccess"));
        window.location.reload();
      } else {
        const err = await confirmRes.json().catch(() => ({}));
        toast.error(err.error || t("contracts.uploadFailed"));
      }
    } catch {
      toast.error(t("contracts.uploadFailed"));
    } finally {
      setUploadingId(null);
      setUploadProgress(0);
      setUploadTargetId(null);
    }
  }

  // Check which approval buttons to show
  const canApproveReject = (c: Contract) => {
    if (c.status === "pending_admin" && (role === "admin" || role === "operator")) return true;
    if (c.status === "pending_ceo" && role === "boss") return true;
    return false;
  };

  const canUpload = (c: Contract) => {
    return ["draft", "pending_admin", "pending_ceo"].includes(c.status);
  };

  const canRevoke = (c: Contract) => {
    return (role === "admin" || role === "boss") && ["active", "approved"].includes(c.status);
  };

  // Fetch auth + contracts from BFF API
  useEffect(() => {
    (async () => {
      try {
        const params = new URLSearchParams();
        if (statusFilter !== "all") params.set("status", statusFilter);
        params.set("page", String(page));
        params.set("pageSize", String(pageSize));

        const res = await fetch(`/api/contracts/list?${params.toString()}`);
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          setError(err.error || t("common.loadFailedRetry"));
          setLoading(false);
          return;
        }
        const json = await res.json();
        setContracts((json.contracts ?? []) as Contract[]);
        setTotalCount(json.totalCount ?? 0);
        setRole(json.role);
      } catch (err) {
        console.error(err);
        setError(t("common.loadFailedRetry"));
      }
      setLoading(false);
    })();
  }, [page, statusFilter]);

  if (roleLoading || blocked) return null;

  if (loading) return <div className="text-muted-foreground p-8">{t("common.loading")}</div>;
  if (error) return <ErrorState message={error} onRetry={() => window.location.reload()} />;

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const totalActive = contracts.reduce((s, c) => ["signed","active","approved"].includes(c.status) ? s + c.contract_amount : s, 0);

  const STATUS_FILTER_OPTIONS = [
    { value: "all", label: t("common.all") || "All" },
    { value: "draft", label: STATUS_LABELS.draft },
    { value: "signed", label: STATUS_LABELS.signed },
    { value: "pending_admin", label: STATUS_LABELS.pending_admin },
    { value: "pending_ceo", label: STATUS_LABELS.pending_ceo },
    { value: "active", label: STATUS_LABELS.active },
    { value: "approved", label: STATUS_LABELS.approved },
    { value: "completed", label: STATUS_LABELS.completed },
    { value: "terminated", label: STATUS_LABELS.terminated },
    { value: "rejected", label: STATUS_LABELS.rejected },
    { value: "cancelled", label: STATUS_LABELS.cancelled },
  ];

  return (
    <DashboardScrollContainer className="space-y-0">
      <SubNavTabs
        items={[
          { href: "/contracts", labelKey: "contracts.subnavContracts", iconName: "file-text" },
          { href: "/projects", labelKey: "contracts.subnavProjects", iconName: "briefcase" },
        ]}
      />
      <div className="flex items-center justify-between mb-6 mt-5">
        <h1 className="text-2xl font-bold">{t("contracts.title")}</h1>
        <Link prefetch={false} href="/contracts/new" className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-600 text-foreground text-sm font-medium hover:bg-slate-700 transition-colors">
          <Plus className="w-4 h-4" />
          {t("contracts.newContract")}
        </Link>
      </div>

      {/* Status filter */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Filter className="w-4 h-4 text-muted-foreground" />
        {STATUS_FILTER_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => { setStatusFilter(opt.value); setPage(1); }}
            className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
              statusFilter === opt.value
                ? "bg-copper-500/20 border-copper-500/40 text-copper-400"
                : "border-border/40 text-muted-foreground hover:border-border hover:text-foreground"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Hidden file input for uploads */}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
        onChange={handleFileSelected}
      />

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <Card className="bg-copper-500/5 border-copper-500/20"><CardContent className="p-4"><p className="text-xs text-copper-400">{t("contracts.total")}</p><p className="text-xl font-bold">{totalCount}</p></CardContent></Card>
        <Card className="bg-copper-500/5 border-copper-500/20"><CardContent className="p-4"><p className="text-xs text-copper-400">{t("contracts.activeValue")}</p><p className="text-xl font-bold">{fmtAED(totalActive)}</p></CardContent></Card>
        <Card className="bg-copper-500/5 border-copper-500/20"><CardContent className="p-4"><p className="text-xs text-copper-400">{t("contracts.signed")}</p><p className="text-xl font-bold">{contracts.filter(c => c.status === "signed").length}</p></CardContent></Card>
        <Card className="bg-copper-500/5 border-copper-500/20"><CardContent className="p-4"><p className="text-xs text-copper-400">{t("contracts.active")}</p><p className="text-xl font-bold">{contracts.filter(c => c.status === "active").length}</p></CardContent></Card>
      </div>

      {/* Contract list */}
      <div className="space-y-2">
        {contracts.length === 0 ? (
          <Card className="bg-card border-border"><CardContent className="p-8 text-center text-muted-foreground">{t("contracts.noContracts")}</CardContent></Card>
        ) : contracts.map(c => {
          const fpBadge = getFirstPaymentBadge(c);
          const needsReminder = (c.first_payment_status || "unpaid") !== "paid";
          const showApproveReject = canApproveReject(c);
          const showUpload = canUpload(c);
          const showRevoke = canRevoke(c);
          const isUploading = uploadingId === c.id;
          return (
          <Card key={c.id} className="bg-card border-border hover:border-border transition-colors">
            <CardContent className="p-4">
              <div className="flex items-start justify-between">
                <div className="space-y-1 flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <FileText className="w-4 h-4 text-copper-400 shrink-0" />
                    <Link prefetch={false} href={`/contracts/${c.id}`} className="font-medium text-foreground hover:text-copper-400 transition-colors">
                      {c.contract_no}
                    </Link>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-copper-500/10 text-copper-400">{statusLabel(c.status)}</span>
                    {/* First payment badge */}
                    {c.first_payment_status && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${fpBadge.color} inline-flex items-center gap-1`}>
                        {fpBadge.icon}{fpBadge.label}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-foreground">{c.leads?.customer_name || c.party_a_name || "—"}</p>
                  <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
                    <span className="flex items-center gap-1"><DollarSign className="w-3 h-3" />{fmtAED(c.contract_amount)}</span>
                    <span className="flex items-center gap-1"><Calendar className="w-3 h-3" />{c.contract_date?.slice(0,10)}</span>
                    <span className="flex items-center gap-1"><User className="w-3 h-3" />{c.profiles?.full_name || c.profiles?.email || "—"}</span>
                    {c.first_payment_due_date && (
                      <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                        <Clock className="w-3 h-3" />1st due: {c.first_payment_due_date.slice(0,10)}
                      </span>
                    )}
                  </div>
                  {/* Installment summary */}
                  {c.installment_plans && c.installment_plans.length > 0 && (
                    <div className="flex gap-2 mt-1 flex-wrap">
                      {c.installment_plans.map(ip => (
                        <span key={ip.id} className="text-[10px] px-1.5 py-0.5 rounded border border-border/30 text-muted-foreground">
                          #{ip.seq || ""} {fmtAED(ip.amount)} → {ip.due_date?.slice(0,10)} {ip.status === "paid" ? "✓" : ip.status === "overdue" ? "⚠️" : ""}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {/* Action buttons */}
                <div className="flex items-center gap-1.5 shrink-0 ml-2 flex-wrap justify-end">
                  {/* Send Reminder button for unpaid/overdue first payments */}
                  {needsReminder && (
                    <Button
                      size="sm" variant="outline"
                      onClick={() => sendReminder(c.id)}
                      className="border-copper-500/30 text-copper-400 hover:bg-copper-500/10 text-xs h-8"
                    >
                      <Bell className="w-3 h-3 mr-1" />Remind
                    </Button>
                  )}
                  {/* Approve / Reject buttons */}
                  {showApproveReject && (
                    <>
                      <Button
                        size="sm" variant="outline"
                        onClick={() => handleApproval(c.id, "approve")}
                        className="border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 text-xs h-8"
                      >
                        <CheckCircle2 className="w-3 h-3 mr-1" />{t("contracts.approve")}
                      </Button>
                      <Button
                        size="sm" variant="outline"
                        onClick={() => openRejectDialog(c.id)}
                        className="border-rose-500/30 text-rose-400 hover:bg-rose-500/10 text-xs h-8"
                      >
                        <XCircle className="w-3 h-3 mr-1" />{t("contracts.reject")}
                      </Button>
                    </>
                  )}
                  {/* Upload Contract button */}
                  {showUpload && (
                    <Button
                      size="sm" variant="outline"
                      onClick={() => startUpload(c.id)}
                      disabled={isUploading}
                      className="border-blue-500/30 text-blue-400 hover:bg-blue-500/10 text-xs h-8"
                    >
                      {isUploading ? (
                        <>{t("contracts.uploading")} {uploadProgress}%</>
                      ) : (
                        <><Upload className="w-3 h-3 mr-1" />{t("contracts.uploadContract")}</>
                      )}
                    </Button>
                  )}
                  {/* Revoke button */}
                  {showRevoke && (
                    <Button
                      size="sm" variant="outline"
                      onClick={() => openRevokeDialog(c.id)}
                      className="border-orange-500/30 text-orange-400 hover:bg-orange-500/10 text-xs h-8"
                    >
                      <Ban className="w-3 h-3 mr-1" />{t("contracts.revoke")}
                    </Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
          );
        })}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4 px-1">
          <span className="text-xs text-muted-foreground">
            {t("common.page") || "Page"} {page} / {totalPages} ({totalCount} {t("contracts.total")})
          </span>
          <div className="flex items-center gap-2">
            <Button
              size="sm" variant="outline"
              disabled={page <= 1}
              onClick={() => setPage(p => Math.max(1, p - 1))}
              className="h-8 text-xs"
            >
              <ChevronLeft className="w-3.5 h-3.5 mr-1" />{t("common.prev") || "Prev"}
            </Button>
            <Button
              size="sm" variant="outline"
              disabled={page >= totalPages}
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              className="h-8 text-xs"
            >
              {t("common.next") || "Next"}<ChevronRight className="w-3.5 h-3.5 ml-1" />
            </Button>
          </div>
        </div>
      )}

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
            <Button type="button" variant="outline" onClick={() => setRejectDialogOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" variant="destructive" onClick={submitRejection}>
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
            <Button type="button" variant="outline" onClick={() => setRevokeDialogOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={!revokeReason.trim()}
              onClick={submitRevocation}
            >
              {t("contracts.revoke")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Toaster position="top-center" richColors />
    </DashboardScrollContainer>
  );
}
