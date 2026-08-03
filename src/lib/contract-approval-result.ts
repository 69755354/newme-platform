export interface ContractApprovalResult {
  success: true;
  action?: string;
  new_status?: string;
  step?: string;
  notification_warning?: "notification_delivery_failed";
  [key: string]: unknown;
}

export class ContractApprovalResultError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(
    code: string,
    status: number,
  ) {
    super(code);
    this.name = "ContractApprovalResultError";
    this.code = code;
    this.status = status;
  }
}

function businessFailure(message: string): ContractApprovalResultError {
  const normalized = message.toLowerCase();
  if (normalized.includes("not authorized") || normalized.includes("approver")
    || normalized.includes("role")) {
    return new ContractApprovalResultError("contract_approval_forbidden", 403);
  }
  if (normalized.includes("contract not found")) {
    return new ContractApprovalResultError("contract_approval_not_found", 404);
  }
  if (normalized.includes("invalid action")) {
    return new ContractApprovalResultError("invalid_contract_approval", 400);
  }
  return new ContractApprovalResultError("contract_approval_conflict", 409);
}

export function requireContractApprovalSuccess(value: unknown): ContractApprovalResult {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if ("error" in value && typeof value.error === "string") {
      throw businessFailure(value.error);
    }
    if ("success" in value && value.success === true) {
      return value as ContractApprovalResult;
    }
  }
  throw new ContractApprovalResultError("invalid_contract_approval_result", 502);
}

export function hasNotificationWarning(
  value: unknown,
): value is { notification_warning: "notification_delivery_failed" } {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && "notification_warning" in value
    && value.notification_warning === "notification_delivery_failed";
}

export async function withContractNotificationWarning<T extends { success: true }>(
  result: T,
  deliverNotification: () => Promise<void>,
  onNotificationFailure?: (error: unknown) => void,
): Promise<T | (T & { notification_warning: "notification_delivery_failed" })> {
  try {
    await deliverNotification();
    return result;
  } catch (error: unknown) {
    onNotificationFailure?.(error);
    return { ...result, notification_warning: "notification_delivery_failed" };
  }
}

export async function completeContractApproval(
  value: unknown,
  deliverNotification: () => Promise<void>,
  onNotificationFailure?: (error: unknown) => void,
): Promise<ContractApprovalResult> {
  const result = requireContractApprovalSuccess(value);
  return withContractNotificationWarning(
    result,
    deliverNotification,
    onNotificationFailure,
  );
}
