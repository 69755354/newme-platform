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

import { useState } from "react";
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
  Pencil,
  Trash2,
} from "lucide-react";
import { MILESTONE_DESCRIPTIONS } from "@/lib/milestones";
import type {
  Activity,
  BusinessEvent,
  ChatMessage,
  FollowUpLog,
} from "./types";

interface Props {
  leadId: string;
  activities: Activity[];
  events: BusinessEvent[];
  followUpLogs: FollowUpLog[];
  chatMessages: ChatMessage[];
  noteText: string;
  onNoteTextChange: (v: string) => void;
  onAddNote: () => void;
  onContactUpdated: () => Promise<void>;
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
  leadId,
  activities,
  events,
  followUpLogs,
  chatMessages,
  noteText,
  onNoteTextChange,
  onAddNote,
  onContactUpdated,
  t,
  lang,
}: Props) {
  const [editingContactId, setEditingContactId] = useState<string | null>(null);
  const [editContact, setEditContact] = useState({
    contact_method: "",
    contact_time: "",
    contact_result: "",
    summary: "",
  });
  const [contactSaving, setContactSaving] = useState(false);
  const [contactDeleting, setContactDeleting] = useState<string | null>(null);
  const [contactError, setContactError] = useState<string | null>(null);

  const beginContactEdit = (log: FollowUpLog) => {
    setEditingContactId(log.id);
    setEditContact({
      contact_method: log.contact_type || "other",
      contact_time: new Date(log.contact_time || log.created_at).toISOString().slice(0, 16),
      contact_result: log.contact_result || "",
      summary: log.summary || "",
    });
    setContactError(null);
  };

  const saveContactEdit = async () => {
    if (!editingContactId || contactSaving) return;
    setContactSaving(true);
    setContactError(null);
    try {
      const response = await fetch(
        `/api/leads/${leadId}/contacts/${editingContactId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...editContact,
            contact_time: new Date(editContact.contact_time).toISOString(),
          }),
        },
      );
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        setContactError(json?.error || "Failed to update contact record");
        return;
      }
      await onContactUpdated();
      setEditingContactId(null);
    } finally {
      setContactSaving(false);
    }
  };

  const deleteContact = async (contactId: string) => {
    if (contactDeleting || !window.confirm(lang === "zh" ? "删除这条联系记录？此操作不可撤销。" : "Delete this contact record? This cannot be undone.")) return;
    setContactDeleting(contactId);
    setContactError(null);
    try {
      const response = await fetch(`/api/leads/${leadId}/contacts/${contactId}`, { method: "DELETE" });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        setContactError(json?.error || (lang === "zh" ? "删除联系记录失败" : "Failed to delete contact record"));
        return;
      }
      if (editingContactId === contactId) setEditingContactId(null);
      await onContactUpdated();
    } catch {
      setContactError(lang === "zh" ? "删除联系记录失败" : "Failed to delete contact record");
    } finally {
      setContactDeleting(null);
    }
  };

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
      content: f.summary || f.contact_result || "",
      ai_generated: false,
      created_at: f.contact_time || f.created_at,
      _type: "followup" as const,
    })),
  ]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 100);

  return (
    <Card className="border-border bg-card shadow-sm">
      <CardHeader className="border-b border-border/70 pb-3">
        <CardTitle className="text-base text-foreground flex items-center gap-2">
          <Clock className="w-4 h-4 text-copper-400" /> {t("leadDetail.timeline")}
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
            const contact = item._type === "followup"
              ? followUpLogs.find((log) => log.id === item.id)
              : undefined;
            const editableContact = contact && !["note", "import_note"].includes(contact.contact_type);
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
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-foreground whitespace-pre-wrap break-words">{item.content}</p>
                    {editableContact && contact && (
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => beginContactEdit(contact)}
                          aria-label={lang === "zh" ? "编辑联系记录" : "Edit Contact Record"}
                          className="text-[10px] text-copper-500 hover:text-copper-400 flex items-center gap-1"
                        >
                          <Pencil className="w-3 h-3" />
                          {lang === "zh" ? "编辑" : "Edit"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void deleteContact(contact.id)}
                          disabled={contactDeleting === contact.id}
                          className="text-[10px] text-rose-400 hover:text-rose-300 disabled:opacity-50 flex items-center gap-1"
                        >
                          <Trash2 className="w-3 h-3" />
                          {contactDeleting === contact.id ? "..." : lang === "zh" ? "删除" : "Delete"}
                        </button>
                      </div>
                    )}
                  </div>
                  {editableContact && editingContactId === item.id && (
                    <div className="mt-2 grid gap-2 rounded border border-copper-500/20 p-2">
                      <select
                        value={editContact.contact_method}
                        onChange={(event) => setEditContact((value) => ({ ...value, contact_method: event.target.value }))}
                        className="h-8 rounded border border-border bg-muted px-2 text-xs"
                      >
                        <option value="whatsapp">WhatsApp</option>
                        <option value="phone">{lang === "zh" ? "电话" : "Phone"}</option>
                        <option value="other">{lang === "zh" ? "其他" : "Other"}</option>
                      </select>
                      <input
                        type="datetime-local"
                        value={editContact.contact_time}
                        max={new Date().toISOString().slice(0, 16)}
                        onChange={(event) => setEditContact((value) => ({ ...value, contact_time: event.target.value }))}
                        className="h-8 rounded border border-border bg-muted px-2 text-xs"
                      />
                      <input
                        value={editContact.contact_result}
                        onChange={(event) => setEditContact((value) => ({ ...value, contact_result: event.target.value }))}
                        placeholder={lang === "zh" ? "联系结果" : "Contact result"}
                        className="h-8 rounded border border-border bg-muted px-2 text-xs"
                      />
                      <Textarea
                        value={editContact.summary}
                        onChange={(event) => setEditContact((value) => ({ ...value, summary: event.target.value }))}
                        placeholder={lang === "zh" ? "摘要" : "Summary"}
                        className="min-h-16 bg-muted text-xs"
                      />
                      {contactError && <p className="text-xs text-red-400">{contactError}</p>}
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={saveContactEdit}
                          disabled={contactSaving || !editContact.contact_result.trim() || !editContact.contact_time}
                        >
                          {contactSaving ? "..." : t("common.save") || "Save"}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setEditingContactId(null)} disabled={contactSaving}>
                          {t("common.cancel") || "Cancel"}
                        </Button>
                      </div>
                    </div>
                  )}
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
