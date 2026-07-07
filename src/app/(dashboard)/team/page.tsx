"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { cn, fmtDubai } from "@/models/utils";
import { useLanguage } from "@/views/i18n/LanguageContext";
import { useRequireRole } from "@/hooks/useRequireRole";
import {
  Users,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  User,
  AlertCircle,
  Mail,
  Phone,
  Clock,
  CheckCircle2,
  XCircle,
  KeyRound,
  ArrowLeft,
  Trash2,
  Eye,
  Activity,
  CalendarDays,
  Info,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import Link from "next/link";
import { toast, Toaster } from "sonner";
import { addTeamMember, removeTeamMember, resetUserPassword } from "@/controllers/actions/team";

// ─── UI Components (shadcn / base-ui) ───
import { Button } from "@/views/ui/button";
import { Input } from "@/views/ui/input";
import { Label } from "@/views/ui/label";
import { Badge } from "@/views/ui/badge";
import { DashboardScrollContainer } from "@/views/layout/DashboardScrollContainer";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/views/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/views/ui/select";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/views/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/views/ui/tabs";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/views/ui/tooltip";

// ─── Types ───
interface UserProfile {
  id: string;
  email: string | null;
  full_name: string | null;
  role: string;
  is_active: boolean | null;
  last_active_at: string | null;
}

interface ActivityAction {
  time: string;
  type: string;
  content: string;
}

interface UserActivity {
  user_id: string;
  user_name: string;
  first_active: string;
  last_active: string;
  actions: ActivityAction[];
}

interface DailyReport {
  date: string;
  users: UserActivity[];
}

const ROLES = [
  { value: "admin", labelKey: "team.roleAdmin" },
  { value: "boss", labelKey: "team.roleBoss" },
  { value: "sales", labelKey: "team.roleSales" },
  { value: "designer", labelKey: "team.roleDesigner" },
  { value: "operator", labelKey: "team.roleOperator" },
  { value: "finance", labelKey: "team.roleFinance" },
];

const ROLE_COLORS: Record<string, string> = {
  admin: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  boss: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  sales: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  designer: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  operator: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
  finance: "bg-rose-500/10 text-rose-400 border-rose-500/20",
};

// ─── Helpers ───
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function TeamPage() {
  const { t, lang } = useLanguage();
  const { loading: roleLoading, blocked } = useRequireRole(["admin", "boss", "operator"]);

  // ─── Tab state ───
  const [activeTab, setActiveTab] = useState<string>("members");

  // State
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // Add User dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    full_name: "",
    email: "",
    password: "",
    role: "sales",
    phone: "",
  });

  // Current user info
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [currentUserRole, setCurrentUserRole] = useState<string>("sales");

  // Password reveal
  const [revealTarget, setRevealTarget] = useState<{ id: string; name: string } | null>(null);
  const [revealedPassword, setRevealedPassword] = useState<string | null>(null);
  const [revealLoading, setRevealLoading] = useState(false);

  // ─── Activity Log state ───
  const [activityDate, setActivityDate] = useState<string>(todayStr());
  const [activityData, setActivityData] = useState<DailyReport | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [expandedUsers, setExpandedUsers] = useState<Set<string>>(new Set());

  // Whether current user can see activity tab
  const canSeeActivity = currentUserRole === "admin" || currentUserRole === "boss";

  // ─── Fetch users ───
  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/users");
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || t("team.fetchFailed"));
      }
      const data = await res.json();
      setUsers(data.users ?? []);
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  // Initialize current user info from BFF API
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/team/list");
        if (res.ok) {
          const data = await res.json();
          setCurrentUserId(data.currentUserId);
          setCurrentUserRole(data.currentUserRole);
        }
      } catch { /* ignore */ }
    })();
  }, []);

  // ─── Fetch activity data ───
  const fetchActivity = useCallback(async (date: string) => {
    setActivityLoading(true);
    setActivityError(null);
    try {
      const res = await fetch(`/api/activity/daily-report?date=${date}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || t("team.activityFetchFailed"));
      }
      const apiData = await res.json();
      // API returns { date, report } → map to frontend shape { date, users }
      const data: DailyReport = {
        date: apiData.date || date,
        users: (apiData.report || []).map((r: any) => ({
          user_id: r.user_id,
          user_name: r.user_name,
          first_active: r.first_active_at,
          last_active: r.last_active_at,
          actions: r.events || [],
        })),
      };
      setActivityData(data);
      // expand all users by default
      setExpandedUsers(new Set(data.users.map((u) => u.user_id)));
    } catch (e: any) {
      setActivityError(e.message);
    }
    setActivityLoading(false);
  }, [t]);

  // Fetch activity when date changes or tab switches
  useEffect(() => {
    if (activeTab === "activity" && canSeeActivity) {
      fetchActivity(activityDate);
    }
  }, [activeTab, activityDate, canSeeActivity, fetchActivity]);

  // Password reset state
  const [resetPasswordValue, setResetPasswordValue] = useState("");

  // Role guard — must be AFTER all hooks
  if (roleLoading || blocked) return <div className="text-center py-16 text-muted-foreground">{t("common.loading")}</div>;

  // ─── Reset password handler ───
  const handleResetPassword = async () => {
    if (!revealTarget || !resetPasswordValue || resetPasswordValue.length < 6) {
      toast.error(t("team.fillRequired"));
      return;
    }
    setRevealLoading(true);
    try {
      await resetUserPassword(revealTarget.id, resetPasswordValue);
      setRevealedPassword(resetPasswordValue);
      toast.success(`${revealTarget.name} ${t("team.passwordReset")}`);
    } catch (e: any) {
      toast.error(e.message || t("common.saveFailed"));
    }
    setRevealLoading(false);
  };

  // ─── Delete user ───
  const handleDeleteUser = async (userId: string) => {
    try {
      await removeTeamMember(userId);
      toast.success(t("team.userDeleted"));
      fetchUsers();
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  // ─── Filter ───
  const filtered = users.filter((u) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      u.full_name?.toLowerCase().includes(s) ||
      u.email?.toLowerCase().includes(s) ||
      u.role?.toLowerCase().includes(s)
    );
  });

  // ─── Create user ───
  const handleCreateUser = async () => {
    // Validation
    if (!form.full_name || !form.email || !form.password) {
      toast.error(t("team.fillRequired"));
      return;
    }

    setSubmitting(true);
    try {
      await addTeamMember(form);
      toast.success(`${form.full_name} ${t("team.userCreated")}`);
      setDialogOpen(false);
      setForm({ full_name: "", email: "", password: "", role: "sales", phone: "" });
      fetchUsers();
    } catch (e: any) {
      toast.error(e.message);
    }
    setSubmitting(false);
  };

  // ─── Format last active ───
  const formatLastActive = (iso: string | null) => {
    if (!iso) return "-";
    const d = new Date(iso);
    const now = new Date();
    const diff = Math.floor((now.getTime() - d.getTime()) / 1000);
    if (diff < 60) return t("team.justNow");
    if (diff < 3600) return t("team.minutesAgo").replace("{n}", String(Math.floor(diff / 60)));
    if (diff < 86400) return t("team.hoursAgo").replace("{n}", String(Math.floor(diff / 3600)));
    return fmtDubai(d, { locale: lang === "zh" ? "zh-CN" : "en-US", month: "short", day: "numeric" });
  };

  // ─── Toggle user expand ───
  const toggleUserExpand = (userId: string) => {
    setExpandedUsers((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  };

  // ─── Render ───
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
        {t("common.loading")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-10 text-center text-rose-400">
        {t("common.error")}: {error}
        <button
          onClick={fetchUsers}
          className="underline ml-4 text-muted-foreground hover:text-foreground"
        >
          {t("team.retry")}
        </button>
      </div>
    );
  }

  return (
    <DashboardScrollContainer className="space-y-6">
      <Link prefetch={false} href="/settings" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors">
        <ArrowLeft className="w-3.5 h-3.5" />
        {t("team.backToSettings")}
      </Link>
      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            background: "#1E2328",
            border: "1px solid rgba(234, 230, 223, 0.15)",
            color: "#EAE6DF",
          },
        }}
      />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight">
            {t("team.title")}
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {t("team.subtitle")}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={fetchUsers}>
            <RefreshCw className="w-3.5 h-3.5 mr-1" />
            {t("common.refresh")}
          </Button>
          <Button
            size="sm"
            className="bg-copper-500 text-foreground hover:bg-copper-600"
            onClick={() => setDialogOpen(true)}
          >
            <Plus className="w-3.5 h-3.5 mr-1" />
            {t("team.addUser")}
          </Button>
        </div>
      </div>

      {/* ─── Tabs ─── */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList variant="line">
          <TabsTrigger value="members">
            <Users className="w-3.5 h-3.5 mr-1" />
            {t("team.tabMembers")}
          </TabsTrigger>
          {canSeeActivity && (
            <TabsTrigger value="activity">
              <Activity className="w-3.5 h-3.5 mr-1" />
              {t("team.tabActivityLog")}
            </TabsTrigger>
          )}
        </TabsList>

        {/* ─── Members Tab ─── */}
        <TabsContent value="members" className="space-y-6 mt-4">

          {/* Stats */}
          <div className="grid grid-cols-3 gap-3">
            <div className="p-4 rounded-xl border border-border/50 bg-card/50">
              <p className="text-xs text-muted-foreground">
                {t("team.totalMembers")}
              </p>
              <p className="text-2xl font-bold text-foreground mt-1">
                {users.length}
              </p>
            </div>
            <div className="p-4 rounded-xl border border-emerald-500/20 bg-emerald-500/5">
              <p className="text-xs text-emerald-400">
                {t("team.salesTeam")}
              </p>
              <p className="text-2xl font-bold text-emerald-400 mt-1">
                {users.filter((u) => u.role === "sales").length}
              </p>
            </div>
            <div className="p-4 rounded-xl border border-border/50 bg-card/50">
              <p className="text-xs text-muted-foreground">
                {t("team.management")}
              </p>
              <p className="text-2xl font-bold text-foreground mt-1">
                {users.filter((u) => u.role === "admin" || u.role === "boss" || u.role === "operator").length}
              </p>
            </div>
          </div>

          {/* Search */}
          <div className="flex items-center gap-1.5 bg-muted/50 border border-border/50 rounded-lg px-3 py-1.5 max-w-xs">
            <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={
                t("team.searchPlaceholder")
              }
              className="bg-transparent text-xs text-foreground placeholder:text-muted-foreground/60 outline-none flex-1"
            />
          </div>

          {/* Users Table */}
          <div className="rounded-xl border border-border/50 overflow-hidden">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-b border-border/50 bg-muted/30">
                    <TableHead className="py-2.5 px-3 text-muted-foreground font-medium text-xs">
                      {t("team.name")}
                    </TableHead>
                    <TableHead className="py-2.5 px-3 text-muted-foreground font-medium text-xs">
                      {t("leads.email")}
                    </TableHead>
                    <TableHead className="py-2.5 px-3 text-muted-foreground font-medium text-xs">
                      {t("team.role")}
                    </TableHead>
                    <TableHead className="py-2.5 px-3 text-muted-foreground font-medium text-xs">
                      {t("team.status")}
                    </TableHead>
                    <TableHead className="py-2.5 px-3 text-muted-foreground font-medium text-xs">
                      {t("team.lastActive")}
                    </TableHead>
                    <TableHead className="py-2.5 px-3 text-muted-foreground font-medium text-xs text-right">
                      {t("team.actions")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((user) => (
                    <TableRow
                      key={user.id}
                      className="border-b border-border/20 hover:bg-accent/30 transition-colors"
                    >
                      <TableCell className="py-2.5 px-3">
                        <div className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-full bg-copper-500/20 flex items-center justify-center text-copper-400 text-xs font-bold shrink-0">
                            {(user.full_name || user.email || "?")
                              .charAt(0)
                              .toUpperCase()}
                          </div>
                          <div>
                            <p className="font-medium text-foreground text-sm">
                              {user.full_name || "-"}
                            </p>
                            {user.full_name && user.email && (
                              <p className="text-[11px] text-muted-foreground">
                                {user.email}
                              </p>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="py-2.5 px-3">
                        {!user.full_name ? (
                          <span className="text-xs text-foreground">
                            {user.email || "-"}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className="py-2.5 px-3">
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[11px] font-medium",
                            ROLE_COLORS[user.role] || "bg-muted text-muted-foreground border-border",
                          )}
                        >
                          <ShieldCheck className="w-3 h-3 mr-1" />
                          {t(`team.role${user.role.charAt(0).toUpperCase()}${user.role.slice(1)}` as any)}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-2.5 px-3">
                        {user.is_active ? (
                          <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
                            <CheckCircle2 className="w-3 h-3" />
                            {t("team.active")}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                            <XCircle className="w-3 h-3" />
                            {t("team.inactive")}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="py-2.5 px-3">
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatLastActive(user.last_active_at)}
                        </span>
                      </TableCell>
                      <TableCell className="py-2.5 px-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {(currentUserRole === "admin" || currentUserRole === "boss") && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-[11px] text-copper-400 hover:text-copper-300 hover:bg-copper-500/10"
                              onClick={() => { setRevealTarget({ id: user.id, name: (user.full_name || user.email || "User") }); setResetPasswordValue(""); setRevealedPassword(null); }}
                            >
                              <KeyRound className="w-3 h-3" />
                            </Button>
                          )}
                          {(currentUserRole === "admin" || currentUserRole === "boss") && user.id !== currentUserId && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-[11px] text-rose-400 hover:text-rose-300 hover:bg-rose-500/10"
                              onClick={() => handleDeleteUser(user.id)}
                            >
                              <Trash2 className="w-3 h-3" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {filtered.length === 0 && (
              <div className="py-16 text-center text-muted-foreground text-sm">
                <AlertCircle className="w-8 h-8 mx-auto mb-2 opacity-30" />
                {t("team.noMatching")}
              </div>
            )}
          </div>
        </TabsContent>

        {/* ─── Activity Log Tab ─── */}
        {canSeeActivity && (
          <TabsContent value="activity" className="space-y-4 mt-4">

            {/* Date picker + disclaimer */}
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3">
                <CalendarDays className="w-4 h-4 text-muted-foreground" />
                <Input
                  type="date"
                  value={activityDate}
                  onChange={(e) => setActivityDate(e.target.value)}
                  max={todayStr()}
                  className="w-40 text-sm"
                />
              </div>
              <Tooltip>
                <TooltipTrigger className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-help">
                  <Info className="w-3.5 h-3.5" />
                  {t("team.activityTooltip")}
                </TooltipTrigger>
                <TooltipContent>
                  {t("team.activityTooltip")}
                </TooltipContent>
              </Tooltip>
            </div>

            {/* Loading */}
            {activityLoading && (
              <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
                {t("common.loading")}
              </div>
            )}

            {/* Error */}
            {activityError && (
              <div className="p-10 text-center text-rose-400">
                {activityError}
                <button
                  onClick={() => fetchActivity(activityDate)}
                  className="underline ml-4 text-muted-foreground hover:text-foreground"
                >
                  {t("team.retry")}
                </button>
              </div>
            )}

            {/* No data */}
            {!activityLoading && !activityError && activityData && activityData.users.length === 0 && (
              <div className="py-16 text-center text-muted-foreground text-sm">
                <Activity className="w-8 h-8 mx-auto mb-2 opacity-30" />
                {t("team.activityNoData")}
              </div>
            )}

            {/* Activity list by user */}
            {!activityLoading && !activityError && activityData && activityData.users.length > 0 && (
              <div className="space-y-3">
                {activityData.users.map((userActivity) => {
                  const isExpanded = expandedUsers.has(userActivity.user_id);
                  return (
                    <div
                      key={userActivity.user_id}
                      className="rounded-xl border border-border/50 overflow-hidden"
                    >
                      {/* User header */}
                      <button
                        className="w-full flex items-center justify-between px-4 py-3 bg-card/50 hover:bg-accent/20 transition-colors text-left"
                        onClick={() => toggleUserExpand(userActivity.user_id)}
                      >
                        <div className="flex items-center gap-3">
                          {isExpanded ? (
                            <ChevronDown className="w-4 h-4 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="w-4 h-4 text-muted-foreground" />
                          )}
                          <div className="w-8 h-8 rounded-full bg-copper-500/20 flex items-center justify-center text-copper-400 text-xs font-bold shrink-0">
                            {userActivity.user_name.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <p className="font-medium text-foreground text-sm">
                              {userActivity.user_name}
                            </p>
                            <p className="text-[11px] text-muted-foreground flex items-center gap-1 mt-0.5">
                              <Clock className="w-3 h-3" />
                              {t("team.activityActivePeriod")}: {formatTime(userActivity.first_active)} ~ {formatTime(userActivity.last_active)}
                            </p>
                          </div>
                        </div>
                        <Badge variant="outline" className="text-[11px] bg-muted/50">
                          {userActivity.actions.length} {t("team.activityActions")}
                        </Badge>
                      </button>

                      {/* Expanded actions list */}
                      {isExpanded && (
                        <div className="border-t border-border/30">
                          {userActivity.actions.length === 0 ? (
                            <div className="px-4 py-6 text-center text-muted-foreground text-xs">
                              {t("team.activityNoActions")}
                            </div>
                          ) : (
                            <div className="divide-y divide-border/20">
                              {userActivity.actions.map((action, idx) => (
                                <div
                                  key={idx}
                                  className="flex items-start gap-3 px-4 py-2.5 hover:bg-accent/10 transition-colors"
                                >
                                  <span className="text-[11px] text-muted-foreground font-mono shrink-0 mt-0.5 min-w-[48px]">
                                    {formatTime(action.time)}
                                  </span>
                                  <Badge
                                    variant="outline"
                                    className="text-[10px] shrink-0 bg-muted/30 font-medium"
                                  >
                                    {action.type}
                                  </Badge>
                                  <span className="text-xs text-foreground/80 leading-relaxed">
                                    {action.content}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </TabsContent>
        )}
      </Tabs>

      {/* ─── Add User Dialog ─── */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("team.addNewUser")}
            </DialogTitle>
            <DialogDescription>
              {t("team.addNewUserDesc")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Full Name */}
            <div className="space-y-1.5">
              <Label htmlFor="full_name">
                {t("team.fullName")}{" "}
                <span className="text-rose-400">*</span>
              </Label>
              <Input
                id="full_name"
                value={form.full_name}
                onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                placeholder={
                  t("team.enterName")
                }
              />
            </div>

            {/* Email */}
            <div className="space-y-1.5">
              <Label htmlFor="email">
                {t("leads.email")} <span className="text-rose-400">*</span>
              </Label>
              <Input
                id="email"
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="user@example.com"
              />
            </div>

            {/* Password */}
            <div className="space-y-1.5">
              <Label htmlFor="password">
                {t("team.password")}{" "}
                <span className="text-rose-400">*</span>
              </Label>
              <Input
                id="password"
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder={
                  t("team.setPassword")
                }
              />
            </div>

            {/* Role */}
            <div className="space-y-1.5">
              <Label htmlFor="role">
                {t("team.role")}{" "}
                <span className="text-rose-400">*</span>
              </Label>
              <Select
                value={form.role}
                onValueChange={(value) =>
                  setForm({ ...form, role: value ?? "sales" })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {t(r.labelKey as any)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Phone */}
            <div className="space-y-1.5">
              <Label htmlFor="phone">
{t("team.role")}{" "}
                <span className="text-muted-foreground text-[10px]">
                  ({t("team.optional")})
                </span>
              </Label>
              <Input
                id="phone"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="+971 XX XXX XXXX"
              />
            </div>
          </div>

          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
                {t("common.cancel")}
            </DialogClose>
            <Button
              className="bg-copper-500 text-foreground hover:bg-copper-600"
              onClick={handleCreateUser}
              disabled={submitting}
            >
              {submitting ? t("team.creating") : t("team.createUser")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Password Reset Dialog ─── */}
      <Dialog open={!!revealTarget && !revealedPassword} onOpenChange={() => { setRevealTarget(null); setResetPasswordValue(""); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-copper-400" />
              {t("team.resetPassword")}
            </DialogTitle>
            <DialogDescription>
              {revealTarget?.name}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-3">
            <Input
              type="password"
              placeholder={t("team.setPassword")}
              value={resetPasswordValue}
              onChange={(e) => setResetPasswordValue(e.target.value)}
              minLength={6}
            />
            <p className="text-[11px] text-muted-foreground">
              {t("team.passwordMinLength")}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setRevealTarget(null); setResetPasswordValue(""); }}>
              {t("team.close")}
            </Button>
            <Button
              className="bg-copper-500 hover:bg-copper-600 text-white"
              onClick={handleResetPassword}
              disabled={revealLoading || resetPasswordValue.length < 6}
            >
              {revealLoading ? t("common.loading") : t("team.confirmReset")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Password Reset Success Dialog ─── */}
      <Dialog open={!!revealedPassword} onOpenChange={() => { setRevealedPassword(null); setRevealTarget(null); setResetPasswordValue(""); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-green-400" />
              {t("team.passwordResetSuccess")}
            </DialogTitle>
            <DialogDescription>
              {revealTarget?.name}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/50 border border-border/20">
              <KeyRound className="w-4 h-4 text-copper-400 shrink-0" />
              <code className="text-sm font-mono text-foreground select-all">
                {revealedPassword || "••••••"}
              </code>
            </div>
            <p className="text-[11px] text-muted-foreground mt-2">
              {t("team.passwordResetHint")}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setRevealedPassword(null); setRevealTarget(null); }}>
              {t("team.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardScrollContainer>
  );
}
