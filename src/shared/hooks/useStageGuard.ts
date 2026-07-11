"use client";

import { useCallback } from "react";
import {
  getValidStageTransitions,
  isValidStageTransition,
} from "@/shared/kanban/stage-transitions.mjs";

export { PIPELINE_STAGES as STAGES } from "@/shared/kanban/types";
export type { StageKey } from "@/shared/kanban/types";

export function useStageGuard() {
  const isValidTransition = useCallback(
    (from: string, to: string): boolean => isValidStageTransition(from, to),
    [],
  );

  const getValidTransitions = useCallback(
    (from: string): string[] => getValidStageTransitions(from),
    [],
  );

  return { isValidTransition, getValidTransitions };
}

export { getValidStageTransitions, isValidStageTransition };
