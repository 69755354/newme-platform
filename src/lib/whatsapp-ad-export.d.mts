export const WA_EXPORT_ROLES: readonly string[];
export const WA_EXPORT_HEADER: readonly string[];
export function canExportWhatsAppAdLeads(role: unknown): boolean;
export function csvCell(value: unknown, options?: { phone?: boolean }): string;
export function feedbackSummary(events: Array<{ event_name: string; status: string }>): string;
export function buildWhatsAppAdExportCsv(
  leads: Array<{ id: string; phone: string | null; ctwa_clid: string | null; ad_id: string | null; created_at: string | null; stage: string | null; final_status: string | null }>,
  events: Array<{ lead_id: string; event_name: string; status: string }>,
): string;
