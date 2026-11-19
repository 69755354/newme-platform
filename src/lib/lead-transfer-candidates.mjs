import { excludeSystemAccountsQuery } from "./system-accounts.mjs";

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

// `options` is only for lists that real users read (dropdowns, settings data):
// pass { hideSystemAccounts: true, viewerId } to also drop the QA and
// release-acceptance accounts (src/lib/system-accounts.mjs). Without options the
// query is the plain "may this person receive a lead" rule, which the assignment
// checks use, so a lead can still be handed to a system account on purpose.
export function filterLeadTransferCandidateQuery(query, options = {}) {
  const candidates = query
    .in("role", LEAD_TRANSFER_CANDIDATE_ROLES)
    .eq("is_active", true);
  return options.hideSystemAccounts
    ? excludeSystemAccountsQuery(candidates, { viewerId: options.viewerId })
    : candidates;
}

export function getVisibleLeadOwnerIds(leads) {
  return [...new Set(
    leads
      .map((lead) => lead?.assigned_to)
      .filter((ownerId) => typeof ownerId === "string" && ownerId.length > 0),
  )];
}
