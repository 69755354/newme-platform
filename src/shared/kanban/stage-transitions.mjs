export const VALID_STAGE_TRANSITIONS = Object.freeze({
  new: Object.freeze(["contacted", "won", "lost"]),
  contacted: Object.freeze(["requirement_confirmed", "won", "lost"]),
  requirement_confirmed: Object.freeze(["solution_submitted", "won", "lost"]),
  solution_submitted: Object.freeze(["quotation_submitted", "won", "lost"]),
  quotation_submitted: Object.freeze(["negotiation", "won", "lost"]),
  negotiation: Object.freeze(["pending_decision", "won", "lost"]),
  pending_decision: Object.freeze(["won", "lost"]),
  won: Object.freeze([]),
  lost: Object.freeze([]),
});

const TERMINAL_STAGES = new Set(["won", "lost"]);

export function isValidStageTransition(from, to) {
  if (from === to) return true;
  if (TERMINAL_STAGES.has(from)) return false;
  return VALID_STAGE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function getValidStageTransitions(from) {
  if (TERMINAL_STAGES.has(from)) return [];
  return [...(VALID_STAGE_TRANSITIONS[from] ?? [])];
}
