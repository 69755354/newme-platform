import type { Bounds } from "./dubai-time.mjs";

export interface MetricLead {
  id?: string;
  archived?: boolean | null;
  assigned_to?: string | null;
  imported_by?: string | null;
  source?: string | null;
  source_platform?: string | null;
  stage?: string | null;
  final_status?: string | null;
  quotation_value?: number | string | null;
  win_probability?: number | null;
  won_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  last_contact_date?: string | null;
  next_followup_date?: string | null;
  followup_count?: number | null;
  lead_status?: string | null;
  hold_since?: string | null;
  recovery_candidate?: boolean | null;
  transfer_candidate?: boolean | null;
  sales_manager_review?: boolean | null;
  quality?: string | null;
  ai_quality?: string | null;
  [key: string]: unknown;
}

export type QualityBucket = "pending" | "good" | "normal" | "bad" | "unknown";

export interface AssigneeSummary {
  total: number; active: number; won: number; lost: number; contacted: number;
  wonValue: number; pipelineValue: number;
  periodWonCount: number; periodWonValue: number;
  imported: number;
}

export interface LeadSummary {
  total: number; active: number; won: number; lost: number; contacted: number;
  pipelineValue: number; weightedPipelineValue: number;
  newLast7Days: number;
  wonValue: number;
  periodWonCount: number; periodWonValue: number;
  yellowCount: number; redCount: number;
  recoveryCount: number; transferCount: number; reviewCount: number;
  highProbStale: number; pendingStale: number;
  followUpOverdue: number;
  dormant: number; zeroFollowup: number;
  qualityBreakdown: Record<QualityBucket, number>;
  conversionRate: number; contactRate: number;
  stageCounts: Record<string, number>;
  stageValues: Record<string, number>;
  statusCounts: Record<string, number>;
  bySource: Record<string, { total: number; won: number; value: number; pipelineValue: number }>;
  byAssignee: Record<string, AssigneeSummary>;
}

export interface AttributionGroup { total: number; valid: number; quoted: number; won: number; value: number }

export const NEVER_CONTACTED_GRACE_MS: number;
export const STALE_YELLOW_DAYS: number;
export const STALE_RED_DAYS: number;
export const PROCESS_STAGES: readonly string[];
export const OUTCOME_KEYS: readonly string[];
export const QUOTED_STAGES: readonly string[];
export const QUALITY_BUCKETS: readonly QualityBucket[];
export const LEAD_METRIC_COLUMNS: string;
export const ADS_ATTRIBUTION_COLUMNS: string;
export function isCountedLead(lead: MetricLead | null | undefined): boolean;
export function leadOutcome(lead: MetricLead | null | undefined): string | null;
export function isActiveLead(lead: MetricLead | null | undefined): boolean;
export function isWonLead(lead: MetricLead | null | undefined): boolean;
export function isLostLead(lead: MetricLead | null | undefined): boolean;
export function isWonInPeriod(lead: MetricLead | null | undefined, bounds: Bounds): boolean;
export function isContactedLead(lead: MetricLead | null | undefined): boolean;
export function isQuotedLead(lead: MetricLead | null | undefined): boolean;
export function conversionRate(won: number, total: number): number;
export function percentOf(part: number, total: number): number;
export function qualityBucket(lead: MetricLead | null | undefined): QualityBucket;
export function isValidQualityLead(lead: MetricLead | null | undefined): boolean;
export function overdueDays(due: Date | string | number | null | undefined, now?: Date | string | number): number;
export function followUpOverdue(
  lead: MetricLead | null | undefined,
  now?: Date | string | number,
): { overdue: false } | { overdue: true; dueAt: string; days: number };
export function leadSourceKey(lead: MetricLead | null | undefined): string;
export function summarizeLeads(
  rows: readonly MetricLead[] | null | undefined,
  options?: { period?: Bounds | null; now?: Date | string | number },
): LeadSummary;
export function aggregateAttribution(
  rows: readonly MetricLead[] | null | undefined,
  keyOf?: (lead: MetricLead) => string,
): Record<string, AttributionGroup>;
export function totalAttribution(groups: Record<string, AttributionGroup>): AttributionGroup;
export function overdueLeadList<T extends MetricLead>(rows: T[] | null | undefined, now?: Date): Array<{ lead: T; overdueDays: number }>;

export function lostFromStageCounts(
  events: Array<{ lead_id?: string | null; event_data?: unknown; created_at?: string | null }>,
  lostLeadIds: Iterable<string>,
): Record<string, number>;
export function wonLeadValue(lead: MetricLead | null | undefined): number;
export function sourceQualityBreakdown(
  rows: MetricLead[] | null | undefined,
): Array<{ source: string; total: number; good: number; normal: number; pending: number; bad: number; conv_rate: number }>;
