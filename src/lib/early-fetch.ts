/**
 * Start a request before the component that needs it has rendered, and let that
 * component take the same in-flight request over.
 *
 * Why: a page that renders a "loading" placeholder until its first answer
 * arrives only mounts its other panels afterwards, so a panel's own request
 * used to start one full round trip late. Starting it together with the page's
 * first request puts both on the wire at once.
 *
 * What this is not: a cache. Each early request can be taken exactly once and
 * only for a few seconds; after that, or when nothing was started, `take`
 * simply performs an ordinary request. No response is kept or shared between
 * users, tabs or pages.
 */
export const EARLY_FETCH_TTL_MS = 10_000;

type Early = { promise: Promise<Response>; startedAt: number };
const pending = new Map<string, Early>();

function fresh(entry: Early | undefined): entry is Early {
  return !!entry && Date.now() - entry.startedAt <= EARLY_FETCH_TTL_MS;
}

/** Begin `url` now. A second call while a fresh one is pending does nothing. */
export function startEarlyFetch(url: string): void {
  if (fresh(pending.get(url))) return;
  const promise = fetch(url);
  // A request nobody takes must not surface as an unhandled rejection; a
  // consumer that does take it still sees the original rejection.
  promise.catch(() => undefined);
  pending.set(url, { promise, startedAt: Date.now() });
}

/** The early request for `url` if one is fresh (once), otherwise a new one. */
export function takeEarlyFetch(url: string): Promise<Response> {
  const entry = pending.get(url);
  pending.delete(url);
  return fresh(entry) ? entry.promise : fetch(url);
}
