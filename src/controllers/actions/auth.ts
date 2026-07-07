"use server";

import { createServerSupabase } from "@/models/supabase-server";

interface CurrentUser {
  id: string;
  role: string | null;
  email: string | null;
}

/**
 * Server action: resolve the current user's id, role, and email from the session cookie.
 * Returns null if no valid session — caller handles redirect.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, email")
    .eq("id", user.id)
    .single();

  return {
    id: user.id,
    role: profile?.role ?? null,
    email: profile?.email ?? null,
  };
}
