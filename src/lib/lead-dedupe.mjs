// S43 (B8): one rule for "is this form submission the same open customer?", shared by the intake routes.
// Same rule as the S39 Meta form merge in src/lib/meta-lead-ads.mjs (storeMetaLead): an OPEN lead only
// (not archived, not won / lost), matched by email first, then by the phone identity key (050 123 4567,
// 00971..., +971... are one customer), but never when both sides carry an email and the emails differ
// (two people sharing one phone), and never on a junk number (phoneIdentityKey is null for those).
import { phoneIdentityKey } from "./lead-contact.mjs";

export const PUBLIC_LEAD_DEDUPE_SWITCH = "NEWME_PUBLIC_LEAD_DEDUPE_ENABLED";

export function publicLeadDedupeEnabled(env = process.env) {
  return String(env?.[PUBLIC_LEAD_DEDUPE_SWITCH] ?? "").trim().toLowerCase() === "true";
}

const lower = (v) => String(v ?? "").trim().toLowerCase();

/**
 * Pure: pick the open lead a new submission belongs to, or null.
 * @param {Array<{ id: string, phone?: string|null, email?: string|null, archived?: boolean|null, final_status?: string|null }>} candidates
 * @param {{ phone?: string|null, email?: string|null }} contact
 */
export function pickOpenLeadMatch(candidates, { phone, email }) {
  const formEmail = lower(email);
  const key = phoneIdentityKey(phone);
  const open = (candidates ?? []).filter((c) => c && !c.archived && !c.final_status);
  if (formEmail) {
    const byEmail = open.find((c) => lower(c.email) === formEmail);
    if (byEmail) return byEmail;
  }
  if (!key) return null;
  return open.find((c) => {
    if (phoneIdentityKey(c.phone) !== key) return false;
    const stored = lower(c.email);
    return !(formEmail && stored && formEmail !== stored);
  }) ?? null;
}

/**
 * Look the open lead up. Returns { lead, error }: a database failure is reported, never thrown, because an
 * intake must store the submission whatever happens here (the caller falls back to inserting a new lead).
 * @param {{ from: (table: string) => any }} db
 */
export async function findOpenLeadByContact(db, { phone, email }, columns = "id, phone, email, archived, final_status, assigned_to") {
  const formEmail = lower(email);
  const key = phoneIdentityKey(phone);
  if (!formEmail && !key) return { lead: null, error: null };
  const rows = [];
  if (formEmail) {
    const byEmail = await db.from("leads").select(columns).eq("email", formEmail).eq("archived", false).is("final_status", null)
      .order("created_at", { ascending: true }).limit(20);
    if (byEmail.error) return { lead: null, error: "lead_lookup_failed" };
    rows.push(...(byEmail.data ?? []));
  }
  if (key) {
    // Stored spellings differ in separators: the candidate filter allows anything between the last seven
    // digits ("%4%5%6%7%..."); the exact comparison is done on the identity key in pickOpenLeadMatch.
    const pattern = `%${key.slice(-7).split("").join("%")}%`;
    const byPhone = await db.from("leads").select(columns).ilike("phone", pattern).eq("archived", false).is("final_status", null)
      .order("created_at", { ascending: true }).limit(500);
    if (byPhone.error) return { lead: null, error: "lead_lookup_failed" };
    rows.push(...(byPhone.data ?? []));
  }
  return { lead: pickOpenLeadMatch(rows, { phone, email }), error: null };
}
