"use client";

// S3 #4 — shown when POST /api/leads answers DUPLICATE_LEAD. Admin/boss/
// operator see the existing lead(s) with a link and may create anyway with a
// recorded reason. A salesperson sees a "possible duplicate" warning with no
// details of leads they cannot see, links only to their own, and may create
// after giving a reason; the lead then goes to the admin/operator review queue.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLanguage } from "@/lib/i18n/LanguageContext";

export interface DuplicateSummary {
  id: string | null;
  customer_name: string | null;
  archived: boolean;
  visible: boolean;
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
  const { t } = useLanguage();
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState(false);
  return (
    <div role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm space-y-2">
      <p className="font-semibold text-amber-300">{t("leadFlow.duplicate.title")}</p>
      {reviewRequired ? (
        <p className="text-muted-foreground">{t("leadFlow.duplicateReview.salesWarning")}</p>
      ) : (
        <p className="text-muted-foreground">{t("leadFlow.duplicate.body")}</p>
      )}
      <ul className="space-y-1">
        {duplicates.filter((lead) => lead.visible && lead.id).map((lead) => (
          <li key={lead.id!} className="break-words">
            <a href={`/leads/${lead.id}`} target="_blank" rel="noopener noreferrer" className="text-copper-400 underline">
              {lead.customer_name || t("leadFlow.duplicate.open")}
            </a>
            {lead.archived && <span className="ml-2 text-xs text-muted-foreground">({t("leadFlow.duplicate.archived")})</span>}
          </li>
        ))}
      </ul>
      {canOverride ? (
        <div className="space-y-1.5 pt-1">
          <label className="text-xs text-muted-foreground">{t(reviewRequired ? "leadFlow.duplicateReview.reasonLabel" : "leadFlow.duplicate.overrideReasonLabel")}</label>
          <Input
            value={reason}
            maxLength={500}
            onChange={(e) => { setReason(e.target.value); setReasonError(false); }}
            placeholder={t("leadFlow.duplicate.overrideReasonPlaceholder")}
            className="h-9"
          />
          {reasonError && <p className="text-xs text-red-400">{t("leadFlow.duplicate.overrideReasonRequired")}</p>}
          <Button
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={() => {
              if (reason.trim().length < 3) { setReasonError(true); return; }
              onOverride(reason.trim());
            }}
          >
            {t("leadFlow.duplicate.overrideConfirm")}
          </Button>
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
