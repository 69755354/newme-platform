const MANAGER = {
  draft: ["pending_admin"],
  rejected: ["pending_admin", "draft"],
  approved: ["active", "terminated"],
  active: ["completed", "suspended", "terminated"],
  suspended: ["active", "terminated"],
  revoking: ["terminated"],
};

const OPERATIONS = {
  approved: ["active"],
  active: ["completed"],
  suspended: ["active"],
};

const OWNER = {
  draft: ["pending_admin"],
  rejected: ["pending_admin", "draft"],
};

export function allowedSetContractStatuses(role, isOwner, currentStatus) {
  if (role === "admin" || role === "boss") return [...(MANAGER[currentStatus] ?? [])];
  const allowed = role === "operator" || role === "finance"
    ? [...(OPERATIONS[currentStatus] ?? [])]
    : [];
  if (role === "operator" || ((role === "finance" || role === "sales") && isOwner)) {
    allowed.push(...(OWNER[currentStatus] ?? []));
  }
  return [...new Set(allowed)];
}
