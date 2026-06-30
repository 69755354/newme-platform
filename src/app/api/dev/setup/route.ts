import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Dev setup: ensure dev@newme.ae user exists and is email-confirmed
export async function POST() {
  if (process.env.NODE_ENV === "production" || process.env.NEXT_PUBLIC_DEV_MODE !== "true") {
    return NextResponse.json({ error: "Not in dev mode" }, { status: 403 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const DEV_EMAIL = "dev@newme.ae";
  const DEV_PASSWORD = "dev123456";

  try {
    // Check if user already exists
    const { data: existing } = await admin.auth.admin.listUsers();
    const devUser = existing?.users?.find((u: any) => u.email === DEV_EMAIL);

    if (devUser) {
      // User exists — ensure email is confirmed
      if (!devUser.email_confirmed_at) {
        await admin.auth.admin.updateUserById(devUser.id, {
          email_confirm: true,
        });
      }
    } else {
      // Create + confirm in one shot
      const { data: newUser, error: createErr } = await admin.auth.admin.createUser({
        email: DEV_EMAIL,
        password: DEV_PASSWORD,
        email_confirm: true,
      });

      if (createErr) {
        return NextResponse.json({ error: createErr.message }, { status: 500 });
      }
    }

    // Ensure profile row exists with admin role (upsert)
    const { data: profileUser } = await admin.auth.admin.listUsers();
    const user = profileUser?.users?.find((u: any) => u.email === DEV_EMAIL);
    if (user) {
      const { data: profile } = await admin.from("profiles").select("id,role").eq("id", user.id).maybeSingle();
      if (!profile) {
        await admin.from("profiles").insert({
          id: user.id,
          email: DEV_EMAIL,
          role: "admin",
          full_name: "Dev Mode",
        });
      } else if (profile.role !== "admin") {
        await admin.from("profiles").update({ role: "admin", email: DEV_EMAIL }).eq("id", user.id);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    const message = (process.env.NODE_ENV as string) === "production" ? "Internal server error" : (err.message || "Setup failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
