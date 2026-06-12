"use client";

import { useEffect } from "react";

function reportError(message: string, stack?: string, type = "frontend") {
  try {
    const payload = {
      message: message.slice(0, 1000),
      stack: stack?.slice(0, 2000) || "",
      type,
      url:
        typeof window !== "undefined" ? window.location.href : "",
    };
    fetch("/api/monitoring/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      // fire-and-forget
      keepalive: true,
    }).catch(() => {});
  } catch {
    // silently fail — monitoring should never break the app
  }
}

export function ErrorMonitor() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    // Catch unhandled errors
    const onError = (event: ErrorEvent) => {
      reportError(event.message, event.error?.stack);
    };

    // Catch unhandled promise rejections
    const onRejection = (event: PromiseRejectionEvent) => {
      const msg =
        event.reason?.message || String(event.reason);
      reportError(msg, event.reason?.stack);
    };

    // Catch console.error calls (for caught errors that are logged)
    const origConsoleError = console.error;
    console.error = (...args: any[]) => {
      origConsoleError.apply(console, args);
      const firstArg = args[0];
      if (firstArg instanceof Error) {
        reportError(firstArg.message, firstArg.stack, "backend");
      } else if (typeof firstArg === "string" && firstArg.length < 500) {
        reportError(firstArg, "", "backend");
      }
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      console.error = origConsoleError;
    };
  }, []);

  return null;
}
