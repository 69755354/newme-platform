export interface LeadTransferCandidateProfile {
  role?: string | null;
  is_active?: boolean | null;
}

export const LEAD_TRANSFER_CANDIDATE_ROLES: readonly [
  "sales",
  "operator",
  "boss",
];

export function isLeadTransferCandidate(
  profile: LeadTransferCandidateProfile | null | undefined,
): boolean;

export interface LeadTransferCandidateQuery<T> {
  in(column: string, values: readonly string[]): {
    eq(column: string, value: boolean): T;
  };
}

export function filterLeadTransferCandidateQuery<T>(
  query: LeadTransferCandidateQuery<T>,
): T;

export interface VisibleLeadOwnerReference {
  assigned_to?: string | null;
}

export function getVisibleLeadOwnerIds(
  leads: readonly VisibleLeadOwnerReference[],
): string[];
