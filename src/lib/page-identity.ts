/** Role and user a page has already resolved, shared with the components below it. */
export interface PageIdentity {
  role: string;
  userId: string | null;
}

export interface ResolvedPageIdentity extends PageIdentity {
  blocked: boolean;
}

/**
 * What a role hook answers when a page above it already resolved the identity,
 * or null when it has to find out itself. `blocked` applies the same allowed
 * list the hook would have applied to its own answer.
 */
export function identityFromPage(
  page: PageIdentity | null,
  allowedRoles: readonly string[],
): ResolvedPageIdentity | null {
  if (!page) return null;
  return { role: page.role, userId: page.userId, blocked: !allowedRoles.includes(page.role) };
}
