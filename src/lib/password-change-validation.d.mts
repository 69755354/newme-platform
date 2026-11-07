export declare const PASSWORD_MIN_LENGTH: number;
export type PasswordChangeCode =
  | "missing_fields"
  | "too_short"
  | "mismatch"
  | "same_as_old"
  | "wrong_current_password"
  | "unauthorized"
  | "rate_limited"
  | "update_failed"
  | "partial_success"
  | "network";
export declare const PASSWORD_CHANGE_CODES: readonly PasswordChangeCode[];
export declare function validatePasswordChange(input?: {
  oldPassword?: unknown;
  newPassword?: unknown;
  confirmPassword?: unknown;
}): PasswordChangeCode | null;
export declare function passwordChangeMessageKey(code: string | null | undefined): string;
