import { NextResponse } from "next/server";
import {
  applySessionCookies,
  expectedSessionOrigin,
  hasAllowedSessionOrigin,
  normalizeExpiresIn,
} from "@/lib/session-cookies";

// Session bootstrap from tokens the caller already holds. The password login
// path is POST /api/auth/login, which grants and validates server side.
// Cookie attributes and payload shape live in @/lib/session-cookies so this
// endpoint and the login endpoint can never drift apart.

export { expectedSessionOrigin };

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type")?.split(";")[0].trim();
    if (contentType !== "application/json") {
      return NextResponse.json({ error: "invalid_content_type" }, { status: 415 });
    }
    if (!hasAllowedSessionOrigin(request)) {
      return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
    }

    const body = await request.json();
    const accessToken = typeof body.access_token === "string" ? body.access_token : "";
    const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";

    if (!accessToken || !refreshToken) {
      return NextResponse.json({ error: "invalid_session" }, { status: 400 });
    }

    return applySessionCookies(NextResponse.json({ ok: true }), {
      accessToken,
      refreshToken,
      expiresIn: normalizeExpiresIn(body.expires_in),
    });
  } catch {
    return NextResponse.json({ error: "invalid_session" }, { status: 400 });
  }
}
