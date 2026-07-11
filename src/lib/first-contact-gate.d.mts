export type FirstContactGateInput = {
  currentStage: string | null;
  nextStage: string;
  contactCount: number;
  quality: string | null;
};
export type FirstContactGateResult = { allowed: boolean; reasons: string[] };
export const ASSESSED_QUALITIES: readonly string[];
export function isAssessedQuality(quality: string | null | undefined): boolean;
export function evaluateFirstContactGate(input: FirstContactGateInput): FirstContactGateResult;
