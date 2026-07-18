import { filterLeadTransferCandidateQuery } from "./lead-transfer-candidates.mjs";

export async function resolveActiveLeadReassignmentTarget(profilesQuery) {
  const { data, error } = await filterLeadTransferCandidateQuery(profilesQuery)
    .order("id", { ascending: true })
    .limit(1);
  if (error) throw error;
  return data?.[0]?.id ?? null;
}

export async function requireActiveLeadTransferCandidate(profilesQuery, userId) {
  const { data, error } = await filterLeadTransferCandidateQuery(profilesQuery)
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Lead assignee must be an active transfer candidate");
  return data;
}
