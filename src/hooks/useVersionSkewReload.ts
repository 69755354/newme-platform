"use client";

import { useEffect } from "react";
import { isVersionSkewError, probeServerRelease, reloadOnceForVersionSkew } from "@/lib/deployment-skew.mjs";

/**
 * Two guards against a release that happened while this tab was open:
 *
 *   - server-action failures that nobody caught (the action id no longer
 *     exists on the server) reload the tab once instead of surfacing as a
 *     cryptic error;
 *   - when the tab comes back to the foreground (visibilitychange / focus) the
 *     server's release is probed, throttled to once a minute, so a tab that sat
 *     in the background through a deploy reloads before the user presses a
 *     button whose action handler has its own try/catch (confirm payment,
 *     approve, reassign ...) and would otherwise only show that catch's error.
 */
export function useVersionSkewReload() {
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => {
      if (isVersionSkewError(event.reason) && reloadOnceForVersionSkew()) event.preventDefault();
    };
    const onError = (event: ErrorEvent) => {
      if (isVersionSkewError(event.error) && reloadOnceForVersionSkew()) event.preventDefault();
    };
    const onReturn = () => {
      if (document.visibilityState === "visible") void probeServerRelease();
    };
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("error", onError);
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("error", onError);
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, []);
}
