"use client";

import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import { useEffect, useState } from "react";

async function identifyUser() {
  if (typeof window === "undefined") return;
  try {
    const response = await fetch("/api/auth/me", { credentials: "same-origin" });
    if (!response.ok) return;
    const session = await response.json();
    if (session?.userId) {
      posthog.identify(session.userId, {
        email: session.email || "",
        role: session.role || "",
      });
    }
  } catch {
    // Analytics identification is optional; authenticated app flow remains server-owned.
  }
}

export default function PostHogProviderInner({
  children,
}: {
  children: React.ReactNode;
}) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!key) return;

    posthog.init(key, {
      api_host:
        process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://eu.posthog.com",
      capture_exceptions: true,
      capture_pageview: true,
      capture_pageleave: true,
      session_recording: {
        maskAllInputs: false,
        maskTextSelector: "",
      },
      loaded: () => {
        setReady(true);
        void identifyUser();
      },
    });
  }, []);

  if (!ready) return <>{children}</>;
  return <PostHogProvider client={posthog}>{children}</PostHogProvider>;
}
