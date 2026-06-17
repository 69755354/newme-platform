"use client";

import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase";

function identifyUser(user: { id: string; email?: string }) {
  if (!user?.id) return;
  posthog.identify(user.id, {
    email: user.email || "",
  });
}

export function PHProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!key) return;

    const supabase = createClient();

    posthog.init(key, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://eu.posthog.com",
      capture_exceptions: true,
      capture_pageview: true,
      capture_pageleave: true,
      session_recording: {
        maskAllInputs: false,
        maskTextSelector: "",
      },
      loaded: () => {
        setReady(true);
      },
    });

    // Identify on load, then re-identify on auth state changes (login/logout).
    // Reads the session from the @supabase/ssr cookie — no localStorage (the
    // browser client no longer writes localStorage).
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) identifyUser({ id: user.id, email: user.email ?? undefined });
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        identifyUser({ id: session.user.id, email: session.user.email ?? undefined });
      } else {
        posthog.reset();
      }
    });

    return () => {
      sub.subscription.unsubscribe();
    };
  }, []);

  if (!ready) return <>{children}</>;
  return <PostHogProvider client={posthog}>{children}</PostHogProvider>;
}
