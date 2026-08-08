import { NextResponse } from "next/server";
import { getSupabaseCookieNames } from "@/lib/supabase-cookie-names";

const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const PRODUCTION_HOST = "app.newme.ae";
const PRODUCTION_ORIGIN = "https://app.newme.ae";

function expectedSessionOrigin(request: Request): string {
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

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type")?.split(";")[0].trim();
    if (contentType !== "application/json") {
      return NextResponse.json({ error: "invalid_content_type" }, { status: 415 });
    }
    const origin = request.headers.get("origin");
    if (origin) {
      try {
        const expectedOrigin = expectedSessionOrigin(request);
        if (new URL(origin).origin !== expectedOrigin) {
          return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
        }
      } catch {
        return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
      }
    }

    const body = await request.json();
    const accessToken = typeof body.access_token === "string" ? body.access_token : "";
    const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";
    const expiresIn = Number.isFinite(body.expires_in) ? Math.max(60, Math.floor(body.expires_in)) : 3600;

    if (!accessToken || !refreshToken) {
      return NextResponse.json({ error: "invalid_session" }, { status: 400 });
    }

    const { authToken, refreshToken: refreshCookie } = getSupabaseCookieNames();
    const cookiePayload = JSON.stringify({
      access_token: accessToken,
      expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    });
    const response = NextResponse.json({ ok: true });
    response.cookies.set(authToken, cookiePayload, {
      httpOnly: false,
      maxAge: expiresIn,
      path: "/",
      sameSite: "strict",
      secure: true,
    });
    response.cookies.set(refreshCookie, refreshToken, {
      httpOnly: true,
      maxAge: SESSION_MAX_AGE,
      path: "/",
      sameSite: "strict",
      secure: true,
    });
    return response;
  } catch {
    return NextResponse.json({ error: "invalid_session" }, { status: 400 });
  }
}
