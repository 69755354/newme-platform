import type { SupabaseClient } from "@supabase/supabase-js";
import { matchDuplicateLeads, normalizeEmail, phoneSearchSuffix } from "@/lib/lead-contact.mjs";

/**
 * S3 #4 — find existing leads that are the same customer (same phone in any
 * stored format, or same email). Runs with a client that sees every lead
 * (service role) because a duplicate held by another salesperson is still a
 * duplicate; callers decide how much of it the requester may see.
 *
 * Candidate rows are fetched with parameterised filters only: the last four
 * digits of the number (digits, never a wildcard) and the exact email,
 * case-insensitively. The final comparison is done in code on the E.164 form.
 */
export interface DuplicateLead {
  id: string;
  customer_name: string | null;
  phone: string | null;
  email: string | null;
  assigned_to: string | null;
  archived: boolean | null;
  matched_on: "phone" | "email" | "phone_email";
}

const COLUMNS = "id, customer_name, phone, email, assigned_to, archived";

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export async function findDuplicateLeads(
  db: SupabaseClient,
  query: { phone?: string | null; email?: string | null; excludeId?: string },
): Promise<DuplicateLead[]> {
  const rows: Array<Omit<DuplicateLead, "matched_on">> = [];
  const suffix = query.phone ? phoneSearchSuffix(query.phone) : null;
  if (suffix) {
    const { data, error } = await db.from("leads").select(COLUMNS).ilike("phone", `%${suffix}`).limit(1000);
    if (error) throw new Error("duplicate_lookup_failed");
    rows.push(...((data ?? []) as typeof rows));
  }
  const email = query.email ? normalizeEmail(query.email) : null;
  if (email?.ok) {
    const { data, error } = await db.from("leads").select(COLUMNS).ilike("email", escapeLike(email.email)).limit(50);
    if (error) throw new Error("duplicate_lookup_failed");
    rows.push(...((data ?? []) as typeof rows));
  }
  return matchDuplicateLeads(rows, { phone: query.phone, email: query.email, excludeId: query.excludeId })
    .slice(0, 10) as DuplicateLead[];
}

/**
 * What a requester may see about each duplicate. Admin, boss and operator see
 * every lead already; a salesperson only learns the name and link of a lead
 * they own, otherwise only that a colleague holds the customer.
 */
export function presentDuplicates(duplicates: DuplicateLead[], viewer: { id: string; role: string }) {
  const seesAll = ["admin", "boss", "operator"].includes(viewer.role);
  return duplicates.map((lead) => (seesAll || lead.assigned_to === viewer.id)
    ? {
      id: lead.id,
      customer_name: lead.customer_name,
      archived: Boolean(lead.archived),
      matched_on: lead.matched_on,
      visible: true,
    }
    : { id: null, customer_name: null, archived: Boolean(lead.archived), matched_on: lead.matched_on, visible: false });
}
