export const LEAVE_COVER_SWITCH: string;
export const COVER_COLUMNS: string;
export interface CoverProfile { id?: string; is_active?: boolean | null; cover_user_id?: string | null; cover_start?: string | null; cover_end?: string | null }
export function leaveCoverEnabled(env?: Record<string, string | undefined>): boolean;
export function activeCoverId(profile: CoverProfile | null | undefined, now?: Date | number | string): string | null;
export function expandWithCovers(userIds: Array<string | null | undefined>, profiles: CoverProfile[], now?: Date | number | string): string[];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withCoverRecipients(db: any, userIds: Array<string | null | undefined>, options?: { now?: Date; env?: Record<string, string | undefined> }): Promise<string[]>;
export function expandReminderItems<T extends { assigned_to?: string | null }>(items: T[], profiles: CoverProfile[], now?: Date, env?: Record<string, string | undefined>): Array<T & { cover_for?: string }>;
