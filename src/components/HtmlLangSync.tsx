"use client";

import { useEffect } from "react";

export function HtmlLangSync() {
  useEffect(() => {
    const saved = localStorage.getItem("newme-lang");
    if (saved === "en" || saved === "zh") {
      document.documentElement.lang = saved;
    } else {
      // detect browser language
      const browserLang = navigator.language?.startsWith("zh") ? "zh" : "en";
      document.documentElement.lang = browserLang;
    }

    // Listen for changes made by another tab. Same-tab changes are applied
    // synchronously by LanguageProvider before it updates the visible copy.
    const handler = (e: StorageEvent) => {
      if (e.key === "newme-lang" && (e.newValue === "en" || e.newValue === "zh")) {
        document.documentElement.lang = e.newValue;
      }
    };
    window.addEventListener("storage", handler);

    // Retain a bounded reconciliation fallback for legacy or external writers.
    const observer = setInterval(() => {
      const current = localStorage.getItem("newme-lang");
      if (current === "en" || current === "zh") {
        if (document.documentElement.lang !== current) {
          document.documentElement.lang = current;
        }
      }
    }, 500);

    return () => {
      window.removeEventListener("storage", handler);
      clearInterval(observer);
    };
  }, []);

  return null;
}
