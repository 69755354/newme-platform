// RBAC: public
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { logger, genReqId } from "@/lib/logger";
import {
  IntegrationExecutionError,
  createIntegrationLogSinks,
  integrationFetch,
} from "@/lib/integration-execution.mjs";

const STATE_COOKIE = "meta_oauth_state";

function metaOAuthConfiguration() {
  const appId = process.env.META_APP_ID?.trim() ?? "";
  const appSecret = process.env.META_APP_SECRET?.trim() ?? "";
  const redirectUri = process.env.META_REDIRECT_URI?.trim() ?? "";
  if (!appId || !appSecret || !redirectUri) return null;
  try {
    const parsed = new URL(redirectUri);
    if (parsed.protocol !== "https:" || parsed.pathname !== "/api/meta/oauth-callback") {
      return null;
    }
  } catch {
    return null;
  }
  return { appId, appSecret, redirectUri };
}

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

async function reportOAuthFailure(
  sinks: ReturnType<typeof createIntegrationLogSinks>,
  operation: string,
  reason: string,
) {
  const event = {
    integration: "meta_oauth",
    operation,
    outcome: "failure",
    attempts: 1,
    reason,
  };
  await sinks.audit(event);
  await sinks.alert(event);
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

  // Upsert — id=1 ensures a single row (singleton pattern)
  const { error } = await supabase.from("meta_tokens").upsert(
    {
      id: 1,
      access_token: accessToken,
      expires_at: expiresAt,
    },
    { onConflict: "id" },
  );

  if (error) {
    throw new Error("meta_token_persistence_failed", { cause: error });
  }
  logger.info(
    {
      integration_audit: true,
      integration: "meta_oauth",
      request_id,
      operation: "token_persistence",
      outcome: "success",
      expires_at: expiresAt,
    },
    "[OAuth] Token saved to Supabase meta_tokens",
  );
}

export async function GET(request: NextRequest) {
  const request_id = genReqId();
  const config = metaOAuthConfiguration();
  if (!config) {
    return clearStateCookie(NextResponse.json(
      {
        status: "disabled",
        integration: "meta_oauth",
        reason: "not_configured",
      },
      {
        status: 503,
        headers: { "Cache-Control": "no-store, max-age=0" },
      },
    ));
  }
  const sinks = createIntegrationLogSinks({
    logger,
    requestId: request_id,
    route: "/api/meta/oauth-callback",
  });
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
    await sinks.audit({
      integration: "meta_oauth",
      operation: "authorization",
      outcome: "failure",
      attempts: 1,
      reason: "authorization_denied",
    });
    return clearStateCookie(new NextResponse(
      "<html><body><h2>Authorization Failed</h2><p>Meta authorization was not completed. Close this tab.</p></body></html>",
      { headers: { "content-type": "text/html; charset=utf-8" } }
    ));
  }

  if (!code) {
    return clearStateCookie(new NextResponse("No code parameter", { status: 400 }));
  }

  try {
    const tokenData = await exchangeCode(code, request_id, config, sinks);
    if (tokenData?.access_token) {
      // Save to Supabase meta_tokens table instead of filesystem
      await saveTokenToSupabase(tokenData.access_token, tokenData.expires_in || 0, request_id);

      logger.info(
        {
          request_id,
          operation: "oauth_callback",
          expires_in: tokenData.expires_in,
        },
        "[OAuth] SUCCESS — token saved",
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
    const executionAlreadyAlerted = (
      e instanceof Error
      && "code" in e
      && e.code === "integration_operation_failed"
    );
    if (!executionAlreadyAlerted) {
      await reportOAuthFailure(sinks, "oauth_callback", "callback_failed");
    }
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

async function exchangeCode(
  code: string,
  request_id: string,
  config: { appId: string; appSecret: string; redirectUri: string },
  sinks: ReturnType<typeof createIntegrationLogSinks>,
) {
  const params = new URLSearchParams({
    client_id: config.appId,
    redirect_uri: config.redirectUri,
    client_secret: config.appSecret,
    code,
  });

  logger.info(
    {
      request_id,
      operation: "oauth_callback",
    },
    "[OAuth] Exchanging code",
  );

  const { response: resp } = await integrationFetch({
    integration: "meta_oauth",
    operation: "short_token_exchange",
    url: `https://graph.facebook.com/v22.0/oauth/access_token?${params}`,
    audit: sinks.audit,
    alert: sinks.alert,
  });

  const data = await resp.json();

  if (data.access_token) {
    // Exchange for long-lived token
    return exchangeLongLived(data.access_token, request_id, config, sinks);
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
  await reportOAuthFailure(sinks, "short_token_payload", "access_token_missing");
  throw new IntegrationExecutionError("integration_operation_failed");
}

async function exchangeLongLived(
  shortToken: string,
  request_id: string,
  config: { appId: string; appSecret: string; redirectUri: string },
  sinks: ReturnType<typeof createIntegrationLogSinks>,
) {
  const params = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: config.appId,
    client_secret: config.appSecret,
    fb_exchange_token: shortToken,
  });

  const { response: resp } = await integrationFetch({
    integration: "meta_oauth",
    operation: "long_token_exchange",
    url: `https://graph.facebook.com/v22.0/oauth/access_token?${params}`,
    audit: sinks.audit,
    alert: sinks.alert,
  });
  const data = await resp.json();
  logger.info(
    {
      request_id,
      operation: "oauth_callback",
      expires_in: data.expires_in,
    },
    "[OAuth] Long-lived token",
  );
  if (!data.access_token) {
    await reportOAuthFailure(sinks, "long_token_payload", "access_token_missing");
    throw new IntegrationExecutionError("integration_operation_failed");
  }
  return data;
}
