"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { LEAD_FIELD_LIMITS } from "@/lib/lead-contact.mjs";
import {
  LeadDuplicateNotice,
  leadFieldErrorKey,
  submitNewLead,
  type CreateLeadErrorState,
} from "@/components/leads/LeadDuplicateNotice";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { DashboardScrollContainer } from "@/components/DashboardScrollContainer";
import { toast } from "sonner";

export default function NewLeadPage() {
  const router = useRouter();
  const { t } = useLanguage();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    customer_name: "", phone: "", email: "",
    location: "", source: "offline", notes: "",
  });

  const [errorState, setErrorState] = useState<CreateLeadErrorState | null>(null);

  async function create(overrideReason?: string) {
    setSaving(true);
    try {
      const result = await submitNewLead({
        customer_name: form.customer_name,
        phone: form.phone,
        email: form.email,
        location: form.location,
        source: form.source,
        notes: form.notes,
      }, overrideReason);
      if (!result.ok) {
        setErrorState(result.state);
        if (!result.state) toast.error(t("leads.createFailed") || "Failed to create lead");
        return;
      }
      setErrorState(null);
      if (result.warnings.length > 0) toast.warning(t("common.saveFailed"));
      // Meta Pixel: track Lead conversion
      if (typeof window !== "undefined" && (window as any).fbq) {
        (window as any).fbq("track", "Lead", {
          content_name: form.customer_name || "unknown",
          content_category: "smart_home_lead",
          source: form.source,
          location: form.location || undefined,
        });
      }
      toast.success(t("leadFlow.created"));
      router.push(`/leads/${result.id}`);
    } catch {
      toast.error(t("leads.createFailed") || "Failed to create lead");
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
    return code ? <p className="text-xs text-red-400 mt-1">{t(leadFieldErrorKey(field, code))}</p> : null;
  };

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
                maxLength={LEAD_FIELD_LIMITS.customer_name}
                className="bg-muted border-border text-foreground mt-1"
                placeholder={t("leads.name")}
              />
              {fieldError("customer_name")}
            </div>
            <div>
              <Label className="text-foreground">{t("leads.phone")}</Label>
              <Input
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                maxLength={LEAD_FIELD_LIMITS.phone}
                className="bg-muted border-border text-foreground mt-1"
                placeholder="050 123 4567 / +971..."
              />
              {fieldError("phone")}
            </div>
            <div>
              <Label className="text-foreground">{t("leads.email")}</Label>
              <Input
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                maxLength={LEAD_FIELD_LIMITS.email}
                className="bg-muted border-border text-foreground mt-1"
                placeholder="email@example.com"
              />
              {fieldError("email")}
              {fieldError("contact")}
            </div>
            <div>
              <Label className="text-foreground">{t("leads.location")}</Label>
              <Input
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                maxLength={LEAD_FIELD_LIMITS.location}
                className="bg-muted border-border text-foreground mt-1"
                placeholder="Dubai, Palm Jumeirah..."
              />
              {fieldError("location")}
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
                <option value="ins">{t("sourceLabels.ins")}</option>
                <option value="fb">{t("sourceLabels.fb")}</option>
                <option value="show_room">{t("sourceLabels.show_room")}</option>
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
                maxLength={LEAD_FIELD_LIMITS.notes}
                className="bg-muted border-border text-foreground mt-1"
                placeholder={t("leads.notes")}
                rows={3}
              />
              {fieldError("notes")}
            </div>
            {errorState?.duplicates && errorState.duplicates.length > 0 && (
              <LeadDuplicateNotice
                duplicates={errorState.duplicates}
                canOverride={errorState.canOverride}
                reviewRequired={errorState.reviewRequired === true}
                submitting={saving}
                onOverride={(reason) => { void create(reason); }}
              />
            )}
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
