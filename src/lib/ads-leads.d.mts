export const ADS_WINDOW_DAYS: readonly number[];
export const ADS_DEFAULT_WINDOW_DAYS: number;
export const ADS_MAX_WINDOW_DAYS: number;
export const ADS_STALE_AFTER_DAYS: number;
export const UNCATEGORIZED: string;

type AdFields = {
  ad_id?: string | null; ad_name?: string | null; campaign_id?: string | null; campaign_name?: string | null;
  adset_id?: string | null; adset_name?: string | null; utm_campaign?: string | null; meta_campaign?: string | null;
  source?: string | null; source_platform?: string | null; created_at?: string | null;
};

export function isAdLead(lead: unknown): boolean;
export function buildAdNameMap(leads: AdFields[]): Map<string, string>;
export function adLabel(adId: string | null | undefined, name: string | null | undefined): string;
export function attributionGroup(
  lead: AdFields,
  mode: string,
  names?: Map<string, string>,
): { key: string; label: string | null };
export function dubaiWeekStartKey(value: string | Date | number): string | null;
export function resolveAdsWindow(input?: {
  days?: string | number | null; since?: string | null; until?: string | null; now?: Date;
}): { since: string; until: string; startInstant: Date; endInstant: Date } | { error: string };
export function spendFreshness(
  lastSpendDate: string | null | undefined, now?: Date, limit?: number,
): { last_date: string | null; days_old: number | null; stale: boolean };
export function costPerLead(spend: number | null | undefined, leads: number): number | null;
export function weeklyLeadCost(
  spendRows: Array<{ spend_date?: string | null; amount?: unknown }>,
  leads: Array<{ created_at?: string | null }>,
): Array<{ week_start: string; week_end: string; spend: number | null; leads: number; cpl: number | null }>;
