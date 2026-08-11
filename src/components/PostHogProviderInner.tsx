"use client";

import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import { useEffect, useState } from "react";
import { peekSessionIdentity } from "@/lib/session-identity";

async function identifyUser() {
  if (typeof window === "undefined") return;
  try {
    // Analytics is not an authorization decision, so reuse the session read the
    // dashboard already performed rather than adding a second round trip.
    const session = await peekSessionIdentity();
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
