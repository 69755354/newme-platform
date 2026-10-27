const profileName = (profile) => {
  const value = typeof profile?.full_name === "string" ? profile.full_name.trim() : "";
  return value || null;
};

const MANAGEMENT_ROLES = new Set(["admin", "boss", "operator"]);

export async function runAuthorizedLeadTransferRead({
  loadVisibleLead,
  readAuthorizedHistory,
  revalidateAccess,
  role,
  userId,
}) {
  const { data: lead, error } = await loadVisibleLead();
  if (error) return { status: "visibility_error" };
  if (!lead) return { status: "not_found" };
  const isCurrentSalesOwner = role === "sales" && lead.assigned_to === userId;
  if (!MANAGEMENT_ROLES.has(role) && !isCurrentSalesOwner) {
    return { status: "forbidden" };
  }
  const value = await readAuthorizedHistory();
  if (isCurrentSalesOwner) {
    if (typeof revalidateAccess !== "function") return { status: "visibility_error" };
    const { data: currentLead, error: revalidationError } = await revalidateAccess();
    if (revalidationError) return { status: "visibility_error" };
    if (!currentLead || currentLead.assigned_to !== userId) return { status: "forbidden" };
  }
  return { status: "ok", value };
}

export function buildTransferProfileNameMap(transfers) {
  const names = new Map();
  for (const transfer of transfers ?? []) {
    if (typeof transfer?.from_user_id === "string") {
      const name = profileName(transfer.from_user);
      if (name) names.set(transfer.from_user_id, name);
    }
    if (typeof transfer?.to_user_id === "string") {
      const name = profileName(transfer.to_user);
      if (name) names.set(transfer.to_user_id, name);
    }
  }
  return names;
}

export function formatLeadTransferDescription(fromUserId, toUserId, profileNames) {
  const fromName = fromUserId ? profileNames.get(fromUserId) || "Unknown" : "Unassigned";
  const toName = toUserId ? profileNames.get(toUserId) || "Unknown" : "Unknown";
  return `Reassigned from ${fromName} to ${toName}`;
}

export function describeLeadTransferEvent(event, profileNames) {
  if (event?.event_type !== "transfer") return event?.description ?? "";
  const data = event.event_data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return event.description ?? "";
  }
  const fromUserId = typeof data.from_user_id === "string" ? data.from_user_id : null;
  const toUserId = typeof data.to_user_id === "string" ? data.to_user_id : null;
  if (!fromUserId && !toUserId) return event.description ?? "";
  if ((fromUserId && !profileNames.has(fromUserId)) || (toUserId && !profileNames.has(toUserId))) {
    return event.description ?? "";
  }
  return formatLeadTransferDescription(fromUserId, toUserId, profileNames);
}
