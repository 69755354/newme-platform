export type FirstContactGateInput = {
  currentStage: string | null;
  nextStage: string;
  contactCount: number;
  quality: string | null;
};
export type FirstContactGateResult = { allowed: boolean; reasons: string[] };
export type ContactRecord = {
  contact_time?: string | null;
  contact_result?: string | null;
};
export const ASSESSED_QUALITIES: readonly string[];
export function isAssessedQuality(quality: string | null | undefined): boolean;
export function isCompleteContact(contact: ContactRecord): boolean;
export function evaluateFirstContactGate(input: FirstContactGateInput): FirstContactGateResult;
