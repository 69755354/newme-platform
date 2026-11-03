/**
 * Version-skew handling for tabs that outlive a release.
 *
 * After a deploy, an open tab still runs the previous bundle. Its client-side
 * navigations are protected by Next.js itself once `deploymentId` is set in
 * next.config.ts (mismatch → full reload). Three paths are not covered by that:
 *
 *   1. a server action invoked from the stale bundle — the server no longer has
 *      that action id and answers `text/plain` with x-nextjs-action-not-found,
 *      which the client surfaces as UnrecognizedActionError / "Failed to find
 *      Server Action" / "Server Reference ID did not match";
 *   2. a plain fetch such as GET /api/auth/me, which succeeds regardless of the
 *      caller's release but reports the server's release in a response header;
 *   3. a tab that was in the background during the release and has not made
 *      any request since — probeServerRelease() asks the server on the tab's
 *      return (visibility/focus, throttled). This path never reloads: the user
 *      may have unsaved input in a form. It publishes "update available" and
 *      the dashboard layout shows a persistent banner ("the system was
 *      updated — save your work, then click here to refresh").
 *
 * Paths 1 and 2 are resolved the same way: ONE full reload for the current
 * client release. The reload marker is keyed by the client's own release id and kept in
 * sessionStorage, so a reload that somehow lands on the same stale bundle (a
 * cache in front of the app, a half-finished switch) does not loop; it simply
 * falls through to the ordinary error state. When sessionStorage is not
 * usable at all there is no way to remember a reload, so none is attempted.
 *
 * Nothing here ever redirects to /login. A stale bundle is not an invalid
 * session, and treating it as one is exactly what logged managers out after
 * every release.
 */

/** Header on which /api/auth/me reports the release that produced the answer. */
export const DEPLOYMENT_ID_HEADER = "x-newme-deployment-id";

const RELOAD_MARKER_KEY = "newme.version-skew.reloaded-for";

/** The release the running client bundle was built from, or null locally. */
/** @returns {string | null} */
export function clientDeploymentId() {
  const id = process.env.NEXT_PUBLIC_DEPLOYMENT_ID;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * True when `serverId` names a release and it is not the client's release.
 * An absent header (older server, local dev) is never a mismatch.
 */
/**
 * @param {string | null | undefined} serverId
 * @param {string | null} [clientId]
 * @returns {boolean}
 */
export function isDeploymentMismatch(serverId, clientId = clientDeploymentId()) {
  if (!serverId || !clientId) return false;
  return serverId !== clientId;
}

// Only the errors Next.js raises for a server action whose id the server no
// longer has. "Expected RSC response" is deliberately not here: it is also what
// a navigation reports when the proxy answered with an HTML redirect (e.g.
// /login?reason=auth_unavailable), which is not a release mismatch.
const SKEW_MESSAGE =
  /Failed to find Server Action|Server Reference ID|Server Action .* did not match the expected format|older or newer deployment/i;

/** True for the errors Next.js raises when a stale bundle calls a server action. */
/** @param {unknown} error @returns {boolean} */
export function isVersionSkewError(error) {
  if (!error || typeof error !== "object") return false;
  const { name, message } = /** @type {{ name?: unknown, message?: unknown }} */ (error);
  if (name === "UnrecognizedActionError") return true;
  return typeof message === "string" && SKEW_MESSAGE.test(message);
}

/**
 * @typedef {{ getItem(key: string): string | null, setItem(key: string, value: string): void }} StorageLike
 * @typedef {{ reload(): void }} LocationLike
 */

/** @returns {StorageLike | null} */
function sessionStore() {
  try {
    return typeof window !== "undefined" && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/**
 * Reload the page once for the current client release.
 *
 * Returns true when a reload was triggered, false when this release already
 * reloaded once (so the caller should fall back to its normal error handling
 * rather than reload again), when there is no page to reload, or when no
 * storage is available to remember the reload (reloading without a memory of
 * having done so is the loop this guard exists to prevent).
 */
/**
 * @param {{ storage?: StorageLike | null, location?: LocationLike | null, clientId?: string | null }} [options]
 * @returns {boolean}
 */
export function reloadOnceForVersionSkew(options = {}) {
  const location = options.location === undefined
    ? (typeof window !== "undefined" ? window.location : null)
    : options.location;
  if (!location) return false;
  const storage = options.storage === undefined ? sessionStore() : options.storage;
  if (!storage) return false;
  const marker = options.clientId === undefined ? (clientDeploymentId() ?? "unknown") : (options.clientId ?? "unknown");
  try {
    if (storage.getItem(RELOAD_MARKER_KEY) === marker) return false;
    storage.setItem(RELOAD_MARKER_KEY, marker);
  } catch {
    return false;
  }
  location.reload();
  return true;
}

/**
 * Compare a response's release header with the client's and reload once on a
 * mismatch. Returns true when a reload was triggered.
 */
/** @param {{ get(name: string): string | null }} headers @returns {boolean} */
export function reloadIfServerReleaseDiffers(headers) {
  const serverId = headers.get(DEPLOYMENT_ID_HEADER);
  if (!isDeploymentMismatch(serverId)) return false;
  return reloadOnceForVersionSkew();
}

/** Minimum spacing between two release probes from the same tab. */
export const RELEASE_PROBE_INTERVAL_MS = 60_000;

let lastProbeAt = 0;

// ── "update available" state, read by the dashboard layout's banner ─────────
let updateAvailable = false;
const updateListeners = new Set();

function publishUpdateAvailable() {
  if (updateAvailable) return;
  updateAvailable = true;
  for (const listener of updateListeners) listener();
}

/** useSyncExternalStore-compatible subscription. @param {() => void} listener */
export function subscribeUpdateAvailable(listener) {
  updateListeners.add(listener);
  return () => { updateListeners.delete(listener); };
}

/** True once a probe has seen a newer release than this tab runs. */
export function isUpdateAvailable() {
  return updateAvailable;
}

/**
 * Ask the server which release it runs (GET /api/auth/me, whose header the
 * client already compares on every mount). On a mismatch it does NOT reload —
 * the user may be mid-form — it publishes "update available" for the banner.
 * Throttled: at most one probe per RELEASE_PROBE_INTERVAL_MS per tab. The
 * response status is irrelevant here; only the header is read, and a failed
 * fetch is ignored (the next real request will decide).
 *
 * Returns true when a newer release was detected.
 */
/**
 * @param {{ fetchImpl?: typeof fetch, now?: number, force?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
export async function probeServerRelease(options = {}) {
  const now = options.now ?? Date.now();
  if (!options.force && now - lastProbeAt < RELEASE_PROBE_INTERVAL_MS) return false;
  lastProbeAt = now;
  if (!clientDeploymentId()) return false;
  const fetchImpl = options.fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  if (!fetchImpl) return false;
  try {
    const response = await fetchImpl("/api/auth/me", { credentials: "same-origin", cache: "no-store" });
    if (!isDeploymentMismatch(response.headers.get(DEPLOYMENT_ID_HEADER))) return false;
    publishUpdateAvailable();
    return true;
  } catch {
    return false;
  }
}

/** Test seam: forget the last probe time and the published state. */
export function resetReleaseProbeForTests() {
  lastProbeAt = 0;
  updateAvailable = false;
}
