"use client";

import { useEffect } from "react";
import { isVersionSkewError, reloadOnceForVersionSkew } from "@/lib/deployment-skew";

/**
 * Catch server-action failures caused by a release that happened while this
 * tab was open (the action id no longer exists on the server) and reload the
 * tab once. Rejections that a caller already handles never reach here; those
 * surface as the caller's own error message until the next navigation, which
 * Next.js itself turns into a full reload via deploymentId.
 */
export function useVersionSkewReload() {
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => {
      if (isVersionSkewError(event.reason) && reloadOnceForVersionSkew()) event.preventDefault();
    };
    const onError = (event: ErrorEvent) => {
      if (isVersionSkewError(event.error) && reloadOnceForVersionSkew()) event.preventDefault();
    };
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("error", onError);
    return () => {
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("error", onError);
    };
  }, []);
}
