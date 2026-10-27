export const DEV_IDENTITY_REFUSALS: Readonly<{
  PRODUCTION: string;
  NOT_OPTED_IN: string;
  UNCONFIGURED: string;
  EMAIL_NOT_AN_ADDRESS: string;
  PASSWORD_TOO_SHORT: string;
}>;
export const DEV_IDENTITY_MIN_PASSWORD_LENGTH: number;
export const DEV_IDENTITY_OPT_IN: string;
export type DevIdentity =
  | { ok: true; email: string; password: string }
  | { ok: false; reason: string; status: number };
export function resolveDevIdentity(env?: Record<string, string | undefined>): DevIdentity;
