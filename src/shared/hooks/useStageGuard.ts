"use client";

import { useCallback } from "react";
import { TERMINAL_STAGES } from "@/shared/kanban/types";

export { PIPELINE_STAGES as STAGES } from "@/shared/kanban/types";
export type { StageKey } from "@/shared/kanban/types";

// Valid transitions map: from → set of allowed targets
// Business rules:
// - Won/Lost are terminal: no outbound transitions
// - Forward-only for non-admin (1 step at a time)
// - Any stage can go to Won or Lost (closing the deal)
const VALID_TRANSITIONS: Record<string, string[]> = {
  new: ["contacted", "won", "lost"],
  contacted: ["requirement_confirmed", "won", "lost"],
  requirement_confirmed: ["solution_submitted", "won", "lost"],
  solution_submitted: ["quotation_submitted", "won", "lost"],
  quotation_submitted: ["negotiation", "won", "lost"],
  negotiation: ["pending_decision", "won", "lost"],
  pending_decision: ["won", "lost"],
  won: [],   // Terminal — no outbound transitions
  lost: [],  // Terminal — no outbound transitions
};

// ─── useStageGuard Hook ───
// Provides stage transition validation logic for the CRM pipeline.
// Use this to guard drag-drop and manual stage changes.
export function useStageGuard() {
  /**
   * Check if a transition from one stage to another is valid.
   * Returns true if valid, false otherwise.
   */
  const isValidTransition = useCallback((from: string, to: string): boolean => {
    // Same stage is always valid (no-op)
    if (from === to) return true;

    // Terminal stages cannot transition out
    if (TERMINAL_STAGES.has(from)) return false;

    // Check if target is in the allowed transitions
    const allowed = VALID_TRANSITIONS[from];
    if (!allowed) return false;

    return allowed.includes(to);
  }, []);

  /**
   * Get all valid target stages from a given source stage.
   * Returns an array of stage keys that are valid transitions.
   */
  const getValidTransitions = useCallback((from: string): string[] => {
    if (TERMINAL_STAGES.has(from)) return [];
    return VALID_TRANSITIONS[from] || [];
  }, []);

  return {
    isValidTransition,
    getValidTransitions,
  };
}

// ─── Standalone helpers (for use outside React) ───
export function isValidStageTransition(from: string, to: string): boolean {
  if (from === to) return true;
  if (TERMINAL_STAGES.has(from)) return false;
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

export function getValidStageTransitions(from: string): string[] {
  if (TERMINAL_STAGES.has(from)) return [];
  return VALID_TRANSITIONS[from] || [];
}
