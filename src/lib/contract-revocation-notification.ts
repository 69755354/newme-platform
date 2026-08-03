export type ContractRevocationStatus = "revoking" | "superseded";

export interface ContractRevocationNotificationContext {
  contractId: string;
  contractNo: string;
  salesId: string | null;
  status: ContractRevocationStatus;
  reason: string;
}

export interface ContractRevocationNotification {
  userId: string;
  type: "contract_superseded";
  title: string;
  body: string;
  relatedId: string;
  relatedType: "contract";
  eventKey: string;
}

export function buildContractRevocationNotifications(
  context: ContractRevocationNotificationContext,
  adminUserIds: string[],
): ContractRevocationNotification[] {
  const recipients = [...new Set([
    context.salesId,
    ...adminUserIds,
  ].filter((userId): userId is string => Boolean(userId)))];
  const actionLabel = context.status === "superseded"
    ? "superseded"
    : "revocation initiated";
  const eventKey = `contract:${context.contractId}:status:${context.status}`;
  return recipients.map((userId) => ({
    userId,
    type: "contract_superseded",
    title: `Contract ${context.contractNo} - ${actionLabel}`,
    body: `Contract ${context.contractNo} has been ${actionLabel}. Reason: ${context.reason.trim()}`,
    relatedId: context.contractId,
    relatedType: "contract",
    eventKey,
  }));
}
