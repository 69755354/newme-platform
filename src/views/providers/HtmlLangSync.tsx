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

    // Listen for storage changes (from LanguageProvider toggle)
    const handler = (e: StorageEvent) => {
      if (e.key === "newme-lang" && (e.newValue === "en" || e.newValue === "zh")) {
        document.documentElement.lang = e.newValue;
      }
    };
    window.addEventListener("storage", handler);

    // Also poll for changes in the same tab (since LanguageProvider sets via setItem)
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
