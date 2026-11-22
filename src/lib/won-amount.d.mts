type Db = { from: (table: string) => unknown };
export type Amount = { value: number; currency: string };
export const MAX_WON_AMOUNT: number;
export function wonAmountForLead(db: Db, leadId: string): Promise<Amount | null>;
export function parseEnteredAmount(raw: unknown): number | null;
export const WON_AMOUNT_REQUIRED: Readonly<{ code: string; error: string; error_zh: string }>;
export function ensureWonAmount(db: Db, leadId: string, enteredAmount: unknown): Promise<
  | { ok: true; amount: Amount; wrote: boolean }
  | { ok: false; code: string; error: string; error_zh: string }
>;
export function revertWonAmount(db: Db, leadId: string, written: number, previous: number | null): Promise<boolean>;
