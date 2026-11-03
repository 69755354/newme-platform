"use client";

import { useState } from "react";
import { LEAD_FIELD_LIMITS } from "@/lib/lead-contact.mjs";
import {
  LeadDuplicateNotice,
  leadFieldErrorKey,
  submitNewLead,
  type CreateLeadErrorState,
} from "@/components/leads/LeadDuplicateNotice";
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
  { value: "ins", labelKey: "sourceLabels.ins" },
  { value: "fb", labelKey: "sourceLabels.fb" },
  { value: "show_room", labelKey: "sourceLabels.show_room" },
  { value: "website", labelKey: "common.website" },
  { value: "offline", labelKey: "common.offline" },
  { value: "referral", labelKey: "common.referral" },
  { value: "other", labelKey: "common.other" },
];

export default function QuickCreateLeadDialog({ open, onOpenChange, onCreated }: Props) {
  const { t } = useLanguage();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorState, setErrorState] = useState<CreateLeadErrorState | null>(null);
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
    setErrorState(null);
  }

  async function create(overrideReason?: string) {
    setSaving(true);
    setError(null);
    try {
      // S3 #4/#5/#8: one server route validates, normalises the phone, checks
      // duplicates, creates the follow-up task and sends the notification.
      const result = await submitNewLead({
        customer_name: form.customer_name,
        phone: form.phone,
        location: form.location,
        source: form.source,
        notes: form.notes,
      }, overrideReason);
      if (!result.ok) {
        setErrorState(result.state);
        if (!result.state) setError(t("leads.createFailed"));
        return;
      }
      // Meta Pixel tracking
      if (typeof window !== "undefined" && (window as any).fbq) {
        (window as any).fbq("track", "Lead", {
          content_name: form.customer_name || "unknown",
          content_category: "smart_home_lead",
          source: form.source,
          location: form.location || undefined,
        });
      }
      resetForm();
      onOpenChange(false);
      onCreated();
    } catch {
      setError(t("leads.createFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await create();
  }

  const fieldError = (field: string) => {
    const code = errorState?.fieldErrors?.[field];
    return code ? <p className="text-red-400 text-xs">{t(leadFieldErrorKey(field, code))}</p> : null;
  };

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
                maxLength={LEAD_FIELD_LIMITS.customer_name}
                className="bg-gray-950 border-gray-700 text-white h-9"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-gray-400 text-xs">{t("leads.phone2")}</Label>
              <Input
                placeholder="050 123 4567"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                maxLength={LEAD_FIELD_LIMITS.phone}
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
                maxLength={LEAD_FIELD_LIMITS.location}
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
                maxLength={LEAD_FIELD_LIMITS.notes}
              className="bg-gray-950 border-gray-700 text-white h-9"
            />
          </div>

          {fieldError("customer_name")}
          {fieldError("phone")}
          {fieldError("contact")}
          {fieldError("location")}
          {fieldError("notes")}
          {errorState?.duplicates && errorState.duplicates.length > 0 && (
            <LeadDuplicateNotice
              duplicates={errorState.duplicates}
              canOverride={errorState.canOverride}
              submitting={saving}
              onOverride={(reason) => { void create(reason); }}
            />
          )}
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
