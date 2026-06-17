import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

const APP_ID = process.env.META_APP_ID || "1612447067166445";
const APP_SECRET = process.env.META_APP_SECRET!;
const REDIRECT_URI = process.env.META_REDIRECT_URI || "https://app.newme.ae/api/meta/oauth-callback";

async function saveTokenToSupabase(accessToken: string, expiresIn: number) {
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  // Upsert — id=1 ensures a single row (singleton pattern)
  const { error } = await supabaseAdmin.from("meta_tokens").upsert(
    {
      id: 1,
      access_token: accessToken,
      expires_at: expiresAt,
    },
    { onConflict: "id" },
  );

  if (error) {
    // If table doesn't exist, try to create it
    if (error.message?.includes("relation") && error.message?.includes("does not exist")) {
      console.warn("[OAuth] meta_tokens table missing. Token not saved to DB.");
    } else {
      console.error("[OAuth] Failed to save token to Supabase:", error);
    }
  } else {
    if (process.env.NODE_ENV !== "production") {
      console.log(`[OAuth] Token saved to Supabase meta_tokens, expires_at=${expiresAt}`);
    }
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const state = searchParams.get("state");

  if (error) {
    const desc = searchParams.get("error_description") || "";
    console.error(`[OAuth] Authorization failed: ${error} - ${desc}`);
    return new NextResponse(
      `<html><body><h2>Authorization Failed</h2><p>${error}: ${desc}</p><p>Close this tab.</p></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } }
    );
  }

  if (!code) {
    return new NextResponse("No code parameter", { status: 400 });
  }

  // ── CSRF: verify state matches cookie from /oauth-start ──
  const cookieState = request.cookies.get("oauth_state")?.value;
  if (!state || !cookieState || state !== cookieState) {
    console.error(`[OAuth] State mismatch — possible CSRF. query_state=${state} cookie_state=${cookieState ? "present" : "absent"}`);
    return new NextResponse(
      `<html><body><h2>Security Error</h2><p>OAuth state validation failed (CSRF protection). Please restart the authorization from the settings page.</p></body></html>`,
      { status: 403, headers: { "content-type": "text/html; charset=utf-8" } }
    );
  }

  try {
    const tokenData = await exchangeCode(code);
    if (tokenData?.access_token) {
      // Save to Supabase meta_tokens table instead of filesystem
      await saveTokenToSupabase(tokenData.access_token, tokenData.expires_in || 0);
      
      // Also log for immediate use
      if (process.env.NODE_ENV !== "production") {
        console.log(`[OAuth] SUCCESS — token saved, expires_in=${tokenData.expires_in}`);
      }
      
      return new NextResponse(
        `<html><body><h2>Authorization Successful!</h2><p>Token saved. Close this tab.</p></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } }
      );
    }
    
    console.error("[OAuth] Token exchange returned no access_token:", tokenData);
    return new NextResponse(
      `<html><body><h2>Token Exchange Failed</h2><p>Check server logs.</p></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } }
    );
  } catch (e) {
    console.error("[OAuth] Exchange error:", e);
    return new NextResponse(
      `<html><body><h2>Error</h2><p>${String(e)}</p></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } }
    );
  }
}

async function exchangeCode(code: string) {
  const params = new URLSearchParams({
    client_id: APP_ID,
    redirect_uri: REDIRECT_URI,
    client_secret: APP_SECRET,
    code,
  });

  if (process.env.NODE_ENV !== "production") {
    console.log(`[OAuth] Exchanging code with redirect_uri=${REDIRECT_URI}`);
  }
  
  const resp = await fetch(
    `https://graph.facebook.com/v22.0/oauth/access_token?${params}`,
    { cache: "no-store" }
  );
  
  if (!resp.ok) {
    const errorText = await resp.text();
    console.error(`[OAuth] Token exchange HTTP ${resp.status}: ${errorText}`);
    return null;
  }
  
  const data = await resp.json();

  if (data.access_token) {
    // Exchange for long-lived token
    return exchangeLongLived(data.access_token);
  }

  console.error("[OAuth] Short token exchange failed:", JSON.stringify(data));
  if (data.error) {
    console.error(`[OAuth] Facebook error: ${data.error.type || data.error.code} - ${data.error.message}`);
    console.error(`[OAuth] Facebook error subcode: ${data.error.error_subcode}, fbtrace_id: ${data.error.fbtrace_id}`);
  }
  return null;
}

async function exchangeLongLived(shortToken: string) {
  const params = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: APP_ID,
    client_secret: APP_SECRET,
    fb_exchange_token: shortToken,
  });

  try {
    const resp = await fetch(
      `https://graph.facebook.com/v22.0/oauth/access_token?${params}`,
      { cache: "no-store" }
    );
    
    if (!resp.ok) {
      const errorText = await resp.text();
      console.error(`[OAuth] Long-lived exchange HTTP ${resp.status}: ${errorText}`);
      return { access_token: shortToken, expires_in: 3600 };
    }
    
    const data = await resp.json();
    if (process.env.NODE_ENV !== "production") {
      console.log(`[OAuth] Long-lived token: expires_in=${data.expires_in}`);
    }
    if (data.error) {
      console.error(`[OAuth] Long-lived token error: ${JSON.stringify(data.error)}`);
    }
    return data;
  } catch (e) {
    console.error("[OAuth] Long-lived exchange failed, using short token:", e);
    return { access_token: shortToken, expires_in: 3600 };
  }
}
