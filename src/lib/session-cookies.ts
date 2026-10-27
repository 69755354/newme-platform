import type { NextResponse } from "next/server";
import { getSupabaseCookieNames } from "@/lib/supabase-cookie-names";

const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const PRODUCTION_HOST = "app.newme.ae";
const PRODUCTION_ORIGIN = "https://app.newme.ae";

/**
 * Single source of truth for the split-session cookie contract.
 *
 * Every endpoint that establishes a session (password login, session bootstrap)
 * must go through applySessionCookies. Two endpoints hand-rolling their own
 * cookie attributes is how one of them eventually ships without `secure` or
 * without `httpOnly` on the refresh half.
 */

export function expectedSessionOrigin(request: Request): string {
  // Host is set explicitly by the managed reverse proxy. Never let a
  // caller-supplied X-Forwarded-Host weaken the production boundary.
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const requestHost = (request.headers.get("host") || forwardedHost || "")
    .toLowerCase()
    .replace(/:\d+$/, "");

  // The production security boundary is immutable application code. A mutable
  // runtime value may still be used by staging, but it can never lock every
  // production user out or broaden the production origin allowlist.
  if (requestHost === PRODUCTION_HOST) return PRODUCTION_ORIGIN;

  return process.env.NEXT_PUBLIC_SITE_URL
    ? new URL(process.env.NEXT_PUBLIC_SITE_URL).origin
    : new URL(request.url).origin;
}

/** True when the request carries no Origin, or one matching this deployment. */
export function hasAllowedSessionOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === expectedSessionOrigin(request);
  } catch {
    return false;
  }
}

export function normalizeExpiresIn(value: unknown): number {
  return Number.isFinite(value) ? Math.max(60, Math.floor(value as number)) : 3600;
}

export type SessionTokens = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

export function applySessionCookies<T extends NextResponse>(
  response: T,
  tokens: SessionTokens,
): T {
  const { authToken, refreshToken: refreshCookie } = getSupabaseCookieNames();

  // The browser-readable half carries the access token and its expiry only.
  // The refresh token never appears in a script-readable cookie.
  const cookiePayload = JSON.stringify({
    access_token: tokens.accessToken,
    expires_at: Math.floor(Date.now() / 1000) + tokens.expiresIn,
  });

  response.cookies.set(authToken, cookiePayload, {
    httpOnly: false,
    maxAge: tokens.expiresIn,
    path: "/",
    sameSite: "strict",
    secure: true,
  });
  response.cookies.set(refreshCookie, tokens.refreshToken, {
    httpOnly: true,
    maxAge: SESSION_MAX_AGE,
    path: "/",
    sameSite: "strict",
    secure: true,
  });
  return response;
}
