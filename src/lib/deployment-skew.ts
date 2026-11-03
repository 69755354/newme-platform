/**
 * Version-skew handling for tabs that outlive a release.
 *
 * After a deploy, an open tab still runs the previous bundle. Its client-side
 * navigations are protected by Next.js itself once `deploymentId` is set in
 * next.config.ts (mismatch → full reload). Two paths are not covered by that:
 *
 *   1. a server action invoked from the stale bundle — the server no longer has
 *      that action id and answers `text/plain` with x-nextjs-action-not-found,
 *      which the client surfaces as UnrecognizedActionError / "Server Reference
 *      ID did not match" / "Expected RSC response, got text/plain";
 *   2. a plain fetch such as GET /api/auth/me, which succeeds regardless of the
 *      caller's release but reports the server's release in a response header.
 *
 * Both are resolved the same way: ONE full reload for the current client
 * release. The reload marker is keyed by the client's own release id and kept in
 * sessionStorage, so a reload that somehow lands on the same stale bundle (a
 * cache in front of the app, a half-finished switch) does not loop; it simply
 * falls through to the ordinary error state.
 *
 * Nothing here ever redirects to /login. A stale bundle is not an invalid
 * session, and treating it as one is exactly what logged managers out after
 * every release.
 */

/** Header on which /api/auth/me reports the release that produced the answer. */
export const DEPLOYMENT_ID_HEADER = "x-newme-deployment-id";

const RELOAD_MARKER_KEY = "newme.version-skew.reloaded-for";

/** The release the running client bundle was built from, or null locally. */
export function clientDeploymentId(): string | null {
  const id = process.env.NEXT_PUBLIC_DEPLOYMENT_ID;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * True when `serverId` names a release and it is not the client's release.
 * An absent header (older server, local dev) is never a mismatch.
 */
export function isDeploymentMismatch(
  serverId: string | null | undefined,
  clientId: string | null = clientDeploymentId(),
): boolean {
  if (!serverId || !clientId) return false;
  return serverId !== clientId;
}

const SKEW_MESSAGE =
  /was not found on the server|Failed to find Server Action|Server Reference ID|did not match the expected format|Expected RSC response/i;

/** True for the errors Next.js raises when a stale bundle calls a server action. */
export function isVersionSkewError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === "UnrecognizedActionError") return true;
  return typeof message === "string" && SKEW_MESSAGE.test(message);
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;
type LocationLike = Pick<Location, "reload">;

function sessionStore(): StorageLike | null {
  try {
    return typeof window !== "undefined" && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    // Storage can throw in locked-down browsers; then every reload counts as the first.
    return null;
  }
}

/**
 * Reload the page once for the current client release.
 *
 * Returns true when a reload was triggered, false when this release already
 * reloaded once (so the caller should fall back to its normal error handling
 * rather than reload again) or when there is no page to reload.
 */
export function reloadOnceForVersionSkew(
  options: { storage?: StorageLike | null; location?: LocationLike | null; clientId?: string | null } = {},
): boolean {
  const location = options.location === undefined
    ? (typeof window !== "undefined" ? window.location : null)
    : options.location;
  if (!location) return false;
  const storage = options.storage === undefined ? sessionStore() : options.storage;
  const marker = options.clientId === undefined ? (clientDeploymentId() ?? "unknown") : (options.clientId ?? "unknown");
  try {
    if (storage?.getItem(RELOAD_MARKER_KEY) === marker) return false;
    storage?.setItem(RELOAD_MARKER_KEY, marker);
  } catch {
    // Storage write failed: still reload once; a second failure path is the
    // ordinary error UI, not another reload, because the error state renders.
  }
  location.reload();
  return true;
}

/**
 * Compare a response's release header with the client's and reload once on a
 * mismatch. Returns true when a reload was triggered.
 */
export function reloadIfServerReleaseDiffers(headers: Pick<Headers, "get">): boolean {
  const serverId = headers.get(DEPLOYMENT_ID_HEADER);
  if (!isDeploymentMismatch(serverId)) return false;
  return reloadOnceForVersionSkew();
}
