export declare const LEAD_FIELD_LIMITS: Readonly<{
  customer_name: number; phone: number; email: number; location: number; notes: number; override_reason: number;
}>;
export declare const LEAD_NAME_MIN_LENGTH: number;
export type PhoneResult = { ok: true; e164: string } | { ok: false; code: "phone_empty" | "invalid_phone" };
export function normalizePhone(raw: unknown): PhoneResult;
export function phoneMatchKey(raw: unknown): string | null;
export function whatsappHref(raw: unknown): string | null;
export function telHref(raw: unknown): string | null;
export function normalizeEmail(raw: unknown): { ok: true; email: string } | { ok: false; code: "email_empty" | "invalid_email" };
export type NewLeadValue = {
  customer_name: string; phone: string | null; email: string | null; location: string | null; notes: string | null;
};
export type NewLeadErrors = Partial<Record<"customer_name" | "phone" | "email" | "contact" | "location" | "notes", string>>;
export function validateNewLead(input: unknown): { ok: true; value: NewLeadValue } | { ok: false; errors: NewLeadErrors };
export function validateLeadFieldEdit(field: string, value: unknown): { ok: true; value: unknown } | { ok: false; code: string };
export function matchDuplicateLeads<T extends { id: string; phone?: string | null; email?: string | null }>(
  rows: T[] | null | undefined,
  query: { phone?: string | null; email?: string | null; excludeId?: string },
): Array<T & { matched_on: "phone" | "email" | "phone_email" }>;
export function phoneSearchSuffix(phone: unknown): string | null;
