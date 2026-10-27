// RBAC: public
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

import { resolveDevIdentity } from "@/lib/dev-identity.mjs";

/**
 * POST /api/dev/setup — ensure the development identity exists and is confirmed.
 *
 * Round-4 review A0: this route used to carry the identity's password as a
 * source literal and create it with an `admin` profile row, in a public
 * repository. The credential now comes from the environment or the route
 * refuses; see src/lib/dev-identity.mjs for why "unconfigured" must fail rather
 * than fall back, and supabase/preflight/f02-credential-cutover.md for the
 * production side, which this branch does not perform.
 */
export async function POST() {
  const identity = resolveDevIdentity();
  if (!identity.ok) {
    return NextResponse.json({ error: identity.reason }, { status: identity.status });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    // The old code asserted these with `!` and would have thrown a stack trace
    // out of a public route instead of saying what was missing.
    return NextResponse.json({ error: "dev_setup_supabase_unconfigured" }, { status: 503 });
  }

  const admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    // Check if user already exists
    const { data: existing } = await admin.auth.admin.listUsers();
    const devUser = existing?.users?.find((u: any) => u.email === identity.email);

    if (devUser) {
      // User exists — ensure email is confirmed. The password is deliberately
      // not re-applied: this route provisions an identity, and silently
      // resetting an existing account's credential is how a bootstrap endpoint
      // becomes a password-reset endpoint without an authorisation check.
      if (!devUser.email_confirmed_at) {
        await admin.auth.admin.updateUserById(devUser.id, {
          email_confirm: true,
        });
      }
    } else {
      // Create + confirm in one shot
      const { error: createErr } = await admin.auth.admin.createUser({
        email: identity.email,
        password: identity.password,
        email_confirm: true,
      });

      if (createErr) {
        return NextResponse.json({ error: createErr.message }, { status: 500 });
      }
    }

    // Ensure profile row exists with admin role (upsert)
    const { data: profileUser } = await admin.auth.admin.listUsers();
    const user = profileUser?.users?.find((u: any) => u.email === identity.email);
    if (user) {
      const { data: profile } = await admin.from("profiles").select("id,role").eq("id", user.id).maybeSingle();
      if (!profile) {
        await admin.from("profiles").insert({
          id: user.id,
          email: identity.email,
          role: "admin",
          full_name: "Dev Mode",
        });
      } else if (profile.role !== "admin") {
        await admin.from("profiles").update({ role: "admin", email: identity.email }).eq("id", user.id);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    const message = (process.env.NODE_ENV as string) === "production" ? "Internal server error" : (err.message || "Setup failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
