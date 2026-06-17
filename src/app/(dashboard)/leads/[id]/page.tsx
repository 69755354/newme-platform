"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { ErrorState } from "@/components/ui/error-state";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  ArrowLeft, Phone, MessageSquare, MapPin, Home, Plus, Send,
  Calendar, Clock, User, Target, AlertTriangle, ShieldAlert,
  RotateCcw, BarChart3, TrendingUp, MessageCircle,
  FileText, ClipboardList, CheckCircle, DollarSign, ExternalLink, Calculator, WandSparkles,
  Wrench, GitBranch, Pencil, X, Save,
} from "lucide-react";
import QuoteCalculator from "@/app/(dashboard)/quotes/quote-calculator";
import KnxDesignPanel from "@/components/knx-design-panel";
import LeadWorkflow from "@/components/lead-workflow";
import { Toaster } from "sonner";
import { updateLead } from "@/lib/api/leads";

const STAGES = ["new", "contacted", "no_answered", "requirement_confirmed", "solution_submitted", "quotation_submitted", "negotiation", "pending_decision", "won", "lost", "fake"];
const STAGE_COLORS: Record<string, string> = {
  new: "bg-gray-500/10 text-muted-foreground", contacted: "bg-amber-500/10 text-amber-400",
  no_answered: "bg-orange-500/10 text-orange-400",
  requirement_confirmed: "bg-yellow-500/10 text-yellow-400", solution_submitted: "bg-rose-500/10 text-rose-400",
  quotation_submitted: "bg-purple-500/10 text-purple-400", negotiation: "bg-blue-500/10 text-blue-400",
  pending_decision: "bg-amber-500/10 text-amber-400", won: "bg-emerald-500/10 text-emerald-400",
  lost: "bg-gray-500/10 text-muted-foreground",
  fake: "bg-red-900/20 text-red-400",
};
const getStatusLabels = (t: (key: string) => string): Record<string, { label: string; color: string; bg: string }> => ({
  hot: { label: "🔥 " + t("leads.hot"), color: "text-rose-400", bg: "bg-rose-500/10" },
  warm: { label: "☀️ " + t("leads.warm"), color: "text-amber-400", bg: "bg-amber-500/10" },
  cold: { label: "❄️ " + t("leads.cold"), color: "text-sky-400", bg: "bg-sky-500/10" },
  dormant: { label: "💤 " + t("leads.dormant"), color: "text-muted-foreground", bg: "bg-gray-500/10" },
});
const PROBABILITIES = [10, 30, 50, 70, 90];
const LOST_REASON_KEYS = ["price", "competitor", "noBudget", "cancelled", "delayed", "noResponse", "other"];

const PROPERTY_TYPES = ["apartment", "villa", "townhouse", "office", "shop", "land", "other"];

interface Lead {
  id: string; source: string; quality: string; stage: string;
  customer_name: string | null; phone: string | null; email: string | null;
  property_type: string | null; property_size_sqm: number | null;
  location: string | null; budget_range: string | null;
  service_needs: string[] | null; ai_summary: string | null;
  ai_tags: string[] | null; ai_quality: string | null;
  created_at: string; updated_at: string;
  disqualified_candidate: boolean; notes: string | null;
  lead_status: string | null; win_probability: number | null;
  stage_changed_at: string | null;
  decision_maker: string | null; decision_date: string | null; competitor: string | null;
  last_contact_date: string | null; next_followup_date: string | null;
  next_action: string | null; followup_count: number | null;
  lost_reason: string | null; lost_at: string | null;
  sales_manager_review: boolean; recovery_candidate: boolean;
  transfer_candidate: boolean; hold_since: string | null;
  source_platform: string | null; source_channel: string | null;
  campaign_id: string | null; campaign_name: string | null;
  adset_id: string | null; adset_name: string | null;
  ad_id: string | null; ad_name: string | null;
  creative_id: string | null; creative_name: string | null;
  form_id: string | null; form_name: string | null;
  utm_source: string | null; utm_medium: string | null;
  utm_campaign: string | null; utm_content: string | null; utm_term: string | null;
  landing_page: string | null; referrer: string | null;
  first_touch_at: string | null; last_touch_at: string | null;
  assigned_to: string | null; rep_name: string | null;
  quotation_value: number | null;
  project_name: string | null; project_status: string | null;
}

// Reusable inline-edit field wrapper
function InlineField({
  label,
  isEditing,
  children,
  displayValue,
  icon: Icon,
}: {
  label: string;
  isEditing: boolean;
  children: React.ReactNode;
  displayValue: React.ReactNode;
  icon?: React.ElementType;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </Label>
      {isEditing ? (
        children
      ) : (
        <div className="text-sm font-medium min-h-[20px]">{displayValue || <span className="text-muted-foreground italic">—</span>}</div>
      )}
    </div>
  );
}

export default function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const supabase = createClient();
  const { t } = useLanguage();

  const [lead, setLead] = useState<Lead | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Edit mode state
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editForm, setEditForm] = useState({
    customer_name: "",
    phone: "",
    email: "",
    property_type: "",
    notes: "",
  });

  const statusLabels = getStatusLabels(t);

  const fetchLead = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const { data, error: queryError } = await supabase
        .from("leads")
        .select("*")
        .eq("id", id)
        .single();

      if (queryError) throw queryError;
      if (!data) throw new Error("Lead not found");
      setLead(data as Lead);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to load lead";
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [id, supabase]);

  useEffect(() => {
    fetchLead();
  }, [fetchLead]);

  const startEditing = () => {
    if (!lead) return;
    setEditForm({
      customer_name: lead.customer_name ?? "",
      phone: lead.phone ?? "",
      email: lead.email ?? "",
      property_type: lead.property_type ?? "",
      notes: lead.notes ?? "",
    });
    setIsEditing(true);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    if (!lead) return;
    setEditForm({
      customer_name: lead.customer_name ?? "",
      phone: lead.phone ?? "",
      email: lead.email ?? "",
      property_type: lead.property_type ?? "",
      notes: lead.notes ?? "",
    });
  };

  const handleSave = async () => {
    if (!lead) return;
    setSaving(true);
    try {
      await updateLead(lead.id, {
        customer_name: editForm.customer_name.trim() || null,
        phone: editForm.phone.trim() || null,
        email: editForm.email.trim() || null,
        property_type: editForm.property_type || null,
        notes: editForm.notes.trim() || null,
      });

      // Optimistic local update
      setLead((prev) =>
        prev
          ? {
              ...prev,
              customer_name: editForm.customer_name.trim() || null,
              phone: editForm.phone.trim() || null,
              email: editForm.email.trim() || null,
              property_type: editForm.property_type || null,
              notes: editForm.notes.trim() || null,
              updated_at: new Date().toISOString(),
            }
          : prev
      );
      setIsEditing(false);
      toast.success(t("common.saved") || "Changes saved");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to save changes";
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const handleFieldChange = <K extends keyof typeof editForm>(key: K, value: string) => {
    setEditForm((prev) => ({ ...prev, [key]: value }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="animate-pulse text-muted-foreground">{t("common.loading") || "Loading..."}</div>
      </div>
    );
  }

  if (error || !lead) {
    return (
      <ErrorState
        title={t("errors.leadNotFound") || "Lead not found"}
        description={error ?? undefined}
        onRetry={() => fetchLead()}
      />
    );
  }

  const statusInfo = lead.lead_status ? statusLabels[lead.lead_status] : null;

  return (
    <div className="space-y-6">
      <Toaster richColors position="top-right" />

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.back()}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-semibold tracking-tight">
                {lead.customer_name || t("leads.unnamed") || "Unnamed Lead"}
              </h1>
              {statusInfo && (
                <Badge variant="secondary" className={cn("capitalize", statusInfo.bg, statusInfo.color)}>
                  {statusInfo.label}
                </Badge>
              )}
              <Badge variant="outline" className={cn("capitalize", STAGE_COLORS[lead.stage])}>
                {t(`leads.stages.${lead.stage}`) || lead.stage}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              ID: <span className="font-mono">{lead.id.slice(0, 8)}</span>
              {lead.rep_name && <span className="ml-3">· {t("leads.rep") || "Rep"}: {lead.rep_name}</span>}
            </p>
          </div>
        </div>

        {/* Edit / Save / Cancel controls */}
        <div className="flex items-center gap-2">
          {isEditing ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={cancelEditing}
                disabled={saving}
              >
                <X className="h-4 w-4 mr-1.5" />
                {t("common.cancel") || "Cancel"}
              </Button>
              <Button
                size="sm"
                onClick={handleSave}
                disabled={saving}
              >
                <Save className="h-4 w-4 mr-1.5" />
                {saving ? (t("common.saving") || "Saving...") : (t("common.save") || "Save")}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="default" onClick={startEditing}>
              <Pencil className="h-4 w-4 mr-1.5" />
              {t("common.edit") || "Edit"}
            </Button>
          )}
        </div>
      </div>

      {/* Customer Information Card - INLINE EDITABLE */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <User className="h-4 w-4" />
              {t("leads.customerInfo") || "Customer Information"}
            </CardTitle>
            {!isEditing && (
              <Button variant="ghost" size="sm" onClick={startEditing} className="h-7">
                <Pencil className="h-3 w-3 mr-1" />
                {t("common.edit") || "Edit"}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <InlineField
              label={t("leads.customerName") || "Customer Name"}
              isEditing={isEditing}
              icon={User}
              displayValue={lead.customer_name}
            >
              <Input
                value={editForm.customer_name}
                onChange={(e) => handleFieldChange("customer_name", e.target.value)}
                placeholder={t("leads.customerNamePlaceholder") || "Enter customer name"}
                disabled={saving}
              />
            </InlineField>

            <InlineField
              label={t("leads.phone") || "Phone"}
              isEditing={isEditing}
              icon={Phone}
              displayValue={lead.phone}
            >
              <Input
                value={editForm.phone}
                onChange={(e) => handleFieldChange("phone", e.target.value)}
                placeholder="+971 50 XXX XXXX"
                disabled={saving}
              />
            </InlineField>

            <InlineField
              label={t("leads.email") || "Email"}
              isEditing={isEditing}
              icon={MessageSquare}
              displayValue={lead.email}
            >
              <Input
                type="email"
                value={editForm.email}
                onChange={(e) => handleFieldChange("email", e.target.value)}
                placeholder="customer@example.com"
                disabled={saving}
              />
            </InlineField>

            <InlineField
              label={t("leads.propertyType") || "Property Type"}
              isEditing={isEditing}
              icon={Home}
              displayValue={lead.property_type ? (t(`leads.propertyTypes.${lead.property_type}`) || lead.property_type) : null}
            >
              <Select
                value={editForm.property_type}
                onValueChange={(v) => handleFieldChange("property_type", v)}
                disabled={saving}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("leads.selectPropertyType") || "Select property type"} />
                </SelectTrigger>
                <SelectContent>
                  {PROPERTY_TYPES.map((pt) => (
                    <SelectItem key={pt} value={pt}>
                      {t(`leads.propertyTypes.${pt}`) || pt}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </InlineField>
          </div>

          <Separator />

          <InlineField
            label={t("leads.notes") || "Notes"}
            isEditing={isEditing}
            icon={FileText}
            displayValue={
              lead.notes ? (
                <p className="whitespace-pre-wrap text-sm">{lead.notes}</p>
              ) : null
            }
          >
            <Textarea
              value={editForm.notes}
              onChange={(e) => handleFieldChange("notes", e.target.value)}
              placeholder={t("leads.notesPlaceholder") || "Add notes about this lead..."}
              rows={5}
              disabled={saving}
            />
          </InlineField>
        </CardContent>
      </Card>

      {/* Lead Workflow */}
      <LeadWorkflow lead={lead} onUpdate={(updated) => setLead(updated as Lead)} />

      {/* Property Details (read-only display) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Home className="h-4 w-4" />
            {t("leads.propertyDetails") || "Property Details"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {t("leads.location") || "Location"}
              </div>
              <div className="font-medium">{lead.location || "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">
                {t("leads.size") || "Size (sqm)"}
              </div>
              <div className="font-medium">
                {lead.property_size_sqm ? `${lead.property_size_sqm} m²` : "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">
                {t("leads.budget") || "Budget"}
              </div>
              <div className="font-medium">{lead.budget_range || "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                <DollarSign className="h-3 w-3" />
                {t("leads.quotationValue") || "Quotation"}
              </div>
              <div className="font-medium">
                {lead.quotation_value ? `AED ${lead.quotation_value.toLocaleString()}` : "—"}
              </div>
            </div>
          </div>

          {lead.service_needs && lead.service_needs.length > 0 && (
            <>
              <Separator className="my-4" />
              <div>
                <div className="text-xs text-muted-foreground mb-2">{t("leads.serviceNeeds") || "Service Needs"}</div>
                <div className="flex flex-wrap gap-1.5">
                  {lead.service_needs.map((need, idx) => (
                    <Badge key={idx} variant="secondary" className="text-xs">
                      {need}
                    </Badge>
                  ))}
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* AI Insights */}
      {lead.ai_summary && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <WandSparkles className="h-4 w-4" />
              {t("leads.aiInsights") || "AI Insights"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground leading-relaxed">{lead.ai_summary}</p>
            {lead.ai_tags && lead.ai_tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {lead.ai_tags.map((tag, idx) => (
                  <Badge key={idx} variant="outline" className="text-xs">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Timeline & Follow-up */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4" />
            {t("leads.timeline") || "Timeline & Follow-up"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-xs text-muted-foreground mb-1">{t("leads.lastContact") || "Last Contact"}</div>
              <div className="font-medium">
                {lead.last_contact_date ? new Date(lead.last_contact_date).toLocaleDateString() : "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">{t("leads.nextFollowup") || "Next Follow-up"}</div>
              <div className="font-medium">
                {lead.next_followup_date ? new Date(lead.next_followup_date).toLocaleDateString() : "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">{t("leads.followupCount") || "Follow-ups"}</div>
              <div className="font-medium">{lead.followup_count ?? 0}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">{t("leads.nextAction") || "Next Action"}</div>
              <div className="font-medium">{lead.next_action || "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                <Target className="h-3 w-3" />
                {t("leads.winProbability") || "Win Probability"}
              </div>
              <div className="font-medium">
                {lead.win_probability != null ? `${lead.win_probability}%` : "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">{t("leads.decisionMaker") || "Decision Maker"}</div>
              <div className="font-medium">{lead.decision_maker || "—"}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Source & Attribution */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <GitBranch className="h-4 w-4" />
            {t("leads.sourceAttribution") || "Source & Attribution"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-xs text-muted-foreground mb-1">{t("leads.source") || "Source"}</div>
              <div className="font-medium capitalize">{lead.source || "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">{t("leads.platform") || "Platform"}</div>
              <div className="font-medium">{lead.source_platform || "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">{t("leads.channel") || "Channel"}</div>
              <div className="font-medium">{lead.source_channel || "—"}</div>
            </div>
            {lead.campaign_name && (
              <div>
                <div className="text-xs text-muted-foreground mb-1">{t("leads.campaign") || "Campaign"}</div>
                <div className="font-medium">{lead.campaign_name}</div>
              </div>
            )}
            {lead.ad_name && (
              <div>
                <div className="text-xs text-muted-foreground mb-1">{t("leads.ad") || "Ad"}</div>
                <div className="font-medium">{lead.ad_name}</div>
              </div>
            )}
            {lead.form_name && (
              <div>
                <div className="text-xs text-muted-foreground mb-1">{t("leads.form") || "Form"}</div>
                <div className="font-medium">{lead.form_name}</div>
              </div>
            )}
          </div>

          {(lead.utm_source || lead.utm_medium || lead.utm_campaign) && (
            <>
              <Separator className="my-4" />
              <div className="text-xs text-muted-foreground mb-2">UTM Parameters</div>
              <div className="flex flex-wrap gap-1.5 text-xs">
                {lead.utm_source && <Badge variant="outline">source: {lead.utm_source}</Badge>}
                {lead.utm_medium && <Badge variant="outline">medium: {lead.utm_medium}</Badge>}
                {lead.utm_campaign && <Badge variant="outline">campaign: {lead.utm_campaign}</Badge>}
                {lead.utm_content && <Badge variant="outline">content: {lead.utm_content}</Badge>}
                {lead.utm_term && <Badge variant="outline">term: {lead.utm_term}</Badge>}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Tools */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Calculator className="h-4 w-4" />
              {t("leads.quoteCalculator") || "Quote Calculator"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <QuoteCalculator leadId={lead.id} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Wrench className="h-4 w-4" />
              {t("leads.knxDesign") || "KNX Design"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <KnxDesignPanel leadId={lead.id} />
          </CardContent>
        </Card>
      </div>

      {/* Metadata footer */}
      <div className="text-xs text-muted-foreground flex items-center justify-between pt-2">
        <span>
          {t("leads.createdAt") || "Created"}: {new Date(lead.created_at).toLocaleString()}
        </span>
        <span>
          {t("leads.updatedAt") || "Updated"}: {new Date(lead.updated_at).toLocaleString()}
        </span>
      </div>
    </div>
  );
}