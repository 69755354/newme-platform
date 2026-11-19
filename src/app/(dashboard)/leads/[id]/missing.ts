/**
 * Whether the answer to "load this lead" means the lead does not exist (for the
 * caller), as opposed to a failure worth showing an error for or retrying.
 *
 * - no row and no error: nothing there (or not visible to this caller)
 * - PGRST116: PostgREST's "no rows" for a single-row read
 * - 22P02: the id is not even a valid uuid, so no lead can have it
 * A timeout, a permission error or a network failure is not an absence.
 */
export function isLeadMissing(result: { data: unknown; error: { code?: string } | null }): boolean {
  if (!result.error) return result.data == null;
  return result.error.code === "PGRST116" || result.error.code === "22P02";
}
