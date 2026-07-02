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
      // T3-2: Web Vitals 由自定义 web-vitals.ts 收集，禁用 PostHog 自动收集避免双重采集
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
