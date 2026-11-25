"use client";

// S43 (B12): the customer's own WhatsApp words, read-only, from the messages already stored for the lead.
// Collapsed by default (a folding card); shown only for WhatsApp leads that have a stored conversation.
// Visibility is the lead's: the API answers 403 for anyone RLS does not show the lead to.

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronDown, ChevronRight, MessageSquareText } from "lucide-react";
import { fmtDubai } from "@/lib/utils";
import type { Lead } from "./types";

interface Props { lead: Lead; t: (key: string) => string }
interface Message {
  id: string; direction: "inbound" | "outbound"; occurred_at: string;
  body: string | null; body_kind: string | null; message_type: string; backfilled: boolean;
}
interface Payload { has_conversation: boolean; messages: Message[] }

export default function LeadWhatsAppConversationCard({ lead, t }: Props) {
  const [data, setData] = useState<Payload | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const isWhatsApp = Boolean(lead.wa_first_inbound_at || lead.ctwa_clid || (lead.source_channel ?? "").startsWith("whatsapp"));

  useEffect(() => {
    if (!isWhatsApp) return;
    let cancelled = false;
    fetch(`/api/leads/${lead.id}/whatsapp-messages`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("messages_unavailable"))))
      .then((payload: Payload) => { if (!cancelled) setData(payload); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [isWhatsApp, lead.id]);

  if (!isWhatsApp || failed || !data || !data.has_conversation) return null;
  const when = (value: string) => fmtDubai(value, { locale: t("locale.dateLocale"), month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const text = (m: Message) => m.body ?? (m.body_kind === "media" ? t("s43.waConversation.media") : t("s43.waConversation.noText"));

  return (
    <Card data-testid="whatsapp-conversation-card">
      <CardHeader className="pb-2">
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
          className="flex w-full items-center gap-2 text-left text-sm font-semibold">
          {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
          <MessageSquareText className="h-4 w-4 text-emerald-600" />
          <CardTitle className="text-sm">{t("s43.waConversation.title")}</CardTitle>
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            {t("s43.waConversation.count").replace("{n}", String(data.messages.length))}
          </span>
        </button>
      </CardHeader>
      {open && (
        <CardContent className="space-y-2 text-sm">
          <p className="text-xs text-muted-foreground">{t("s43.waConversation.readOnly")}</p>
          <ul data-testid="whatsapp-conversation-list" className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
            {data.messages.map((m) => (
              <li key={m.id} className={m.direction === "inbound" ? "flex" : "flex justify-end"}>
                <div data-newme-uat-sensitive="true"
                  className={`max-w-[85%] rounded-lg px-2.5 py-1.5 text-xs ${m.direction === "inbound" ? "bg-muted text-foreground" : "bg-emerald-500/10 text-foreground"}`}>
                  <div className="whitespace-pre-wrap break-words">{text(m)}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {m.direction === "inbound" ? t("s43.waConversation.customer") : t("s43.waConversation.us")} · {when(m.occurred_at)}
                    {m.backfilled && ` · ${t("s43.waConversation.history")}`}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      )}
    </Card>
  );
}
