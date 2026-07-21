import { createServerSupabase } from "@/lib/supabase-server";
import { isActiveProfile } from "@/lib/auth-profile.mjs";

export interface AuthProfile {
  userId: string;
  role: string;
}

export async function getAuthProfile(bearerToken?: string, cookieHeader?: string): Promise<AuthProfile | null> {
  const supabase = await createServerSupabase(bearerToken, cookieHeader);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("role, is_active")
    .eq("id", user.id)
    .single();
  if (!profile || !isActiveProfile(profile)) return null;
  return { userId: user.id, role: profile.role };
}

export function isAdminOrBoss(profile: AuthProfile): boolean {
  return profile.role === "admin"
    || profile.role === "boss"
    || profile.role === "operator";
}

export async function canAccessLead(leadId: string, profile: AuthProfile, bearerToken?: string, cookieHeader?: string): Promise<boolean> {
  if (isAdminOrBoss(profile)) return true;
  const supabase = await createServerSupabase(bearerToken, cookieHeader);
  const { data: lead } = await supabase
    .from("leads")
    .select("assigned_to")
    .eq("id", leadId)
    .single();
  return lead?.assigned_to === profile.userId;
}
