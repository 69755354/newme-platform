"use client";

import { useEffect } from "react";

export function WebVitalsReporter() {
  useEffect(() => {
    import("@/services/web-vitals").then((m) => m.reportWebVitals());
  }, []);

  return null;
}
