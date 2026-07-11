export const VALID_STAGE_TRANSITIONS: Readonly<Record<string, readonly string[]>>;
export function isValidStageTransition(from: string, to: string): boolean;
export function getValidStageTransitions(from: string): string[];
