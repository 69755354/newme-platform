import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

/**
 * GET /api/meta/oauth-start
 *
 * Initiates Meta OAuth flow with CSRF-protected state parameter.
 * Generates random state → stores in httpOnly cookie → redirects to Facebook.
 */
export async function GET(request: NextRequest) {
  const APP_ID = process.env.META_APP_ID;
  const REDIRECT_URI = process.env.META_REDIRECT_URI || "https://app.newme.ae/api/meta/oauth-callback";

  if (!APP_ID) {
    return NextResponse.json({ error: "META_APP_ID not configured" }, { status: 503 });
  }

  // Generate CSRF state token
  const state = crypto.randomBytes(16).toString("hex");

  const params = new URLSearchParams({
    client_id: APP_ID,
    redirect_uri: REDIRECT_URI,
    state,
    scope: "ads_management,ads_read,business_management",
  });

  const authUrl = `https://www.facebook.com/v22.0/dialog/oauth?${params}`;

  const response = NextResponse.redirect(authUrl);
  // Store state in httpOnly cookie for callback verification (10 min TTL)
  response.cookies.set("oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });

  return response;
}
