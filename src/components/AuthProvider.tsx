"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";

/**
 * AuthProvider — listens for Supabase auth state changes and tells Next.js
 * to refresh Server Components when the session changes.
 *
 * This solves the random logout bug: when the proxy.ts middleware refreshes
 * the cookie but the client still has stale Server Component cache, the user
 * gets kicked. onAuthStateChange detects TOKEN_REFRESHED and triggers a
 * router.refresh() to re-render all RSC with the new cookie.
 */
export default function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const supabase = useRef(createClient()).current;
  const refreshing = useRef(false);

  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      // Tokens were refreshed — refresh the page to re-render Server Components
      // with the new cookie. Throttle to avoid double-refresh storms.
      if (event === "TOKEN_REFRESHED" || event === "SIGNED_IN") {
        if (refreshing.current) return;
        refreshing.current = true;
        router.refresh();
        // Reset throttle after 2s to allow future refreshes
        setTimeout(() => {
          refreshing.current = false;
        }, 2000);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [supabase, router]);

  return <>{children}</>;
}
