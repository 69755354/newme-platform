export interface FollowupConfig {
  timeZone: string; weekendDays: number[]; holidays: string[]; contactMergeMinutes: number; windowWorkingDays: number;
  firstResponseAtRiskMinutes: number; firstResponseOverdueMinutes: number; silenceAtRiskHours: number; silenceOverdueHours: number;
  abandonMaxContacts: number; abandonSilenceHours: number;
}
export type FollowupState = "normal" | "at_risk" | "overdue";
export interface FollowupEvent { direction: "inbound" | "outbound"; occurredAt: number | string }
export interface FollowupResult {
  firstInboundAt: string | null; firstReplyAt: string | null; firstResponseMinutes: number | null;
  contactCount5wd: number; lastOutboundAt: string | null; state: FollowupState; abandonRisk: boolean; reasons: string[];
}
export const DEFAULT_FOLLOWUP_CONFIG: Readonly<FollowupConfig>;
export function resolveFollowupConfig(overrides?: Partial<FollowupConfig>): FollowupConfig;
export function isWorkingDay(ms: number, config?: FollowupConfig): boolean;
export function workingElapsedMs(fromMs: number, toMs: number, config?: FollowupConfig): number;
export function windowBounds(firstInboundMs: number, config?: FollowupConfig): { startMs: number; endMs: number };
export function mergeContacts(outboundMs: number[], mergeMinutes?: number): number[];
export function evaluateFollowup(input: { events: FollowupEvent[]; now: number | string; config?: FollowupConfig }): FollowupResult;
export function buildFollowupNote(input: { result: FollowupResult; previous: { state: FollowupState; abandonRisk: boolean } | null; now: number | string; config?: FollowupConfig; leadName?: string }):
  { note: string; notificationType: "warning" | "reminder"; title: string; body: string } | null;
