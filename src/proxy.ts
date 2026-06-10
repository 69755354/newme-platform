import { NextResponse, NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";

const PROTECTED_ROUTES: Record<string, string[]> = {
  "/settings": ["admin", "boss", "operator"],
  "/team": ["admin", "boss", "operator"],
  "/pipeline": ["admin", "boss", "operator"],
};

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Check if this path requires specific roles
  let requiredRoles: string[] | null = null;
  for (const [prefix, roles] of Object.entries(PROTECTED_ROUTES)) {
    if (pathname === prefix || pathname.startsWith(prefix + "/")) {
      requiredRoles = roles;
      break;
    }
  }

  if (!requiredRoles) {
    return NextResponse.next();
  }

  // Get auth cookies
  const authCookie = request.cookies.get(
    "sb-vfopmpxlhwzpxqegayew-auth-token"
  );

  if (!authCookie?.value) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  try {
    const session = JSON.parse(decodeURIComponent(authCookie.value));
    const accessToken = session?.access_token;

    if (!accessToken) {
      const loginUrl = new URL("/login", request.url);
      return NextResponse.redirect(loginUrl);
    }

    // Decode JWT payload
    const payload = JSON.parse(
      Buffer.from(accessToken.split(".")[1], "base64").toString()
    );
    const userId = payload.sub;

    if (!userId) {
      const loginUrl = new URL("/login", request.url);
      return NextResponse.redirect(loginUrl);
    }

    // Fetch role from profiles
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return NextResponse.next();
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", userId)
      .single();

    const userRole = profile?.role;

    if (!userRole || !requiredRoles.includes(userRole)) {
      const dashboardUrl = new URL("/dashboard", request.url);
      return NextResponse.redirect(dashboardUrl);
    }
  } catch (e) {
    console.error("Proxy auth check error:", e);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/settings/:path*",
    "/team/:path*",
    "/pipeline/:path*",
  ],
};
