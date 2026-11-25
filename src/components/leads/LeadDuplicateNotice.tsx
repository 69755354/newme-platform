"use client";

// S3 #4 — shown when POST /api/leads answers DUPLICATE_LEAD. Admin/boss/
// operator see the existing lead(s) with a link and may create anyway with a
// recorded reason. A salesperson sees a "possible duplicate" warning with no
// details of leads they cannot see, links only to their own, and may create
// after giving a reason; the lead then goes to the admin/operator review queue.
// S41 (F13): a visible duplicate shows "owner · stage · last contact" and two
// clear buttons, "open existing lead" / "create anyway (give a reason)"; a lead
// the viewer may not see says only that a colleague is already following up.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { translatedOrRaw } from "@/lib/chart-labels.mjs";
import { formatShortDate } from "@/lib/display-format.mjs";
import { useLanguage } from "@/lib/i18n/LanguageContext";

export interface DuplicateSummary {
  id: string | null;
  customer_name: string | null;
  archived: boolean;
  visible: boolean;
  /** S41: present only on visible duplicates. */
  assigned_to_name?: string | null;
  stage?: string | null;
  last_contact_date?: string | null;
}

export interface CreateLeadErrorState {
  fieldErrors: Record<string, string>;
  duplicates: DuplicateSummary[] | null;
  canOverride: boolean;
  reviewRequired?: boolean;
}

const FIELD_MESSAGE: Record<string, Record<string, string>> = {
  customer_name: { required: "leadFlow.validation.nameRequired", too_long: "leadFlow.validation.nameTooLong" },
  phone: { invalid: "leadFlow.validation.phoneInvalid" },
  email: { invalid: "leadFlow.validation.emailInvalid" },
  contact: { required: "leadFlow.validation.contactRequired" },
  location: { too_long: "leadFlow.validation.locationTooLong" },
  notes: { too_long: "leadFlow.validation.notesTooLong" },
};

export function leadFieldErrorKey(field: string, code: string): string {
  return FIELD_MESSAGE[field]?.[code] ?? "leadFlow.validation.fieldInvalid";
}

export function LeadDuplicateNotice({
  duplicates,
  canOverride,
  reviewRequired = false,
  submitting,
  onOverride,
}: {
  duplicates: DuplicateSummary[];
  canOverride: boolean;
  reviewRequired?: boolean;
  submitting: boolean;
  onOverride: (reason: string) => void;
}) {
  const { t, lang } = useLanguage();
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState(false);
  const [showReason, setShowReason] = useState(false);
  const visible = duplicates.filter((lead) => lead.visible && lead.id);
  const hidden = duplicates.length - visible.length;
  const detailLine = (lead: DuplicateSummary) => {
    const parts: string[] = [];
    if (lead.assigned_to_name) parts.push(`${t("s41.duplicate.owner")}: ${lead.assigned_to_name}`);
    if (lead.stage) parts.push(`${t("s41.duplicate.stage")}: ${translatedOrRaw(t, `stageLabels.${lead.stage}`, lead.stage)}`);
    parts.push(`${t("s41.duplicate.lastContact")}: ${lead.last_contact_date ? formatShortDate(lead.last_contact_date, lang === "zh" ? "zh" : "en") : t("s41.duplicate.never")}`);
    return parts.join(" · ");
  };
  return (
    <div role="alert" data-testid="duplicate-notice" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm space-y-2">
      <p className="font-semibold text-amber-700">{t("leadFlow.duplicate.title")}</p>
      {hidden > 0 && (
        <p className="text-muted-foreground">{t("s41.duplicate.colleagueFollowing")}</p>
      )}
      {visible.length > 0 && !reviewRequired && (
        <p className="text-muted-foreground">{t("leadFlow.duplicate.body")}</p>
      )}
      {visible.length > 0 && (
        <ul className="space-y-2">
          {visible.map((lead) => (
            <li key={lead.id!} className="rounded-md border border-border/60 bg-background/60 p-2 break-words">
              <p className="font-medium text-foreground">
                {lead.customer_name || t("s41.duplicate.existing")}
                {lead.archived && <span className="ml-2 text-xs text-muted-foreground">({t("leadFlow.duplicate.archived")})</span>}
              </p>
              <p className="text-xs text-muted-foreground">{detailLine(lead)}</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-2 min-h-9"
                data-testid="duplicate-open-existing"
                onClick={() => router.push(`/leads/${lead.id}`)}
              >
                {t("s41.duplicate.openExisting")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {canOverride ? (
        <div className="space-y-1.5 pt-1">
          {!showReason ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-9"
              data-testid="duplicate-create-anyway"
              disabled={submitting}
              onClick={() => setShowReason(true)}
            >
              {t("s41.duplicate.createAnyway")}
            </Button>
          ) : (
            <>
              <label className="text-xs text-muted-foreground">{t(reviewRequired ? "leadFlow.duplicateReview.reasonLabel" : "leadFlow.duplicate.overrideReasonLabel")}</label>
              <Input
                value={reason}
                maxLength={500}
                autoFocus
                onChange={(e) => { setReason(e.target.value); setReasonError(false); }}
                placeholder={t("leadFlow.duplicate.overrideReasonPlaceholder")}
                className="h-9"
              />
              {reasonError && <p className="text-xs text-red-500">{t("leadFlow.duplicate.overrideReasonRequired")}</p>}
              <Button
                type="button"
                variant="outline"
                className="min-h-9"
                disabled={submitting}
                onClick={() => {
                  if (reason.trim().length < 3) { setReasonError(true); return; }
                  onOverride(reason.trim());
                }}
              >
                {t("leadFlow.duplicate.overrideConfirm")}
              </Button>
            </>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t("leadFlow.duplicate.salesBlocked")}</p>
      )}
    </div>
  );
}

/** POST /api/leads and fold the answer into what the form shows. */
export async function submitNewLead(
  payload: Record<string, unknown>,
  overrideReason?: string,
): Promise<{ ok: true; id: string; warnings: string[] } | { ok: false; state: CreateLeadErrorState | null; status?: number }> {
  const response = await fetch("/api/leads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(overrideReason ? { ...payload, duplicateOverride: { reason: overrideReason } } : payload),
  });
  const json = await response.json().catch(() => ({}));
  if (response.ok && typeof json.id === "string") {
    return { ok: true, id: json.id, warnings: Array.isArray(json.warnings) ? json.warnings : [] };
  }
  if (json.code === "VALIDATION_FAILED" && json.errors) {
    return { ok: false, state: { fieldErrors: json.errors, duplicates: null, canOverride: false } };
  }
  if (Array.isArray(json.duplicates)) {
    return {
      ok: false,
      state: {
        fieldErrors: {},
        duplicates: json.duplicates,
        canOverride: json.canOverride === true,
        reviewRequired: json.reviewRequired === true,
      },
    };
  }
  return { ok: false, state: null, status: response.status };
}
