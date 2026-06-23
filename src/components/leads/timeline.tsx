"use client";

import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import {
  CheckCircle,
  MessageCircle,
  ClipboardList,
  FileText,
  type LucideIcon,
} from "lucide-react";

type EventType = "milestone" | "follow_up" | "task" | "document";

interface TimelineEvent {
  id: string;
  event_type: EventType;
  description: string;
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        // Fetch timeline data
        const res = await fetch(`/api/leads/${leadId}/timeline`, {
          credentials: "include",
          headers: { "Content-Type": "application/json" },
        });

        if (!res.ok) {
          throw new Error(`Failed to load timeline (${res.status})`);
        }

        const json = await res.json();
        const raw: unknown = Array.isArray(json)
          ? json
          : json?.events ?? json?.data ?? [];

        const list: TimelineEvent[] = Array.isArray(raw)
          ? (raw as TimelineEvent[])
              .filter(
                (e) =>
                  e &&
                  typeof e.created_at === "string" &&
                  typeof e.event_type === "string"
              )
              .sort(
                (a, b) =>
                  new Date(b.created_at).getTime() -
                  new Date(a.created_at).getTime()
              )
          : [];

        if (!cancelled) setEvents(list);
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

  if (events.length === 0) {
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