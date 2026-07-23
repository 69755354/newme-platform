// RBAC: public
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { logger, genReqId } from "@/lib/logger";

const APP_ID = process.env.META_APP_ID || "1612447067166445";
const APP_SECRET = process.env.META_APP_SECRET!;
const REDIRECT_URI = process.env.META_REDIRECT_URI || "https://app.newme.ae/api/meta/oauth-callback";
const STATE_COOKIE = "meta_oauth_state";

function clearStateCookie(response: NextResponse) {
  response.cookies.set(STATE_COOKIE, "", {
    httpOnly: true,
    maxAge: 0,
    path: "/api/meta",
    sameSite: "lax",
    secure: true,
  });
  return response;
}

async function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase admin credentials");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function saveTokenToSupabase(
  accessToken: string,
  expiresIn: number,
  request_id: string,
) {
  const supabase = await getSupabaseAdmin();
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  // Upsert ? id=1 ensures a single row (singleton pattern)
  const { error } = await supabase.from("meta_tokens").upsert(
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
      logger.warn(
        {
          err: error,
          request_id,
          operation: "oauth_callback",
        },
        "[OAuth] meta_tokens table missing. Token not saved to DB.",
      );
    } else {
      logger.error(
        {
          err: error,
          request_id,
          operation: "oauth_callback",
        },
        "[OAuth] Failed to save token to Supabase",
      );
    }
  } else {
    logger.info(
      {
        request_id,
        operation: "oauth_callback",
        expires_at: expiresAt,
      },
      "[OAuth] Token saved to Supabase meta_tokens",
    );
  }
}

export async function GET(request: NextRequest) {
  const request_id = genReqId();
  const { searchParams } = new URL(request.url);
  const state = searchParams.get("state");
  const stateCookie = request.cookies.get(STATE_COOKIE)?.value;
  const code = searchParams.get("code");
  const error = searchParams.get("error");

  if (!state || !stateCookie || state !== stateCookie) {
    return clearStateCookie(NextResponse.json({ error: "invalid_oauth_state" }, { status: 400 }));
  }

  if (error) {
    const desc = searchParams.get("error_description") || "";
    logger.error(
      {
        request_id,
        operation: "oauth_callback",
        oauth_error: error,
        oauth_error_description: desc,
      },
      "[OAuth] Authorization failed",
    );
    return clearStateCookie(new NextResponse(
      "<html><body><h2>Authorization Failed</h2><p>Meta authorization was not completed. Close this tab.</p></body></html>",
      { headers: { "content-type": "text/html; charset=utf-8" } }
    ));
  }

  if (!code) {
    return clearStateCookie(new NextResponse("No code parameter", { status: 400 }));
  }

  try {
    const tokenData = await exchangeCode(code, request_id);
    if (tokenData?.access_token) {
      // Save to Supabase meta_tokens table instead of filesystem
      await saveTokenToSupabase(tokenData.access_token, tokenData.expires_in || 0, request_id);

      logger.info(
        {
          request_id,
          operation: "oauth_callback",
          expires_in: tokenData.expires_in,
        },
        "[OAuth] SUCCESS ? token saved",
      );

      return clearStateCookie(new NextResponse(
        `<html><body><h2>Authorization Successful!</h2><p>Token saved. Close this tab.</p></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } }
      ));
    }

    logger.error(
      {
        request_id,
        operation: "oauth_callback",
      },
      "[OAuth] Token exchange returned no access_token",
    );
    return clearStateCookie(new NextResponse(
      `<html><body><h2>Token Exchange Failed</h2><p>Check server logs.</p></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } }
    ));
  } catch (e) {
    logger.error(
      {
        err: e,
        request_id,
        operation: "oauth_callback",
      },
      "[OAuth] Exchange error",
    );
    return clearStateCookie(new NextResponse(
      "<html><body><h2>Error</h2><p>Authorization could not be completed. Close this tab.</p></body></html>",
      { headers: { "content-type": "text/html; charset=utf-8" } }
    ));
  }
}

async function exchangeCode(code: string, request_id: string) {
  const params = new URLSearchParams({
    client_id: APP_ID,
    redirect_uri: REDIRECT_URI,
    client_secret: APP_SECRET,
    code,
  });

  logger.info(
    {
      request_id,
      operation: "oauth_callback",
      redirect_uri: REDIRECT_URI,
    },
    "[OAuth] Exchanging code",
  );

  const resp = await fetch(
    `https://graph.facebook.com/v22.0/oauth/access_token?${params}`,
    { cache: "no-store" }
  );

  if (!resp.ok) {
    logger.error(
      {
        request_id,
        operation: "oauth_callback",
        http_status: resp.status,
      },
      "[OAuth] Token exchange HTTP error",
    );
    return null;
  }

  const data = await resp.json();

  if (data.access_token) {
    // Exchange for long-lived token
    return exchangeLongLived(data.access_token, request_id);
  }

  logger.error(
    {
      request_id,
      operation: "oauth_callback",
    },
    "[OAuth] Short token exchange failed",
  );
  if (data.error) {
    logger.error(
      {
        err: data.error,
        request_id,
        operation: "oauth_callback",
        fb_error_type: data.error?.type,
        fb_error_code: data.error?.code,
        fb_error_subcode: data.error?.error_subcode,
        fb_fbtrace_id: data.error?.fbtrace_id,
      },
      "[OAuth] Facebook error",
    );
  }
  return null;
}

async function exchangeLongLived(shortToken: string, request_id: string) {
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
      logger.error(
        {
          request_id,
          operation: "oauth_callback",
          http_status: resp.status,
        },
        "[OAuth] Long-lived exchange HTTP error",
      );
      return { access_token: shortToken, expires_in: 3600 };
    }

    const data = await resp.json();
    logger.info(
      {
        request_id,
        operation: "oauth_callback",
        expires_in: data.expires_in,
      },
      "[OAuth] Long-lived token",
    );
    if (data.error) {
      logger.error(
        {
          err: data.error,
          request_id,
          operation: "oauth_callback",
          fb_error_type: data.error?.type,
          fb_error_code: data.error?.code,
          fb_error_subcode: data.error?.error_subcode,
          fb_fbtrace_id: data.error?.fbtrace_id,
        },
        "[OAuth] Long-lived token error",
      );
    }
    return data;
  } catch (e) {
    logger.error(
      {
        err: e,
        request_id,
        operation: "oauth_callback",
      },
      "[OAuth] Long-lived exchange failed, using short token",
    );
    return { access_token: shortToken, expires_in: 3600 };
  }
}
