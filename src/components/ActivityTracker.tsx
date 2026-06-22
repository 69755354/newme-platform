"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

/**
 * Tracks real page navigations by listening to pathname changes.
 * Sends POST /api/activity/track on every navigation.
 * 5-min throttle is server-side (DB check on profiles.last_active_at).
 *
 * Does NOT track heartbeat/polling — only actual navigations.
 * Does NOT render anything — pure side-effect.
 */
export function ActivityTracker() {
  const pathname = usePathname();
  const lastTracked = useRef<string | null>(null);

  useEffect(() => {
    // Don't track on mount (GET handled by proxy.ts)
    // Only track subsequent navigations
    if (lastTracked.current === null) {
      lastTracked.current = pathname;
      return;
    }
    if (lastTracked.current === pathname) return;
    lastTracked.current = pathname;

    fetch("/api/activity/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page: pathname }),
    }).catch(() => {
      // No-op: tracking must never break the app
    });
  }, [pathname]);

  return null;
}
