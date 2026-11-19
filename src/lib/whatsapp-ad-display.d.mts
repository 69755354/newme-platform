export const WHATSAPP_AD_FILTER: "whatsapp_ad";
type LeadLike = { ctwa_clid?: string | null; source_channel?: string | null } | null | undefined;
export function isWhatsAppAdLead(lead: LeadLike): boolean;
export function isWhatsAppDirectLead(lead: LeadLike): boolean;
export function firstResponseSeconds(firstInboundAt: string | null | undefined, firstReplyAt: string | null | undefined): number | null;
export function durationParts(seconds: number): { unit: "minutes" | "hours" | "days"; n: number } | null;
