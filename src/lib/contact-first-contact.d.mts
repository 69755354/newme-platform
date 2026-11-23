import type { SupabaseClient } from "@supabase/supabase-js";
export const DEFAULT_NEXT_ACTION: string;
export function completeFirstContactAfterLog(
  supabase: SupabaseClient,
  input: { leadId: string; userId: string; now?: Date },
): Promise<{ advanced: boolean; stage: string | null; reason: string | null; milestone: boolean }>;
