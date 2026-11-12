export declare const MILESTONE_STAGE: Readonly<Record<string, string>>;
export declare const STAGE_ORDER: readonly string[];
export declare function stageStepKey(leadId: string, milestoneKey: string, nextStage: string): string;
export declare function planStageStep(input: {
  stage: string | null;
  finalStatus: string | null;
  milestoneKey: string;
  quality: string | null;
  hasCompleteContact: boolean;
  nextAction: string | null;
  nextFollowupDate: string | null;
}): { next: string } | { next: null; reason: string | null };
export interface StageAdvanceResult {
  advanced: boolean;
  stage: string | null;
  reason: string | null;
}
export declare function advanceStageForMilestone(
  supabase: { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message?: string } | null }> },
  input: {
    leadId: string;
    milestoneKey: string;
    lead: {
      stage: string | null;
      final_status: string | null;
      quality: string | null;
      next_action: string | null;
      next_followup_date: string | null;
    } | null;
    hasCompleteContact: boolean;
    /** Audit note for the stage_change event; defaults to "Milestone completed: <milestoneKey>". */
    note?: string;
  },
): Promise<StageAdvanceResult>;
