export interface SupabaseCookieNames {
  authToken: string;
  refreshToken: string;
}

export function getSupabaseCookieNames(supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL): SupabaseCookieNames {
  try {
    const projectRef = new URL(supabaseUrl ?? "").hostname.split(".")[0];
    if (projectRef && projectRef !== "localhost") {
      return {
        authToken: `sb-${projectRef}-auth-token`,
        refreshToken: `sb-${projectRef}-refresh-token`,
      };
    }
  } catch {
    // Use the non-project-specific fallback when configuration is unavailable.
  }
  return { authToken: "sb-auth-token", refreshToken: "sb-refresh-token" };
}
