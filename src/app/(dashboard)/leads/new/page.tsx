"use client";

import { Button } from "@/views/ui/button";
import { Input } from "@/views/ui/input";
import { Label } from "@/views/ui/label";
import { Textarea } from "@/views/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/views/ui/card";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { createClient } from "@/models/supabase";
import { createFollowUpTask } from "@/services/tasks";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/views/i18n/LanguageContext";
import { DashboardScrollContainer } from "@/views/layout/DashboardScrollContainer";
import { toast } from "sonner";

export default function NewLeadPage() {
  const router = useRouter();
  const supabase = createClient();
  const { t } = useLanguage();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    customer_name: "", phone: "", email: "",
    location: "", source: "offline", notes: "",
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const { data: { user } } = await supabase.auth.getUser();
    const followupDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const { data, error } = await supabase.from("leads").insert({
      source: form.source,
      customer_name: form.customer_name || null,
      phone: form.phone || null,
      email: form.email || null,
      location: form.location || null,
      quality: "pending",
      assigned_to: user?.id || null,
      created_by: user?.id || null,
      next_action: "call",
      next_followup_date: followupDate,
    }).select("id").single();

    if (error) {
      toast.error(t("leads.createFailed") || "Failed to create lead");
      setSaving(false);
      return;
    }

    if (data) {
      if (form.notes) {
        const { error: newLeadNoteErr } = await supabase.from("follow_up_logs").insert({
          lead_id: data.id, contact_type: "note", summary: form.notes,
          user_id: user?.id ?? null,
          no_answer: false,
        });
        if (newLeadNoteErr) {
          toast.error("Note save failed");
        }
      }
      // P0-7: 建 lead 时同步写一条跟进 task，确保 Workbench 今日待办立即可见
      const { error: taskErr } = await createFollowUpTask(supabase, {
        leadId: data.id,
        dueAt: followupDate,
        title: "Follow up",
        assigneeId: user?.id ?? null,
        source: "follow_up",
      });
      if (taskErr) toast.warning("Lead created but follow-up task creation failed");
      // Notify admins about new lead
      import("@/services/notify").then(({ notify }) => {
        notify({ type: "lead_created", lead_id: data.id, customer_name: form.customer_name || "Unknown" });
      });
      // Meta Pixel: track Lead conversion
      if (typeof window !== "undefined" && (window as any).fbq) {
        (window as any).fbq("track", "Lead", {
          content_name: form.customer_name || "unknown",
          content_category: "smart_home_lead",
          source: form.source,
          location: form.location || undefined,
        });
      }
      toast.success(t("leads.created") || "Lead created successfully");
      setTimeout(() => { window.location.href = "/leads"; }, 500);
    }
    setSaving(false);
  }

  return (
    <DashboardScrollContainer className="max-w-lg space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => router.back()} className="text-muted-foreground">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h1 className="text-2xl font-bold text-foreground">{t("leads.newLead")}</h1>
      </div>

      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-lg">{t("leads.customerInfo")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label className="text-foreground">{t("leads.name")}</Label>
              <Input
                value={form.customer_name}
                onChange={(e) => setForm({ ...form, customer_name: e.target.value })}
                className="bg-muted border-border text-foreground mt-1"
                placeholder={t("leads.name")}
              />
            </div>
            <div>
              <Label className="text-foreground">{t("leads.phone")}</Label>
              <Input
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className="bg-muted border-border text-foreground mt-1"
                placeholder="+971..."
              />
            </div>
            <div>
              <Label className="text-foreground">{t("leads.email")}</Label>
              <Input
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="bg-muted border-border text-foreground mt-1"
                placeholder="email@example.com"
              />
            </div>
            <div>
              <Label className="text-foreground">{t("leads.location")}</Label>
              <Input
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                className="bg-muted border-border text-foreground mt-1"
                placeholder="Dubai, Palm Jumeirah..."
              />
            </div>
            <div>
              <Label className="text-foreground">{t("leads.source")}</Label>
              <select
                value={form.source}
                onChange={(e) => setForm({ ...form, source: e.target.value })}
                className="w-full mt-1 rounded-md bg-muted border border-border text-foreground px-3 py-2 text-sm"
              >
                <option value="offline">{t("sourceLabels.offline")}</option>
                <option value="whatsapp">{t("sourceLabels.whatsapp")}</option>
                <option value="meta_ads">{t("sourceLabels.meta_ads")}</option>
                <option value="website">{t("sourceLabels.website")}</option>
                <option value="referral">{t("sourceLabels.referral")}</option>
                <option value="other">{t("sourceLabels.other")}</option>
              </select>
            </div>
            <div>
              <Label className="text-foreground">{t("leads.notes")}</Label>
              <Textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                className="bg-muted border-border text-foreground mt-1"
                placeholder={t("leads.notes")}
                rows={3}
              />
            </div>
            <Button
              type="submit"
              disabled={saving}
              className="w-full bg-copper-500 hover:bg-copper-600 text-black font-semibold"
            >
              {saving ? t("common.saving") : t("leads.createLead")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </DashboardScrollContainer>
  );
}
