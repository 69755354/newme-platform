export const LEAD_TRANSFER_CANDIDATE_ROLES = Object.freeze([
  "sales",
  "operator",
  "boss",
]);

export function isLeadTransferCandidate(profile) {
  return Boolean(
    profile
    && profile.is_active === true
    && LEAD_TRANSFER_CANDIDATE_ROLES.includes(profile.role),
  );
}

export function filterLeadTransferCandidateQuery(query) {
  return query
    .in("role", LEAD_TRANSFER_CANDIDATE_ROLES)
    .eq("is_active", true);
}

export function getVisibleLeadOwnerIds(leads) {
  return [...new Set(
    leads
      .map((lead) => lead?.assigned_to)
      .filter((ownerId) => typeof ownerId === "string" && ownerId.length > 0),
  )];
}
