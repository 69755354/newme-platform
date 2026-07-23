import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

const APP_ID = process.env.META_APP_ID || "1612447067166445";
const REDIRECT_URI = process.env.META_REDIRECT_URI || "https://app.newme.ae/api/meta/oauth-callback";
const STATE_COOKIE = "meta_oauth_state";
const STATE_MAX_AGE = 10 * 60;

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const bearerToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || undefined;
  const cookieHeader = request.headers.get("cookie") || "";
  const supabase = await createServerSupabase(bearerToken, cookieHeader);
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role, is_active")
    .eq("id", user.id)
    .single();

  if (profileError || profile?.is_active !== true || typeof profile?.role !== "string" || !["admin", "boss"].includes(profile.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const state = randomBytes(32).toString("base64url");
  const authorizeUrl = new URL("https://www.facebook.com/v22.0/dialog/oauth");
  authorizeUrl.searchParams.set("client_id", APP_ID);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("scope", "ads_read");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", state);

  const response = NextResponse.redirect(authorizeUrl);
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    maxAge: STATE_MAX_AGE,
    path: "/api/meta",
    sameSite: "lax",
    secure: true,
  });
  return response;
}
