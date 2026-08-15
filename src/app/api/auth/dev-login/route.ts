// RBAC: public
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { resolveDevIdentity } from "@/lib/dev-identity.mjs";

/**
 * POST /api/auth/dev-login — only available in non-production NODE_ENV.
 * Signs in as the dev user and returns session info.
 *
 * Round-4 review A0: the credential used to be
 * `process.env.DEV_PASSWORD || "<published literal>"`, so an unset variable
 * meant "use the password that is in the git history" rather than "refuse".
 * resolveDevIdentity() has no default; see src/lib/dev-identity.mjs.
 */
export async function POST() {
  const identity = resolveDevIdentity();
  if (!identity.ok) {
    return NextResponse.json({ error: identity.reason }, { status: identity.status });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json({ error: "dev_login_supabase_unconfigured" }, { status: 503 });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const credentials = { email: identity.email, password: identity.password };

  const { data, error } = await supabase.auth.signInWithPassword(credentials);

  if (error || !data.session) {
    // Trigger dev setup and retry
    try {
      await fetch(`${process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3001"}/api/dev/setup`, {
        method: "POST",
      });
      const { data: retryData, error: retryErr } = await supabase.auth.signInWithPassword(credentials);
      if (retryErr || !retryData.session) {
        return NextResponse.json({ error: "dev_login_failed" }, { status: 401 });
      }
      return NextResponse.json({
        userId: retryData.session.user.id,
        email: retryData.session.user.email,
        role: "admin",
      });
    } catch {
      return NextResponse.json({ error: "dev_setup_failed" }, { status: 500 });
    }
  }

  return NextResponse.json({
    userId: data.session.user.id,
    email: data.session.user.email,
    role: "admin",
  });
}
