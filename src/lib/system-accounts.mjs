// System accounts: the QA test accounts (@qa.newme.ae) and the release-acceptance
// accounts (release-uat-*). They exist so the release gate, the production
// smoke run and the daily synthetic check can log in. They are not people, so
// they must not show up in lists real users read: the team page, the user
// list, assignee dropdowns and the per-person statistics.
//
// This module is the single place that knows which accounts those are. Login,
// roles, permissions and sessions of these accounts are NOT touched by it; it
// only removes them from list reads.
//
// Two rules keep the release gate working:
//   - the signed-in account itself is always kept in a list it reads (pass
//     `viewerId`), so a QA / acceptance account still sees itself;
//   - "validation" reads (is this id a legal assignee?) do not use this module,
//     so a lead can still be assigned to a system account on purpose.

export const SYSTEM_ACCOUNT_EMAIL_SUFFIXES = Object.freeze(["@qa.newme.ae"]);
export const SYSTEM_ACCOUNT_EMAIL_PREFIXES = Object.freeze(["release-uat-"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSystemAccountEmail(email) {
  if (typeof email !== "string") return false;
  const value = email.trim().toLowerCase();
  if (!value) return false;
  return SYSTEM_ACCOUNT_EMAIL_SUFFIXES.some((suffix) => value.endsWith(suffix))
    || SYSTEM_ACCOUNT_EMAIL_PREFIXES.some((prefix) => value.startsWith(prefix));
}

export function isSystemAccount(profile) {
  return Boolean(profile) && isSystemAccountEmail(profile.email);
}

// PostgREST `or` filter that keeps: rows without an e-mail, rows whose e-mail is
// not a system-account e-mail, and (optionally) the viewer's own row. `*` is the
// PostgREST wildcard and `ilike` makes the match case-insensitive.
export function systemAccountVisibilityFilter({ viewerId } = {}) {
  const notSystem = [
    ...SYSTEM_ACCOUNT_EMAIL_SUFFIXES.map((suffix) => `email.not.ilike.*${suffix}`),
    ...SYSTEM_ACCOUNT_EMAIL_PREFIXES.map((prefix) => `email.not.ilike.${prefix}*`),
  ];
  const parts = ["email.is.null", `and(${notSystem.join(",")})`];
  if (typeof viewerId === "string" && UUID.test(viewerId)) parts.push(`id.eq.${viewerId}`);
  return parts.join(",");
}

// Supabase query builder -> same builder, with system accounts removed.
export function excludeSystemAccountsQuery(query, options = {}) {
  return query.or(systemAccountVisibilityFilter(options));
}

// Same rule for rows that are already in memory.
export function omitSystemAccounts(rows, { viewerId } = {}) {
  return (rows ?? []).filter((row) => (viewerId != null && row?.id === viewerId) || !isSystemAccount(row));
}
