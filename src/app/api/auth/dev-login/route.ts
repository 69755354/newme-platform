import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

/**
 * POST /api/auth/dev-login — only available in non-production NODE_ENV.
 * Signs in as the dev user and returns session info.
 */
export async function POST() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "disabled in production" }, { status: 403 });
  }

  const DEV_EMAIL = process.env.DEV_EMAIL || "dev@newme.ae";
  const DEV_PASSWORD = process.env.DEV_PASSWORD || "dev123456";

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  const supabase = createClient(supabaseUrl, supabaseKey);

  const { data, error } = await supabase.auth.signInWithPassword({
    email: DEV_EMAIL,
    password: DEV_PASSWORD,
  });

  if (error || !data.session) {
    // Trigger dev setup and retry
    try {
      await fetch(`${process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3001"}/api/dev/setup`, {
        method: "POST",
      });
      const { data: retryData, error: retryErr } = await supabase.auth.signInWithPassword({
        email: DEV_EMAIL,
        password: DEV_PASSWORD,
      });
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
