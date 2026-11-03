export interface Bounds { start: Date; end: Date }
export const DUBAI_TIME_ZONE: "Asia/Dubai";
export const DUBAI_OFFSET_MS: number;
export function dubaiMidnight(year: number, monthIndex: number, day: number): Date;
export function dubaiDateKey(value?: Date | string | number): string | null;
export function dubaiMonthKey(value?: Date | string | number): string | null;
export function isMonthKey(value: unknown): value is string;
export function dubaiDayBounds(value?: Date | string | number): Bounds;
export function dubaiWeekBounds(value?: Date | string | number): Bounds;
export function dubaiMonthBounds(monthKey: string): Bounds;
export function inBounds(value: Date | string | number | null | undefined, bounds: Bounds | null | undefined): boolean;
export function dubaiDaysBetween(from: Date | string | number | null | undefined, to?: Date | string | number): number | null;
export function addDaysToDateKey(dateKey: string, days: number): string;
export function recentDubaiMonthKeys(count: number, value?: Date | string | number): string[];
export function dubaiMonthElapsedPct(monthKey: string, value?: Date | string | number): number;
export interface DubaiWeek { year: number; week: number; start: Date; end: Date; startKey: string; endKey: string }
export function isoWeekOfDateKey(dateKey: string): { year: number; week: number };
export function recentDubaiWeeks(count: number, value?: Date | string | number): DubaiWeek[];
export function inWeek(value: string | Date | number | null | undefined, week: DubaiWeek): boolean;
