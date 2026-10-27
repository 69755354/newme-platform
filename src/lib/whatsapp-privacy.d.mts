export function deletionCustomerKey(phone: unknown, salt: string | undefined): string | null;
export function readDeletionInput(request: Request): Promise<{phone: string; request_id: string; verified: true} | null>;
