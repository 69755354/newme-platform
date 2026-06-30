"use client";

// Follow-up Logs Timeline Page
// Displays all follow_up_logs for a lead, ordered by created_at DESC.
// Each record shows: type, content, next_action, next_action_date, created_by (full_name), created_at.
// Top "新增跟进" button opens a dialog form; submit inserts into follow_up_logs and refreshes.

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { toast, Toaster } from "sonner";
import {
  ArrowLeft,
  Plus,
  Phone,
  Users,
  Mail,
  MessageCircle,
  MoreHorizontal,
  Clock,
} from "lucide-react";
import { fmtDubai } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────
interface FollowUpLogRow {
  id: string;
  type: string;
  content: string;
  next_action: string | null;
  next_action_date: string | null;
  created_by: string | null;
  created_at: string;
  // Joined field
  creator?: { full_name: string | null }[] | null;
}

const TYPE_OPTIONS = [
  { value: "call", label: "电话", icon: Phone },
  { value: "visit", label: "拜访", icon: Users },
  { value: "email", label: "邮件", icon: Mail },
  { value: "whatsapp", label: "WhatsApp", icon: MessageCircle },
  { value: "other", label: "其他", icon: MoreHorizontal },
] as const;

const TYPE_COLORS: Record<string, string> = {
  call: "bg-emerald-500/10 text-emerald-600",
  visit: "bg-blue-500/10 text-blue-600",
  email: "bg-purple-500/10 text-purple-600",
  whatsapp: "bg-green-500/10 text-green-600",
  other: "bg-gray-500/10 text-gray-600",
};

// ─── Helpers ──────────────────────────────────────────────────────────
function getTypeIcon(type: string) {
  const found = TYPE_OPTIONS.find((t) => t.value === type);
  if (!found) return MoreHorizontal;
  return found.icon;
}

function getTypeLabel(type: string) {
  const found = TYPE_OPTIONS.find((t) => t.value === type);
  return found?.label ?? type;
}

function formatDateTime(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return "—";
  return fmtDubai(dateStr, { locale: "zh-CN", year: "numeric", month: "2-digit", day: "2-digit" });
}

// ─── Page Component ───────────────────────────────────────────────────
export default function LeadTimelinePage() {
  const { id } = useParams<{ id: string }>();
  const supabase = createClient();

  const [logs, setLogs] = useState<FollowUpLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Form state
  const [formType, setFormType] = useState("call");
  const [formContent, setFormContent] = useState("");
  const [formNextAction, setFormNextAction] = useState("");
  const [formNextActionDate, setFormNextActionDate] = useState("");

  // ─── Fetch data ──────────────────────────────────────────────────
  const fetchLogs = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("follow_up_logs")
        .select("id, type, content, next_action, next_action_date, created_by, created_at, creator:profiles!fk_follow_up_logs_created_by(full_name)")
        .eq("lead_id", id)
        .order("created_at", { ascending: false });

      if (error) {
        console.error("[Timeline] fetch failed:", error);
        toast.error("加载跟进记录失败");
        return;
      }
      setLogs((data ?? []) as FollowUpLogRow[]);
    } catch (err) {
      console.error("[Timeline] fetch error:", err);
      toast.error("加载跟进记录失败");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  // ─── Submit form ─────────────────────────────────────────────────
  async function handleSubmit() {
    if (!formContent.trim()) {
      toast.error("请填写跟进内容");
      return;
    }
    setSubmitting(true);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      const insertPayload: Record<string, any> = {
        lead_id: id,
        type: formType,
        content: formContent.trim(),
        next_action: formNextAction.trim() || null,
        next_action_date: formNextActionDate || null,
        created_by: user?.id ?? null,
      };

      const { error } = await supabase.from("follow_up_logs").insert(insertPayload);

      if (error) {
        console.error("[Timeline] insert failed:", error);
        toast.error("保存失败: " + error.message);
        return;
      }

      toast.success("跟进记录已保存");
      // Reset form and close dialog
      setFormType("call");
      setFormContent("");
      setFormNextAction("");
      setFormNextActionDate("");
      setDialogOpen(false);
      // Refresh list
      fetchLogs();
    } catch (err: any) {
      console.error("[Timeline] submit error:", err);
      toast.error("保存失败");
    } finally {
      setSubmitting(false);
    }
  }

  // ─── Render ──────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background">
      <Toaster richColors position="top-center" />

      {/* Header */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                window.location.href = `/leads/${id}`;
              }}
              className="text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <h1 className="text-lg font-semibold text-foreground flex items-center gap-2">
              <Clock className="w-5 h-5 text-copper-500" />
              跟进记录
            </h1>
          </div>
          <Button
            onClick={() => setDialogOpen(true)}
            className="bg-copper-500 hover:bg-copper-600 text-black"
          >
            <Plus className="w-4 h-4 mr-1" />
            新增跟进
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-4xl mx-auto px-6 py-6">
        {loading ? (
          <div className="text-center text-muted-foreground py-12">加载中...</div>
        ) : logs.length === 0 ? (
          <Card className="bg-card border-border">
            <CardContent className="py-12 text-center text-muted-foreground">
              <p className="text-lg mb-2">暂无跟进记录</p>
              <p className="text-sm">点击上方"新增跟进"按钮添加第一条记录</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {logs.map((log) => {
              const TypeIcon = getTypeIcon(log.type);
              return (
                <Card key={log.id} className="bg-card border-border hover:border-copper-500/30 transition-colors">
                  <CardContent className="p-5">
                    {/* Top row: type badge + date */}
                    <div className="flex items-start justify-between mb-3">
                      <Badge className={cn("gap-1 px-2 py-0.5 text-xs font-medium", TYPE_COLORS[log.type] || TYPE_COLORS.other)}>
                        <TypeIcon className="w-3 h-3" />
                        {getTypeLabel(log.type)}
                      </Badge>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {formatDateTime(log.created_at)}
                      </span>
                    </div>

                    {/* Content */}
                    <p className="text-sm text-foreground whitespace-pre-wrap break-words leading-relaxed mb-3">
                      {log.content}
                    </p>

                    {/* Meta row */}
                    <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
                      {log.creator?.[0]?.full_name && (
                        <span className="flex items-center gap-1">
                          <span className="text-gray-500">跟进人:</span>
                          <span className="text-foreground font-medium">{log.creator[0].full_name}</span>
                        </span>
                      )}
                      {log.next_action && (
                        <span className="flex items-center gap-1">
                          <span className="text-gray-500">下一步:</span>
                          <span className="text-foreground">{log.next_action}</span>
                        </span>
                      )}
                      {log.next_action_date && (
                        <span className="flex items-center gap-1">
                          <span className="text-gray-500">跟进日期:</span>
                          <span className="text-foreground">{formatDate(log.next_action_date)}</span>
                        </span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Add Follow-up Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-foreground">新增跟进记录</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Type selector */}
            <div className="space-y-2">
              <Label className="text-sm font-medium text-foreground">跟进方式</Label>
              <div className="flex flex-wrap gap-2">
                {TYPE_OPTIONS.map((opt) => {
                  const Icon = opt.icon;
                  return (
                    <Button
                      key={opt.value}
                      type="button"
                      variant={formType === opt.value ? "default" : "outline"}
                      size="sm"
                      onClick={() => setFormType(opt.value)}
                      className={cn(
                        "gap-1 text-xs",
                        formType === opt.value && "bg-copper-500 hover:bg-copper-600 text-black"
                      )}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      {opt.label}
                    </Button>
                  );
                })}
              </div>
            </div>

            {/* Content */}
            <div className="space-y-2">
              <Label htmlFor="follow-content" className="text-sm font-medium text-foreground">
                跟进内容 <span className="text-red-500">*</span>
              </Label>
              <Textarea
                id="follow-content"
                placeholder="记录本次跟进的详细内容..."
                value={formContent}
                onChange={(e) => setFormContent(e.target.value)}
                className="min-h-[100px] resize-y bg-muted border-border text-foreground"
                rows={4}
              />
            </div>

            {/* Next action */}
            <div className="space-y-2">
              <Label htmlFor="next-action" className="text-sm font-medium text-foreground">
                下一步行动
              </Label>
              <Input
                id="next-action"
                placeholder="例：发送报价单、安排拜访..."
                value={formNextAction}
                onChange={(e) => setFormNextAction(e.target.value)}
                className="bg-muted border-border text-foreground"
              />
            </div>

            {/* Next action date */}
            <div className="space-y-2">
              <Label htmlFor="next-action-date" className="text-sm font-medium text-foreground">
                计划跟进日期
              </Label>
              <Input
                id="next-action-date"
                type="date"
                value={formNextActionDate}
                onChange={(e) => setFormNextActionDate(e.target.value)}
                className="bg-muted border-border text-foreground"
              />
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={submitting}
              className="text-foreground"
            >
              取消
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={submitting || !formContent.trim()}
              className="bg-copper-500 hover:bg-copper-600 text-black"
            >
              {submitting ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
