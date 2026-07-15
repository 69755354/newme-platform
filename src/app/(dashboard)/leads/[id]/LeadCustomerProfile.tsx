"use client";

// Left column — Customer Profile. All editable identity / contact / project
// fields live here. Inline edits are driven by render closures owned by
// page.tsx (preserving the page-wide single-edit-at-a-time behaviour); selects
// call onUpdateField directly, matching the previous Details tab.

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn, fmtDubai } from "@/lib/utils";
import { User, MessageCircle, ExternalLink } from "lucide-react";
import type { Lead, RenderInlineEdit, RenderDateEdit } from "./types";

// Source dropdown options — keys match translations.sourceLabels and the values
// persisted on leads.source.
const SOURCE_OPTIONS = ["ins", "fb", "show_room", "whatsapp", "website", "offline", "referral", "other", "unknown"];

interface Props {
  lead: Lead;
  users: any[];
  onUpdateField: (field: string, value: any, eventType?: string, eventDesc?: string) => void;
  onReassign: (userId: string) => void;
  renderInlineEdit: RenderInlineEdit;
  renderDateEdit: RenderDateEdit;
  t: (key: string) => string;
  showSalesDropdown: boolean;
  setShowSalesDropdown: (v: boolean) => void;
  reassigning: boolean;
  transferHistory: any[];
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="text-muted-foreground text-xs">{label}</Label>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

export default function LeadCustomerProfile({
  lead,
  users,
  onUpdateField,
  onReassign,
  renderInlineEdit,
  renderDateEdit,
  t,
  showSalesDropdown,
  setShowSalesDropdown,
  reassigning,
  transferHistory,
}: Props) {
  // WhatsApp deep link from the phone digits (strip everything non-numeric).
  const phoneDigits = (lead.phone || "").replace(/[^\d]/g, "");
  const whatsappHref = phoneDigits ? `https://wa.me/${phoneDigits}` : null;

  return (
    <Card className="overflow-visible border-border bg-card shadow-sm">
      <CardHeader className="border-b border-border/70 pb-3">
        <CardTitle className="text-base text-foreground flex items-center gap-2">
          <User className="w-4 h-4 text-copper-400" /> {t("leadDetail.customerProfile")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid grid-cols-1 gap-3">
          <Field label={t("leadDetail.customerName")}>
            {renderInlineEdit("customer_name", t("leadDetail.customerName"))}
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label={t("leadDetail.phone")}>
              {renderInlineEdit("phone", t("leadDetail.phone"))}
            </Field>
            <Field label={t("leadDetail.whatsapp")}>
              {whatsappHref ? (
                <a
                  href={whatsappHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-flex items-center gap-1.5 text-emerald-400 hover:text-emerald-300 text-xs"
                >
                  <MessageCircle className="w-3.5 h-3.5" />
                  {t("leadDetail.whatsappChat")}
                  <ExternalLink className="w-3 h-3" />
                </a>
              ) : (
                <p className="text-gray-600 text-xs mt-1">{t("leadDetail.placeholderClickToFill")}</p>
              )}
            </Field>
          </div>

          <Field label={t("leadDetail.email")}>
            {renderInlineEdit("email", t("leadDetail.email"))}
          </Field>

          <Field label={t("leadDetail.address")}>
            {renderInlineEdit("location", t("leadDetail.address"))}
          </Field>

          {/* Source — editable dropdown */}
          <Field label={t("leadDetail.source")}>
            <Select
              value={lead.source || ""}
              onValueChange={(v) =>
                onUpdateField("source", v, "note_added", `${t("leadDetail.source")}: ${t(`sourceLabels.${v}`)}`)
              }
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {SOURCE_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(`sourceLabels.${s}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            {/* Project Type */}
            <Field label={t("leadDetail.projectType")}>
              <Select
                value={lead.project_type || ""}
                onValueChange={(v) =>
                  onUpdateField("project_type", v || null, "note_added", `${t("leadDetail.projectType")}: ${v}`)
                }
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="villa">{t("leadDetail.projectType_villa")}</SelectItem>
                  <SelectItem value="apartment">{t("leadDetail.projectType_apartment")}</SelectItem>
                  <SelectItem value="developer">{t("leadDetail.projectType_developer")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            {/* Project Status */}
            <Field label={t("leadDetail.projectStatus")}>
              <Select
                value={lead.project_status || ""}
                onValueChange={(v) =>
                  onUpdateField("project_status", v || null, "note_added", `${t("leadDetail.projectStatus")}: ${v}`)
                }
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="在建">{t("leadDetail.underConstruction")}</SelectItem>
                  <SelectItem value="翻新">{t("leadDetail.renovation")}</SelectItem>
                  <SelectItem value="毛坯">{t("leadDetail.bareShell")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label={t("leadDetail.emirate")}>
              {renderInlineEdit("emirate", t("leadDetail.emirate"))}
            </Field>
            <Field label={t("leadDetail.areaLocality")}>
              {renderInlineEdit("area", t("leadDetail.areaLocality"))}
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label={t("leadDetail.customerBudget")}>
              {renderInlineEdit("customer_budget", t("leadDetail.customerBudget"))}
            </Field>
            <Field label={t("leadDetail.expectedSignDate")}>
              {renderDateEdit("expected_sign_date", t("leadDetail.expectedSignDate"))}
            </Field>
          </div>
        </div>

        {/* Creator info — read-only with created_at */}
        {lead.created_by && (
          <div className="border-t border-border pt-3 space-y-1.5">
            <Field label={t("leadDetail.createdBy")}>
              <span className="text-sm">{lead.creator_name || "—"}</span>
            </Field>
            {lead.created_at && (
              <Field label={t("leadDetail.createdAt") || "Created"}>
                <span className="text-xs text-muted-foreground">
                  {fmtDubai(lead.created_at, { locale: "zh-CN", hour: "2-digit", minute: "2-digit" })}
                </span>
              </Field>
            )}
          </div>
        )}

        {/* Transfer history */}
        {transferHistory.length > 0 && (
          <div className="border-t border-border pt-3 space-y-2">
            <span className="text-muted-foreground text-xs font-medium">{t("leadDetail.transferHistory") || "Transfer History"}</span>
            {transferHistory.slice(0, 5).map((tr: any, i: number) => (
              <div key={tr.id || i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                <span className="text-[10px] mt-0.5 shrink-0">→</span>
                <div>
                  <span>{tr.description || (tr.operator?.full_name ? `Reassigned by ${tr.operator.full_name}` : "Reassigned")}</span>
                  <span className="block text-[10px] opacity-60">
                    {fmtDubai(tr.created_at, { locale: "zh-CN", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Owner — assigned_to display + reassign dropdown */}
        <div className="border-t border-border pt-3">
          <div className="relative flex items-center justify-between">
            <span className="text-muted-foreground text-xs">{t("leadDetail.owner")}</span>
            <button
              onClick={() => setShowSalesDropdown(!showSalesDropdown)}
              disabled={reassigning}
              className="flex items-center gap-1.5 text-foreground text-sm hover:text-copper-400 transition-colors disabled:opacity-50"
            >
              <User className="w-3.5 h-3.5" />
              <span>
                {lead.rep_name ||
                  users.find((u) => u.id === lead.assigned_to)?.full_name ||
                  "—"}
              </span>
              <svg
                className={cn("w-3 h-3 transition-transform", showSalesDropdown && "rotate-180")}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {showSalesDropdown && (
              <div className="absolute top-full right-0 mt-1 w-56 z-50 bg-muted border border-border rounded-lg shadow-xl py-1 max-h-48 overflow-y-auto">
                {reassigning && (
                  <div className="px-3 py-2 text-xs text-muted-foreground">{t("leadDetail.reassigning")}</div>
                )}
                {users.map((u) => (
                  <button
                    key={u.id}
                    onClick={() => onReassign(u.id)}
                    className={cn(
                      "w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-muted transition-colors",
                      lead.assigned_to === u.id ? "text-copper-400" : "text-foreground"
                    )}
                  >
                    <span
                      className={cn(
                        "w-2 h-2 rounded-full",
                        lead.assigned_to === u.id ? "bg-copper-400" : "bg-gray-600"
                      )}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="truncate">{u.full_name || u.email}</p>
                      <p className="text-[10px] text-muted-foreground">{u.role}</p>
                    </div>
                  </button>
                ))}
                {users.length === 0 && (
                  <p className="px-3 py-2 text-xs text-muted-foreground">{t("leadDetail.noUsers")}</p>
                )}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
