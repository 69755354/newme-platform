export interface ExtractedField { field: "rooms" | "property_type" | "area_sqm" | "budget_aed" | "renovation" | "next_step"; value: string | number; confidence: number; source_message_id: string }
export function extractLeadFields(messages: Array<{ id: string | number; text: string | null; direction: "inbound" | "outbound" } | null>): { fields: ExtractedField[] };
export function buildFieldDraftNote(result: { fields: ExtractedField[] } | null | undefined): string | null;
