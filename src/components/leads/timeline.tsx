"use client";

import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import {
  CheckCircle,
  MessageCircle,
  ClipboardList,
  FileText,
  PhoneIncoming,
  PhoneOutgoing,
  type LucideIcon,
} from "lucide-react";

type EventType = "milestone" | "follow_up" | "task" | "document" | "chat";

interface TimelineEvent {
  id: string;
  event_type: EventType;
  description: string;
  created_at: string;
  metadata?: Record<string, unknown>;
}

interface ChatMessage {
  id: string;
  content: string | null;
  direction: string | null;
  created_at: string;
}

interface TimelineProps {
  leadId: string;
}

const EVENT_CONFIG: Record<
  EventType,
  { icon: LucideIcon; color: string; label: string }
> = {
  milestone: { icon: CheckCircle, color: "text-green-500", label: "Milestone" },
  follow_up: { icon: MessageCircle, color: "text-blue-500", label: "Follow-up" },
  task: { icon: ClipboardList, color: "text-orange-500", label: "Task" },
  document: { icon: FileText, color: "text-gray-500", label: "Document" },
  chat: { icon: MessageCircle, color: "text-cyan-500", label: "Chat" },
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getGroupKey(date: Date): "thisMonth" | "lastMonth" | "earlier" {
  const now = new Date();
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  if (date >= thisMonthStart) return "thisMonth";
  if (date >= lastMonthStart) return "lastMonth";
  return "earlier";
}

export default function Timeline({ leadId }: TimelineProps) {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        // Single source of truth: the timeline API already returns chat
        // messages server-side as `event_type: "chat"` events (content in
        // `description`, direction in `metadata.direction`). Do NOT fetch
        // chat_messages directly from Supabase here — that was a redundant
        // double fetch. Ask for a large limit so chats + activity are both
        // surfaced in one request.
        const eventsRes = await fetch(
          `/api/leads/${leadId}/timeline?limit=100`,
          {
            credentials: "include",
            headers: { "Content-Type": "application/json" },
          }
        );

        if (!eventsRes.ok) {
          throw new Error(`Failed to load timeline (${eventsRes.status})`);
        }

        const json = await eventsRes.json();
        const raw: unknown = Array.isArray(json)
          ? json
          : json?.events ?? json?.data ?? [];

        const all: TimelineEvent[] = Array.isArray(raw)
          ? (raw as TimelineEvent[])
          : [];

        // Activity events (everything except chat) — rendered as a timeline.
        const list: TimelineEvent[] = all
          .filter(
            (e) =>
              e &&
              typeof e.created_at === "string" &&
              typeof e.event_type === "string" &&
              e.event_type !== "chat"
          )
          .sort(
            (a, b) =>
              new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
          );

        // Chat messages come from the same API response (the `chat` events the
        // old code used to discard and then re-fetch). Rendered as bubbles,
        // oldest → newest.
        const chats: ChatMessage[] = all
          .filter(
            (e) =>
              e && e.event_type === "chat" && typeof e.created_at === "string"
          )
          .map((e) => ({
            id: e.id,
            content: e.description ?? null,
            direction: (e.metadata?.direction as string | undefined) ?? null,
            created_at: e.created_at,
          }))
          .sort(
            (a, b) =>
              new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
          );

        if (!cancelled) {
          setEvents(list);
          setChatMessages(chats);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load timeline");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [leadId]);

  const grouped = useMemo(() => {
    const buckets: Record<
      "thisMonth" | "lastMonth" | "earlier",
      TimelineEvent[]
    > = { thisMonth: [], lastMonth: [], earlier: [] };

    for (const ev of events) {
      buckets[getGroupKey(new Date(ev.created_at))].push(ev);
    }
    return buckets;
  }, [events]);

  if (loading) {
    return (
      <div
        className="flex items-center justify-center py-12"
        role="status"
        aria-label="Loading timeline"
      >
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-gray-700" />
      </div>
    );
  }

  if (error) {
    return (
      <Card className="p-4 text-sm text-red-600" role="alert">
        {error}
      </Card>
    );
  }

  const hasChat = chatMessages.length > 0;
  const hasEvents = events.length > 0;

  if (!hasChat && !hasEvents) {
    return (
      <Card className="p-6 text-center text-sm text-gray-500">
        No events yet
      </Card>
    );
  }

  const sections: Array<{
    key: "thisMonth" | "lastMonth" | "earlier";
    label: string;
  }> = [
    { key: "thisMonth", label: "This Month" },
    { key: "lastMonth", label: "Last Month" },
    { key: "earlier", label: "Earlier" },
  ];

  return (
    <div className="space-y-6">
      {/* WhatsApp chat bubbles */}
      {hasChat && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            <MessageCircle className="inline w-3.5 h-3.5 mr-1 -mt-0.5" />
            WhatsApp Chat
            <span className="ml-2 text-gray-400">({chatMessages.length})</span>
          </h3>
          <div className="rounded-xl border border-gray-200 bg-[#e5ddd5] p-3 space-y-1.5 max-h-[420px] overflow-y-auto">
            {chatMessages.map((msg) => {
              const outbound = msg.direction === "outbound";
              return (
                <div
                  key={msg.id}
                  className={`flex ${outbound ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[78%] rounded-lg px-3 py-1.5 shadow-sm ${
                      outbound
                        ? "bg-[#dcf8c6] text-gray-900 rounded-tr-none"
                        : "bg-white text-gray-900 rounded-tl-none"
                    }`}
                  >
                    <div className="flex items-center gap-1 mb-0.5 text-[10px] font-medium text-gray-500">
                      {outbound ? (
                        <>
                          <PhoneOutgoing className="w-3 h-3" />
                          <span>Sent</span>
                        </>
                      ) : (
                        <>
                          <PhoneIncoming className="w-3 h-3" />
                          <span>Received</span>
                        </>
                      )}
                    </div>
                    <p className="break-words whitespace-pre-wrap text-sm leading-snug">
                      {msg.content || (
                        <span className="italic text-gray-400">No content</span>
                      )}
                    </p>
                    <p className="mt-0.5 text-right text-[10px] text-gray-500">
                      {formatTime(msg.created_at)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Activity events */}
      {sections.map(({ key, label }) => {
        const items = grouped[key];
        if (items.length === 0) return null;

        return (
          <section key={key} className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              {label}
              <span className="ml-2 text-gray-400">({items.length})</span>
            </h3>

            <Card className="divide-y">
              <ol className="list-none p-0 m-0">
                {items.map((ev) => {
                  const cfg =
                    EVENT_CONFIG[ev.event_type as EventType] ??
                    EVENT_CONFIG.document;
                  const Icon = cfg.icon;

                  return (
                    <li
                      key={ev.id}
                      className="flex items-start gap-3 p-3"
                    >
                      <span
                        className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-50 ${cfg.color}`}
                        aria-label={cfg.label}
                      >
                        <Icon className="h-4 w-4" />
                      </span>

                      <div className="min-w-0 flex-1">
                        <p className="break-words text-sm text-gray-900">
                          {ev.description}
                        </p>
                        <p className="mt-0.5 text-xs text-gray-500">
                          {formatDate(ev.created_at)}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </Card>
          </section>
        );
      })}
    </div>
  );
}
