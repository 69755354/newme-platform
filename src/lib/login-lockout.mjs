// S6 (review 4d #17): turn the login endpoint's Retry-After header into the
// whole minutes the lockout message shows ("请在 15 分钟后再试").
// The bound itself lives in src/app/api/auth/login/route.ts:
// 8 failed attempts per account per 15 minutes, 20 per source address per 5.
export function lockoutWaitMinutes(retryAfter) {
  if (retryAfter === null || retryAfter === undefined) return null;
  const seconds = Number(retryAfter);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.max(1, Math.ceil(seconds / 60));
}

// S6 review: the per-address bound (20 sign-ins per 5 minutes from one
// network, e.g. a shared office connection) is not an account lockout, so it
// gets its own message. The route reports the bound in X-RateLimit-Scope.
export function lockoutMessageKey(scope) {
  return scope === "address" ? "login.rateLimitedNetworkWait" : "login.rateLimitedWait";
}
