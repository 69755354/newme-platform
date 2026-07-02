"use client";

// Right column — Timeline. Three stacked blocks:
//   1. Add Note  (textarea + send button → onAddNote, reusing the page's addNote)
//   2. WhatsApp chat bubbles (if chatMessages exist) — directional bubbles
//   3. Activity feed — activities + business_events + follow_up_logs merged and
//      sorted newest-first.
//
// All data + the note draft live in page.tsx (so the same noteText / addNote
// behaviour is preserved); this component only renders. Extracted verbatim from
// the old TabTimeline() during the three-column refactor.

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { cn, fmtDubai } from "@/lib/utils";
import {
  Clock,
  Send,
  MessageCircle,
  PhoneOutgoing,
  PhoneIncoming,
} from "lucide-react";
import { MILESTONE_DESCRIPTIONS } from "@/lib/milestones";
import type {
  Activity,
  BusinessEvent,
  ChatMessage,
  FollowUpLog,
} from "./types";

interface Props {
  activities: Activity[];
  events: BusinessEvent[];
  followUpLogs: FollowUpLog[];
  chatMessages: ChatMessage[];
  noteText: string;
  onNoteTextChange: (v: string) => void;
  onAddNote: () => void;
  t: (key: string) => string;
  lang: "en" | "zh";
}

// Merged feed row — normalised shape so activities / events / follow_up_logs can
// share one renderer. `_type` remembers the source for the coloured label.
type FeedItem = {
  id: string;
  type: string;
  content: string;
  ai_generated: boolean;
  created_at: string;
  _type: "activity" | "event" | "followup";
};

export default function LeadTimeline({
  activities,
  events,
  followUpLogs,
  chatMessages,
  noteText,
  onNoteTextChange,
  onAddNote,
  t,
  lang,
}: Props) {
  // WhatsApp chat messages rendered as directional chat bubbles (oldest → newest)
  const chatItems = [...chatMessages]
    .map((c) => ({
      id: c.id,
      content: c.content || "",
      direction: c.direction,
      created_at: c.created_at,
    }))
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  // Activity + business events + follow_up_logs feed (newest first).
  // P0-1: follow_up_logs (incl. 'note' and 'import_note') are merged in so the
  // timeline shows every follow-up entry. Chat is rendered separately above.
  const allItems: FeedItem[] = [
    ...activities.map((a) => ({ ...a, _type: "activity" as const })),
    ...events.map((e) => ({
      id: e.id,
      type: e.event_type,
      content: e.description,
      ai_generated: false,
      created_at: e.created_at,
      _type: "event" as const,
    })),
    ...followUpLogs.map((f) => ({
      id: f.id,
      type: f.contact_type || "follow_up",
      content: f.summary,
      ai_generated: false,
      created_at: f.created_at,
      _type: "followup" as const,
    })),
  ]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 100);

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm text-muted-foreground flex items-center gap-2">
          <Clock className="w-4 h-4" /> {t("leadDetail.timeline")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Add note */}
        <div className="flex gap-2">
          <Textarea
            placeholder={t("leadDetail.placeholderNote")}
            value={noteText}
            onChange={(e) => onNoteTextChange(e.target.value)}
            className="bg-muted border-border text-foreground resize-none h-20"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onAddNote();
              }
            }}
          />
          <Button
            size="icon"
            onClick={onAddNote}
            disabled={!noteText.trim()}
            className="bg-copper-500 hover:bg-copper-600 text-black h-10 w-10 shrink-0 self-end"
          >
            <Send className="w-4 h-4" />
          </Button>
        </div>
        <Separator className="bg-border" />

        {/* WhatsApp chat bubbles */}
        {chatItems.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <MessageCircle className="w-3.5 h-3.5" /> {t("leadDetail.whatsappChat")} ({chatItems.length})
            </p>
            <div className="rounded-xl bg-[#e5ddd5] p-3 space-y-1.5 max-h-[420px] overflow-y-auto">
              {chatItems.map((msg) => {
                const outbound = msg.direction === "outbound";
                return (
                  <div key={msg.id} className={cn("flex", outbound ? "justify-end" : "justify-start")}>
                    <div
                      className={cn(
                        "max-w-[78%] rounded-lg px-3 py-1.5 shadow-sm",
                        outbound ? "bg-[#dcf8c6] text-gray-900 rounded-tr-none" : "bg-white text-gray-900 rounded-tl-none"
                      )}
                    >
                      <div className="flex items-center gap-1 mb-0.5 text-[10px] font-medium text-gray-500">
                        {outbound ? (
                          <>
                            <PhoneOutgoing className="w-3 h-3" />
                            <span>{t("leadDetail.chatSent")}</span>
                          </>
                        ) : (
                          <>
                            <PhoneIncoming className="w-3 h-3" />
                            <span>{t("leadDetail.chatReceived")}</span>
                          </>
                        )}
                      </div>
                      <p className="break-words whitespace-pre-wrap text-sm leading-snug">
                        {msg.content || <span className="italic text-gray-400">—</span>}
                      </p>
                      <p className="mt-0.5 text-right text-[10px] text-gray-500">
                        {new Date(msg.created_at).toLocaleTimeString(t("locale.dateTimeLocale"), {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Activity / events feed */}
        <div className="space-y-3">
          {allItems.map((item) => {
            const type: string = item.type;
            return (
              <div key={`${item._type}-${item.id}`} className="flex gap-3 text-sm">
                <div
                  className={cn(
                    "w-1.5 h-1.5 rounded-full mt-1.5 shrink-0",
                    type.includes("stage")
                      ? "bg-amber-500"
                      : type.includes("import")
                      ? "bg-sky-500"
                      : type.includes("note")
                      ? "bg-gray-500"
                      : type.includes("quote")
                      ? "bg-blue-500"
                      : type.includes("lost")
                      ? "bg-red-500"
                      : type.includes("probability") || type.includes("status")
                      ? "bg-purple-500"
                      : type.includes("followup")
                      ? "bg-emerald-500"
                      : type.includes("review")
                      ? "bg-violet-500"
                      : type.includes("recovery") || type.includes("transfer")
                      ? "bg-orange-500"
                      : "bg-gray-600"
                  )}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-foreground whitespace-pre-wrap break-words">{item.content}</p>
                  {type === "milestone" && MILESTONE_DESCRIPTIONS[item.content] && (
                    <p className="text-xs text-muted-foreground">
                      {lang === 'zh' ? MILESTONE_DESCRIPTIONS[item.content].zh : MILESTONE_DESCRIPTIONS[item.content].en}
                    </p>
                  )}
                  <p className="text-xs text-gray-600 mt-0.5 flex items-center gap-2">
                    {fmtDubai(item.created_at, { locale: t("locale.dateTimeLocale") })}
                    {item.ai_generated && <span className="text-purple-500">🤖 AI</span>}
                    {item._type === "event" && <span className="text-blue-500">{t("leadDetail.event")}</span>}
                    {item._type === "followup" && (
                      <span className="text-copper-500">
                        {item.type === "note"
                          ? `📝 ${t("leadDetail.note")}`
                          : item.type === "import_note"
                          ? `📥 ${lang === "zh" ? "导入备注" : "Imported"}`
                          : item.type === "phone"
                          ? `📞 ${t("leadDetail.call")}`
                          : item.type === "whatsapp"
                          ? "💬 WhatsApp"
                          : lang === "zh"
                          ? "跟进"
                          : "Follow-up"}
                      </span>
                    )}
                  </p>
                </div>
              </div>
            );
          })}
          {allItems.length === 0 && chatItems.length === 0 && (
            <p className="text-gray-600 text-sm text-center py-4">{t("leadDetail.noActivity")}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
