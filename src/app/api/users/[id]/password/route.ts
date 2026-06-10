import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// ─── Cookie helpers ───
// The auth cookie can be in two formats:
//  1. Base64-encoded JSON (set by login page via btoa)
//  2. Raw JSON (set by @supabase/ssr after token refresh)
function parseCookieValue(cookieHeader: string): Record<string, any> | null {
  const m = cookieHeader.match(
    /sb-vfopmpxlhwzpxqegayew-auth-token(?:\.\d+)?=([^;]+)/
  );
  if (!m) return null;
  const raw = m[1];
  // Try raw JSON first (format set by @supabase/ssr middleware)
  try {
    return JSON.parse(raw);
  } catch {}
  // Try base64-encoded JSON (format set by login page)
  try {
    const decoded = atob(raw);
    return JSON.parse(decoded);
  } catch {}
  // Fallback: URI-decoded (legacy)
  try {
    return JSON.parse(decodeURIComponent(raw));
  } catch {}
  return null;
}

function parseAccessTokenFromCookie(request: Request): string | null {
  const cookie = request.headers.get("cookie") || "";
  const session = parseCookieValue(cookie);
  return session?.access_token ?? null;
}

// Verify current user via access token, returns user id or null
async function verifyUser(request: Request): Promise<string | null> {
  const accessToken = parseAccessTokenFromCookie(request);
  if (!accessToken) return null;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  try {
    const resp = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        "apikey": serviceKey,
        "Authorization": `Bearer ${accessToken}`,
      },
    });
    if (!resp.ok) return null;
    const user = await resp.json();
    return user?.id ?? null;
  } catch {
    return null;
  }
}

// GET /api/users/[id]/password — Admin/boss view password hint
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: targetId } = await params;
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const adminClient = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    // Verify current user role from access token
    const userId = await verifyUser(request);
    if (!userId) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const { data: profile } = await adminClient
      .from("profiles").select("role").eq("id", userId).single();

    if (!profile || !["admin", "boss"].includes(profile.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Fetch target user's full_name (no longer store plaintext passwords)
    const { data: target, error } = await adminClient
      .from("profiles")
      .select("full_name")
      .eq("id", targetId)
      .single();

    if (error || !target) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    return NextResponse.json({ hint: "Password was reset. User should check email or contact admin.", full_name: target.full_name });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Internal error" }, { status: 500 });
  }
}

// PATCH /api/users/[id]/password — Reset password
// For [id]="change-password" — user changes own password
// For [id]=user-uuid — admin/boss resets target user's password
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: targetId } = await params;
    const body = await request.json();
    const { password } = body;

    if (!password || password.length < 6) {
      return NextResponse.json({ error: "Password must be at least 6 characters" }, { status: 400 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const adminClient = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    // Self-change: get current user from request cookie
    if (targetId === "change-password") {
      const accessToken = parseAccessTokenFromCookie(request);
      if (!accessToken) {
        return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
      }

      try {
        // Call Auth API to update self
        const resp = await fetch(`${supabaseUrl}/auth/v1/user`, {
          method: "PUT",
          headers: {
            "apikey": serviceKey,
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ password }),
        });

        if (!resp.ok) {
          const err = await resp.json();
          return NextResponse.json({ error: err.msg || err.message || "Update failed" }, { status: 400 });
        }

        const userData = await resp.json();
        // Note: passwords are no longer stored in profiles
        return NextResponse.json({ success: true });
      } catch {
        return NextResponse.json({ error: "Session invalid" }, { status: 401 });
      }
    }

    // Admin/boss reset: verify current user role
    const userId = await verifyUser(request);
    if (!userId) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const { data: profile } = await adminClient
      .from("profiles").select("role").eq("id", userId).single();

    if (!profile || !["admin", "boss"].includes(profile.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Reset target user's password
    const { error } = await adminClient.auth.admin.updateUserById(targetId, { password });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });

    // Note: passwords are no longer stored in profiles
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Internal error" }, { status: 500 });
  }
}
