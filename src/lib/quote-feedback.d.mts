type Db = { from: (table: string) => any };
type Enqueue = (db: any, leadId: string, key: string) => Promise<unknown>;
export const QUOTED_PROGRESS_KEY: string;
export function isFrozenFinalLead(lead: { final_status?: string | null; stage?: string | null } | null | undefined): boolean;
export function enqueueQuotedFeedback(
  db: Db, leadId: string, amount: number,
  enqueuers: { form: Enqueue; whatsapp: Enqueue; website: Enqueue },
): Promise<string[]>;
