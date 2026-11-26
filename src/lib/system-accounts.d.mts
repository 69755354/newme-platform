export const SYSTEM_ACCOUNT_EMAIL_SUFFIXES: readonly string[];
export const SYSTEM_ACCOUNT_EMAIL_PREFIXES: readonly string[];
export function isSystemAccountEmail(email: string | null | undefined): boolean;
export function isSystemAccount(profile: { email?: string | null } | null | undefined): boolean;
export function systemAccountVisibilityFilter(options?: { viewerId?: string | null }): string;
export function excludeSystemAccountsQuery<T extends { or(filter: string): unknown }>(
  query: T,
  options?: { viewerId?: string | null },
): T;
export function omitSystemAccounts<T extends { id?: string | null; email?: string | null }>(
  rows: readonly T[] | null | undefined,
  options?: { viewerId?: string | null },
): T[];
export function systemAccountIdSet<T extends { id?: string | null; email?: string | null }>(
  rows: readonly T[] | null | undefined,
  options?: { viewerId?: string | null },
): Set<string>;
