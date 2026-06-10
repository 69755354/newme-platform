"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { Button } from "@/components/ui/button";
import { FileText, DollarSign, Calendar, User, Clock, Briefcase, Plus, Bell, CheckCircle, AlertTriangle } from "lucide-react";
import SubNavTabs from "@/components/SubNavTabs";
import Link from "next/link";
import { toast } from "sonner";
import { Toaster } from "sonner";

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
  const supabase = createClient();
  const { t, lang } = useLanguage();

  const STATUS_LABELS: Record<string, string> = {
    draft: t("contracts.statusDraft"), signed: t("contracts.statusSigned"), active: t("contracts.statusActive"),
    completed: t("contracts.statusCompleted"), terminated: t("contracts.statusTerminated"), expired: t("contracts.statusExpired"),
  };
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  const statusLabel = (s: string) => {
    const map: Record<string, string> = {
      draft: t("contracts.statusDraft"),
      signed: t("contracts.statusSigned"),
      active: t("contracts.statusActive"),
      completed: t("contracts.statusCompleted"),
      terminated: t("contracts.statusTerminated"),
      expired: t("contracts.statusExpired"),
    };
    return map[s] || s;
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
    let q = supabase.from("contracts").select(`
      *, leads(customer_name), profiles!contracts_sales_id_fkey(full_name, email),
      installment_plans(id, amount, due_date, status, paid_amount, seq)
    `).order("created_at", { ascending: false });

    if (role === "sales") q = q.eq("sales_id", userId);

    q.then(({ data, error: err }) => {
      if (err) { setError(t("common.loadFailedRetry")); console.error(err); }
      else setContracts(data as Contract[]);
      setLoading(false);
    });
  }, [userId, role]);

  if (loading) return <div className="text-muted-foreground p-8">{t("common.loading")}</div>;
  if (error) return <ErrorState message={error} onRetry={() => window.location.reload()} />;

  const fmtAED = (v: number) => v >= 1_000_000 ? `AED ${(v/1_000_000).toFixed(1)}M` : `AED ${v.toLocaleString()}`;
  const totalActive = contracts.reduce((s, c) => ["signed","active"].includes(c.status) ? s + c.contract_amount : s, 0);

  return (
    <div className="space-y-0">
      <SubNavTabs
        items={[
          { href: "/contracts", labelKey: "contracts.subnavContracts", iconName: "file-text" },
          { href: "/projects", labelKey: "contracts.subnavProjects", iconName: "briefcase" },
        ]}
      />
      <div className="flex items-center justify-between mb-6 mt-5">
        <h1 className="text-2xl font-bold">{t("contracts.title")}</h1>
        <Link href="/contracts/new" className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-wine-500 text-foreground text-sm font-medium hover:bg-wine-600 transition-colors">
          <Plus className="w-4 h-4" />
          {t("contracts.newContract")}
        </Link>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <Card className="bg-copper-500/5 border-copper-500/20"><CardContent className="p-4"><p className="text-xs text-copper-400">{t("contracts.total")}</p><p className="text-xl font-bold">{contracts.length}</p></CardContent></Card>
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
          return (
          <Card key={c.id} className="bg-card border-border hover:border-border transition-colors">
            <CardContent className="p-4">
              <div className="flex items-start justify-between">
                <div className="space-y-1 flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <FileText className="w-4 h-4 text-copper-400 shrink-0" />
                    <span className="font-medium text-foreground">{c.contract_no}</span>
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
                {/* Send Reminder button for unpaid/overdue first payments */}
                {needsReminder && (
                  <Button
                    size="sm" variant="outline"
                    onClick={() => sendReminder(c.id)}
                    className="shrink-0 ml-2 border-copper-500/30 text-copper-400 hover:bg-copper-500/10 text-xs h-8"
                  >
                    <Bell className="w-3 h-3 mr-1" />Remind
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
          );
        })}
      </div>
      <Toaster position="top-center" richColors />
    </div>
  );
}
