"use client";

import { LanguageProvider } from "@/views/i18n/LanguageContext";

/**
 * (auth) route-group layout.
 * The (auth) group sits OUTSIDE the (dashboard) layout, so it does not inherit
 * the dashboard's LanguageProvider. Pages here (e.g. change-password) call
 * useLanguage() and would crash at prerender with "must be used within
 * LanguageProvider" without this wrapper. Keep it minimal — just the i18n provider.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <LanguageProvider>{children}</LanguageProvider>;
}
