"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase";
import { createFollowUpTask } from "@/lib/tasks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageContext";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

const SOURCE_OPTIONS = [
  { value: "whatsapp", labelKey: "leads.sourceWhatsApp" },
  { value: "meta_ads", labelKey: "leads.sourceMetaAds" },
  { value: "website", labelKey: "common.website" },
  { value: "offline", labelKey: "common.offline" },
  { value: "referral", labelKey: "common.referral" },
  { value: "other", labelKey: "common.other" },
];

export default function QuickCreateLeadDialog({ open, onOpenChange, onCreated }: Props) {
  const supabase = createClient();
  const { t } = useLanguage();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    customer_name: "",
    phone: "",
    source: "whatsapp",
    location: "",
    notes: "",
  });

  function resetForm() {
    setForm({ customer_name: "", phone: "", source: "whatsapp", location: "", notes: "" });
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.customer_name.trim() && !form.phone.trim()) {
      setError(t("leads.nameOrPhoneRequired"));
      return;
    }
    setSaving(true);
    setError(null);

    const { data: { user } } = await supabase.auth.getUser();

    const followupDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const { data, error: insertErr } = await supabase
      .from("leads")
      .insert({
        source: form.source,
        customer_name: form.customer_name.trim() || null,
        phone: form.phone.trim() || null,
        location: form.location.trim() || null,
        quality: "pending",
        assigned_to: user?.id || null,
        next_action: "call",
        next_followup_date: followupDate,
      })
      .select("id")
      .single();

    if (insertErr) {
      console.error("QuickCreate failed:", insertErr);
      setError(t("leads.createFailed"));
      setSaving(false);
      return;
    }

    // Save note as activity
    if (data && form.notes.trim()) {
      const { error: noteErr } = await supabase.from("activities").insert({
        lead_id: data.id,
        type: "note",
        content: form.notes.trim(),
        user_id: user?.id,
      });
      if (noteErr) console.error("Note save failed:", noteErr);
    }

    // P0-7: 建 lead 时同步写一条跟进 task，确保 Workbench 今日待办立即可见
    if (data) {
      const { error: taskErr } = await createFollowUpTask(supabase, {
        leadId: data.id,
        dueAt: followupDate,
        title: "Follow up",
        assigneeId: user?.id ?? null,
        source: "follow_up",
      });
      if (taskErr) import("sonner").then(({ toast }) => toast.warning("Lead created but follow-up task creation failed"));
    }

    // Notify admins about new lead
    import("@/lib/notify").then(({ notify }) => {
      notify({ type: "lead_created", lead_id: data!.id, customer_name: form.customer_name || "Unknown" });
    });

    // Meta Pixel tracking
    if (typeof window !== "undefined" && (window as any).fbq) {
      (window as any).fbq("track", "Lead", {
        content_name: form.customer_name || "unknown",
        content_category: "smart_home_lead",
        source: form.source,
        location: form.location || undefined,
      });
    }

    setSaving(false);
    resetForm();
    onOpenChange(false);
    onCreated();
  }

  function handleOpenChange(open: boolean) {
    if (!open) resetForm();
    onOpenChange(open);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md bg-[#1E2328] border-gray-800 text-gray-100">
        <DialogHeader>
          <DialogTitle className="text-white text-lg">
            {t("leads.quickCreate")}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-gray-400 text-xs">{t("leads.name")}</Label>
              <Input
                autoFocus
                placeholder={t("leads.customerNamePlaceholder")}
                value={form.customer_name}
                onChange={(e) => setForm({ ...form, customer_name: e.target.value })}
                className="bg-gray-950 border-gray-700 text-white h-9"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-gray-400 text-xs">{t("leads.phone2")}</Label>
              <Input
                placeholder="+971 50..."
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className="bg-gray-950 border-gray-700 text-white h-9"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-gray-400 text-xs">{t("leads.source")}</Label>
              <select
                value={form.source}
                onChange={(e) => setForm({ ...form, source: e.target.value })}
                className="w-full bg-gray-950 border border-gray-700 text-white rounded-md h-9 px-2 text-sm"
              >
                {SOURCE_OPTIONS.map((s) => (
                  <option key={s.value} value={s.value}>{t(s.labelKey)}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-gray-400 text-xs">{t("leads.region")}</Label>
              <Input
                placeholder="Dubai / Abu Dhabi..."
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                className="bg-gray-950 border-gray-700 text-white h-9"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-gray-400 text-xs">{t("leads.notes")}</Label>
            <Input
              placeholder={t("leads.notesPlaceholder")}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              className="bg-gray-950 border-gray-700 text-white h-9"
            />
          </div>

          {error && (
            <p className="text-red-400 text-xs">{error}</p>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <DialogClose
              render={<Button type="button" variant="ghost" className="text-gray-400 h-8">{t("common.cancel")}</Button>}
            />
            <Button
              type="submit"
              disabled={saving}
              className="bg-[#D4A373] hover:bg-[#D4A373]/85 text-[#1E2328] font-medium h-8 text-sm"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
              {saving ? t("leads.creating") : t("leads.createLead")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
