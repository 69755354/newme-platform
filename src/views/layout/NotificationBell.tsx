"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Bell, CheckCheck, Circle, ExternalLink, X } from "lucide-react";
import { cn } from "@/models/utils";
import { useLanguage } from "@/views/i18n/LanguageContext";
import { useRouter } from "next/navigation";

interface Notification {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  related_id: string | null;
  related_type: string | null;
  is_read: boolean;
  created_at: string;
}

const TYPE_ICONS: Record<string, string> = {
  lead_created: "✨",
  lead_assigned: "👤",
  lead_stage_change: "🔄",
  lead_stage_changed: "🔄",
  quote_created: "📊",
  contract_created: "📄",
  contract_signed: "📝",
  payment_due: "📅",
  payment_overdue: "⚠️",
  payment_received: "💰",
  kpi_target_set: "🎯",
  followup_reminder: "⏰",
  team_member_added: "👥",
  follow_up_overdue: "⚠️",
  first_payment_reminder: "💳",
};

const TYPE_LABELS: Record<string, string> = {
  lead_created: "notifications.types.lead_created",
  lead_assigned: "notifications.types.lead_assigned",
  lead_stage_change: "notifications.types.lead_stage_change",
  lead_stage_changed: "notifications.types.lead_stage_changed",
  quote_created: "notifications.types.quote_created",
  contract_created: "notifications.types.contract_created",
  contract_signed: "notifications.types.contract_signed",
  payment_due: "notifications.types.payment_due",
  payment_overdue: "notifications.types.payment_overdue",
  payment_received: "notifications.types.payment_received",
  kpi_target_set: "notifications.types.kpi_target_set",
  followup_reminder: "notifications.types.followup_reminder",
  team_member_added: "notifications.types.team_member_added",
  follow_up_overdue: "notifications.types.follow_up_overdue",
  first_payment_reminder: "notifications.types.first_payment_reminder",
};

function getRelatedLink(type: string, relatedType: string | null, relatedId: string | null): string | null {
  if (!relatedId) return null;
  if (relatedType === "lead" || type === "lead_assigned" || type === "lead_stage_change" || type === "lead_stage_changed" || type === "lead_created") {
    return `/leads/${relatedId}`;
  }
  if (relatedType === "contract" || type === "contract_signed" || type === "contract_created") {
    return `/contracts?focus=${relatedId}`;
  }
  if (relatedType === "payment" || type === "payment_overdue" || type === "payment_received" || type === "payment_due") {
    return `/payments?focus=${relatedId}`;
  }
  if (relatedType === "quote" || type === "quote_created") {
    return `/quotes?focus=${relatedId}`;
  }
  if (relatedType === "kpi" || type === "kpi_target_set") {
    return `/settings/kpi`;
  }
  if (type === "team_member_added") {
    return `/settings/users`;
  }
  return null;
}

function timeAgo(dateStr: string, lang: "zh" | "en", t: (key: string) => string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);

  if (minutes < 1) return t("notifications.justNow");
  if (minutes < 60) return `${minutes} ${t("notifications.minutesAgo")}`;
  if (hours < 24) return `${hours} ${t("notifications.hoursAgo")}`;
  if (days < 30) return `${days} ${t("notifications.daysAgo")}`;
  return new Date(dateStr).toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
  });
}

export default function NotificationBell() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const dropdownContentRef = useRef<HTMLDivElement>(null);
  const { lang, t } = useLanguage();
  const router = useRouter();

  // Fetch unread count periodically
  const fetchUnreadCount = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications/unread-count");
      if (res.ok) {
        const json = await res.json();
        setUnreadCount(json.count ?? 0);
      }
    } catch (e) {
      // Silent fail
    }
  }, []);

  // Fetch notifications when dropdown opens
  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/notifications?limit=20");
      if (res.ok) {
        const json = await res.json();
        setNotifications(json.data ?? []);
        // Also update the unread count from the data
        const unread = (json.data ?? []).filter((n: Notification) => !n.is_read).length;
        setUnreadCount(unread);
      }
    } catch (e) {
      // Silent fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUnreadCount();
    // Poll every 60 seconds
    const interval = setInterval(fetchUnreadCount, 60_000);
    return () => clearInterval(interval);
  }, [fetchUnreadCount]);

  // Click outside to close
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      const insideAnchor = dropdownRef.current?.contains(target);
      const insideDropdown = dropdownContentRef.current?.contains(target);
      if (!insideAnchor && !insideDropdown) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      fetchNotifications();
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, fetchNotifications]);

  async function markAsRead(id: string) {
    try {
      await fetch(`/api/notifications/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_read: true }),
      });
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, is_read: true } : n))
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
    } catch (e) {
      // Silent fail
    }
  }

  async function markAllAsRead() {
    try {
      const res = await fetch("/api/notifications/read-all", { method: "POST" });
      if (res.ok) {
        setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
        setUnreadCount(0);
      }
    } catch (e) {
      // Silent fail
    }
  }

  function handleNotificationClick(n: Notification) {
    if (!n.is_read) markAsRead(n.id);
    const link = getRelatedLink(n.type, n.related_type, n.related_id);
    if (link) router.push(link);
    setIsOpen(false);
  }

  return (
    <div ref={dropdownRef} className="relative">
      {/* Bell icon button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative p-1.5 rounded-lg hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
        aria-label={t("notifications.title")}
      >
        <Bell className="w-5 h-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-[10px] font-bold text-white leading-none">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown — rendered via portal so layout overflow-hidden cannot clip it */}
      {isOpen && createPortal(
        <div
          ref={dropdownContentRef}
          className="fixed z-[9999] w-[380px] max-h-[500px] bg-popover border border-border rounded-xl shadow-xl ring-1 ring-foreground/10 overflow-hidden data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95"
          style={{
            top: (dropdownRef.current?.getBoundingClientRect().bottom ?? 0) + 8,
            left: (dropdownRef.current?.getBoundingClientRect().right ?? 380) - 380,
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <h3 className="text-sm font-semibold text-foreground">
              {t("notifications.title")}
            </h3>
            <div className="flex items-center gap-1">
              {unreadCount > 0 && (
                <button
                  onClick={markAllAsRead}
                  className="flex items-center gap-1 text-[11px] text-copper-400 hover:text-copper-300 transition-colors px-2 py-1 rounded hover:bg-accent"
                >
                  <CheckCheck className="w-3 h-3" />
                  {t("notifications.markAllRead")}
                </button>
              )}
              <button
                onClick={() => setIsOpen(false)}
                className="p-1 rounded hover:bg-accent text-muted-foreground"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* List */}
          <div className="overflow-y-auto max-h-[400px]">
            {loading ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground text-xs">
                {t("notifications.loading")}
              </div>
            ) : notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                <Bell className="w-8 h-8 mb-2 opacity-30" />
                <p className="text-xs">{t("notifications.noNotifications")}</p>
              </div>
            ) : (
              notifications.map((n) => (
                <button
                  key={n.id}
                  onClick={() => handleNotificationClick(n)}
                  className={cn(
                    "w-full text-left flex items-start gap-3 px-4 py-3 transition-colors hover:bg-accent border-b border-border/50 last:border-b-0",
                    !n.is_read && "bg-accent/30"
                  )}
                >
                  {/* Icon */}
                  <span className="text-lg shrink-0 mt-0.5">
                    {TYPE_ICONS[n.type] || "🔔"}
                  </span>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <p
                        className={cn(
                          "text-sm leading-tight",
                          !n.is_read ? "font-semibold text-foreground" : "text-muted-foreground"
                        )}
                      >
                        {n.title}
                      </p>
                      {!n.is_read && (
                        <Circle className="w-2 h-2 fill-rose-500 text-rose-500 shrink-0 mt-1" />
                      )}
                    </div>
                    {n.body && (
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                        {n.body}
                      </p>
                    )}
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[10px] text-muted-foreground/60">
                        {timeAgo(n.created_at, lang, t)}
                      </span>
                      <span className="text-[10px] text-muted-foreground/40">
                        {t(TYPE_LABELS[n.type] || "") || n.type}
                      </span>
                    </div>
                  </div>

                  {/* Arrow */}
                  <ExternalLink className="w-3 h-3 text-muted-foreground/30 shrink-0 mt-1" />
                </button>
              ))
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
