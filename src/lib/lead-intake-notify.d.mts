export const INTAKE_QUEUE_ROLES: readonly string[];
export const INTAKE_MAX_AGE_MS: number;
export interface IntakeLead { id: string; customer_name?: string | null; assigned_to?: string | null; created_at?: string | null }
export interface IntakeNotifyResult { created: number; skipped: number; reason?: string }
export function intakeNotificationRows(lead: IntakeLead, recipientIds: string[], assigned: boolean): Array<Record<string, string>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function notifyNewLead(db: any, lead: IntakeLead, options?: { now?: number; maxAgeMs?: number }): Promise<IntakeNotifyResult>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function notifyNewLeadSafe(db: any, lead: IntakeLead, options?: { now?: number; maxAgeMs?: number; onError?: (code: string) => void }): Promise<IntakeNotifyResult>;
