import "server-only";

import { supabaseAdmin } from "@/lib/supabase-admin";

export interface TriggerCreatedUserProfileInput {
  email: string;
  fullName: string;
  role: string;
  phone?: string;
}

export interface ProfileFinalizationResult {
  ok: boolean;
  cleanupVerified: boolean;
}

export async function finalizeTriggerCreatedUserProfile(
  userId: string,
  input: TriggerCreatedUserProfileInput,
): Promise<ProfileFinalizationResult> {
  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .update({
      email: input.email,
      full_name: input.fullName,
      role: input.role,
      phone: input.phone || null,
      is_active: true,
      force_password_change: true,
    })
    .eq("id", userId)
    .select("id")
    .maybeSingle();

  if (profileError || profile?.id !== userId) {
    if (profileError) {
      console.error("[user-profile-provisioning] profile finalization failed:", profileError.message);
    } else {
      console.error("[user-profile-provisioning] profile finalization matched no user");
    }

    const { error: cleanupError } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (cleanupError) {
      console.error("[user-profile-provisioning] auth rollback failed:", cleanupError.message);
    }

    return { ok: false, cleanupVerified: !cleanupError };
  }

  return { ok: true, cleanupVerified: true };
}
