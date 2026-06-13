"use client";

import { createClient } from "@/lib/supabase";

// Track once per page load for page_view
let lastPageViewPath: string | null = null;
let loginTracked = false;

/**
 * Log user activity via the log_activity RPC.
 * This replaces direct writes to the old `activities` table.
 */
export async function trackActivity(
  action: "login" | "logout" | "page_view" | "create" | "update" | "delete",
  opts?: {
    entity_type?: string;
    entity_id?: string;
    details?: Record<string, unknown>;
    page_path?: string;
    duration_seconds?: number;
  }
) {
  try {
    const supabase = createClient();

    // Use RPC call — this auto-updates both activity_logs and user_session_daily
    const { error } = await supabase.rpc("log_activity", {
      p_action: action,
      p_entity_type: opts?.entity_type ?? null,
      p_entity_id: opts?.entity_id ?? null,
      p_details: opts?.details ?? null,
      p_page_path: opts?.page_path ?? null,
      p_duration_seconds: opts?.duration_seconds ?? null,
    });

    if (error) {
      // Swallow in production — tracking must never break the app
      if (process.env.NODE_ENV !== "production") {
        console.warn("[activity-tracker] Failed:", error.message);
      }
    }
  } catch {
    // No-op: tracking failure must never crash the app
  }
}

/**
 * Track page view (debounced — once per path per page load)
 */
export function trackPageView(pathname: string) {
  if (lastPageViewPath === pathname) return;
  lastPageViewPath = pathname;
  trackActivity("page_view", { page_path: pathname });
}

/**
 * Track login event (once per page load)
 */
export function trackLogin() {
  if (loginTracked) return;
  loginTracked = true;
  trackActivity("login", { page_path: "/login" });
}

/**
 * Reset tracking state (call on logout or unmount)
 */
export function resetTracker() {
  lastPageViewPath = null;
  loginTracked = false;
}
