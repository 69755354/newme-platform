"use client";

import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import { useEffect, useState } from "react";

function identifyUser() {
  if (typeof window === "undefined") return;
  try {
    const raw = localStorage.getItem("sb-vfopmpxlhwzpxqegayew-auth-token");
    if (!raw) return;
    const session = JSON.parse(raw);
    if (!session?.access_token) return;

    // Decode JWT to get user info
    const payload = JSON.parse(atob(session.access_token.split(".")[1]));
    if (payload?.sub) {
      posthog.identify(payload.sub, {
        email: payload.email || "",
        role: payload.role || "",
      });
    }
  } catch {}
}

export function PHProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!key) return;

    posthog.init(key, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://eu.posthog.com",
      capture_exceptions: true,
      capture_pageview: true,
      capture_pageleave: true,
      // T3-2: Web Vitals auto-capture (LCP/CLS/FCP/INP via bundled web-vitals callbacks)
      // Note: posthog-js v1.386.6 ships web-vitals callbacks by default.
      // capture_performance: true enables the performance event stream they emit to.
      capture_performance: true,
      session_recording: {
        maskAllInputs: false,
        maskTextSelector: "",
      },
      loaded: () => {
        setReady(true);
        identifyUser();
      },
    });

    // Re-identify on storage changes (login/logout)
    window.addEventListener("storage", (e) => {
      if (e.key === "sb-vfopmpxlhwzpxqegayew-auth-token") {
        identifyUser();
      }
    });
  }, []);

  if (!ready) return <>{children}</>;
  return <PostHogProvider client={posthog}>{children}</PostHogProvider>;
}
