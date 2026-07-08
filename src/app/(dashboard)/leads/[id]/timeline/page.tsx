"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn, fmtDubai } from "@/lib/utils";
import { toast, Toaster } from "sonner";
import { ArrowLeft, Plus, Phone, MoreHorizontal, Clock, MessageSquare } from "lucide-react";
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";
import { useLanguage } from "@/lib/i18n/LanguageContext";

interface FollowUpLogRow {
  id: string;
  contact_type: string;
  summary: string;
  next_action: string | null;
  created_by: string | null;
  created_at: string;
  contact_time: string | null;
  result: string | null;
  creator?: { full_name: string | null }[] | null;
}

const TYPE_OPTIONS = [
  { value: "wsa", label: { zh: "wsa", en: "wsa" }, icon: MessageSquare },
  { value: "phone", label: { zh: "电话", en: "Phone" }, icon: Phone },
  { value: "other", label: { zh: "其他", en: "Other" }, icon: MoreHorizontal },
] as const;

const TYPE_COLORS: Record<string, string> = {
  wsa: "bg-cyan-500/10 text-cyan-400",
  phone: "bg-emerald-500/10 text-emerald-400",
  other: "bg-gray-500/10 text-gray-400",
};

const getTypeIcon = (type: string) => TYPE_OPTIONS.find((t) => t.value === type)?.icon ?? MoreHorizontal;
const getTypeLabel = (type: string, lang: "en" | "zh") => TYPE_OPTIONS.find((t) => t.value === type)?.label[lang] ?? type;
const formatDateTime = (iso: string | null) => (iso ? fmtDubai(new Date(iso), { locale: "zh-CN", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");

export default function LeadTimelinePage() {
  const { id } = useParams<{ id: string }>();
  const { lang } = useLanguage();
  const supabase = createClient();
  const [logs, setLogs] = useState<FollowUpLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formType, setFormType] = useState<(typeof TYPE_OPTIONS)[number]["value"]>("phone");
  const [formContent, setFormContent] = useState("");
  const [formNextAction, setFormNextAction] = useState("");

  const [formContactTime, setFormContactTime] = useState("");

  useEffect(() => {
    (async () => {
      if (!id) return;
      setLoading(true);
      try {
        const { data, error } = await supabase
          .from("follow_up_logs")
          .select("id, contact_type, summary, next_action, created_by, created_at, contact_time, result, creator:profiles!fk_follow_up_logs_created_by(full_name)")
          .eq("lead_id", id)
          .order("created_at", { ascending: false });
        if (error) {
          toast.error(lang === "zh" ? "加载跟进记录失败" : "Failed to load follow-up logs");
          return;
        }
        setLogs((data ?? []) as FollowUpLogRow[]);
      } catch (err) {
        console.error("[Timeline] fetch error:", err);
        toast.error(lang === "zh" ? "加载跟进记录失败" : "Failed to load follow-up logs");
      } finally {
        setLoading(false);
      }
    })();
  }, [id, supabase, lang]);

  async function handleSubmit() {
    if (!formContent.trim()) return toast.error(lang === "zh" ? "请填写跟进内容" : "Please enter content");
    if (!formContactTime) return toast.error(lang === "zh" ? "请填写实际动作发生时间" : "Please enter action time");
    setSubmitting(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const contactTime = new Date(formContactTime);
      const insertPayload = {
        lead_id: id,
        contact_type: formType,
        summary: formContent.trim(),
        next_action: formNextAction.trim() || null,
        created_by: user?.id ?? null,
        contact_time: contactTime.toISOString(),
        result: "contacted",
      };
      const { error } = await supabase.from("follow_up_logs").insert(insertPayload);
      if (error) {
        toast.error((lang === "zh" ? "保存失败: " : "Save failed: ") + error.message);
        return;
      }
      toast.success(lang === "zh" ? "跟进记录已保存" : "Follow-up saved");
      setFormType("phone");
      setFormContent("");
      setFormNextAction("");
      setFormContactTime("");
      setDialogOpen(false);
      const { data, error: reloadError } = await supabase
        .from("follow_up_logs")
        .select("id, contact_type, summary, next_action, created_by, created_at, contact_time, result, creator:profiles!fk_follow_up_logs_created_by(full_name)")
        .eq("lead_id", id)
        .order("created_at", { ascending: false });
      if (!reloadError) setLogs((data ?? []) as FollowUpLogRow[]);
    } catch (err) {
      console.error("[Timeline] submit error:", err);
      toast.error(lang === "zh" ? "保存失败" : "Save failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <DashboardScrollContainer className="bg-background">
      <Toaster richColors position="top-center" />
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => { window.location.href = `/leads/${id}`; }} className="text-muted-foreground hover:text-foreground">
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <h1 className="text-lg font-semibold text-foreground flex items-center gap-2">
              <Clock className="w-5 h-5 text-copper-500" />{lang === "zh" ? "跟进记录" : "Follow-up Logs"}
            </h1>
          </div>
          <Button onClick={() => setDialogOpen(true)} className="bg-copper-500 hover:bg-copper-600 text-black">
            <Plus className="w-4 h-4 mr-1" />{lang === "zh" ? "新增跟进" : "Add follow-up"}
          </Button>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-6">
        {loading ? (
          <div className="text-center text-muted-foreground py-12">{lang === "zh" ? "加载中..." : "Loading..."}</div>
        ) : logs.length === 0 ? (
          <Card className="bg-card border-border"><CardContent className="py-12 text-center text-muted-foreground">{lang === "zh" ? "暂无跟进记录" : "No follow-up logs"}</CardContent></Card>
        ) : (
          <div className="space-y-3">
            {logs.map((log) => {
              const Icon = getTypeIcon(log.contact_type);
              return (
                <Card key={log.id} className="bg-card border-border">
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <Icon className="w-4 h-4 text-copper-500" />
                        <span>{getTypeLabel(log.contact_type, lang)}</span>
                        <Badge className={cn("text-[10px]", TYPE_COLORS[log.contact_type] || TYPE_COLORS.other)}>
                          {lang === "zh" ? "实际动作时间" : "Action time"} {formatDateTime(log.contact_time || log.created_at)}
                        </Badge>
                      </div>
                      <span className="text-xs text-muted-foreground">{formatDateTime(log.created_at)}</span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <p className="text-foreground whitespace-pre-wrap">{log.summary}</p>
                    {log.next_action && <p className="text-xs text-muted-foreground">{lang === "zh" ? "下一步" : "Next"}：{log.next_action}</p>}
                    <p className="text-xs text-muted-foreground">{lang === "zh" ? "记录人" : "Creator"}：{log.creator?.[0]?.full_name || "—"}</p>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{lang === "zh" ? "新增跟进" : "Add follow-up"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label>{lang === "zh" ? "类型" : "Type"}</Label>
                <div className="flex gap-2 flex-wrap">
                  {TYPE_OPTIONS.map((option) => {
                    const Icon = option.icon;
                    const active = formType === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setFormType(option.value)}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm transition-colors",
                          active ? "border-copper-500 bg-copper-500/10 text-copper-400" : "border-border text-muted-foreground hover:border-copper-500/40 hover:text-foreground"
                        )}
                      >
                        <Icon className="h-4 w-4" />{option.label[lang]}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-2">
                <Label>{lang === "zh" ? "跟进内容" : "Content"}</Label>
                <Textarea value={formContent} onChange={(e) => setFormContent(e.target.value)} placeholder={lang === "zh" ? "记录销售联系客户的实际动作" : "Describe the actual contact action"} />
              </div>

              <div className="space-y-2">
                <Label>{lang === "zh" ? "实际动作发生时间" : "Action time"}</Label>
                <input type="datetime-local" value={formContactTime} onChange={(e) => setFormContactTime(e.target.value)} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
              </div>

              <div className="space-y-2">
                <Label>{lang === "zh" ? "下一步" : "Next step"}</Label>
                <Textarea value={formNextAction} onChange={(e) => setFormNextAction(e.target.value)} placeholder={lang === "zh" ? "可选" : "Optional"} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={submitting}>{lang === "zh" ? "取消" : "Cancel"}</Button>
              <Button onClick={handleSubmit} disabled={submitting} className="bg-copper-500 hover:bg-copper-600 text-black">{submitting ? (lang === "zh" ? "保存中..." : "Saving...") : (lang === "zh" ? "保存" : "Save")}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardScrollContainer>
  );
}
