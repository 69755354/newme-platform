"use client";

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { translations, type Language } from "./translations";
import { DEFAULT_LANGUAGE, languageCookie, parseLanguage } from "./language-preference.mjs";

type NestedKeyOf<T> = T extends object
  ? { [K in keyof T]: `${K & string}${T[K] extends object ? `.${NestedKeyOf<T[K]>}` : ""}` }[keyof T]
  : never;

type TranslationPath = NestedKeyOf<typeof translations.en>;

interface LanguageContextType {
  lang: Language;
  setLang: (lang: Language) => void;
  toggleLang: () => void;
  t: (path: string) => string;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

// S6 (review 4d #21): the language the server already rendered with, read from
// the `newme-lang` cookie by the root layout. Starting from it (instead of a
// hard-coded "en") removes the English flash before the switch to Chinese.
const InitialLanguageContext = createContext<Language | null>(null);

export function InitialLanguage({ lang, children }: { lang: Language | null; children: ReactNode }) {
  return <InitialLanguageContext.Provider value={lang}>{children}</InitialLanguageContext.Provider>;
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const initial = useContext(InitialLanguageContext);
  const [lang, setLangState] = useState<Language>(initial ?? DEFAULT_LANGUAGE);

  // Sessions from before the cookie existed: copy the choice over once so
  // the next page load renders in it straight away.
  useEffect(() => {
    const parsed = parseLanguage(localStorage.getItem("newme-lang"));
    if (parsed && parsed !== initial) {
      document.documentElement.lang = parsed;
      document.cookie = languageCookie(parsed);
    }
  }, [initial]);

  useEffect(() => {
    const saved = localStorage.getItem("newme-lang");
    if (saved === "en" || saved === "zh") setLangState(saved);
  }, []);

  const setLang = useCallback((l: Language) => {
    // Keep the document language in the same synchronous transaction as the
    // visible copy. Storage events do not fire in the tab that performed the
    // write, so HtmlLangSync's cross-tab fallback cannot own this update.
    document.documentElement.lang = l;
    setLangState(l);
    localStorage.setItem("newme-lang", l);
    document.cookie = languageCookie(l);
  }, []);

  const toggleLang = useCallback(() => {
    setLang(lang === "en" ? "zh" : "en");
  }, [lang, setLang]);

  const t = useCallback(
    (path: string): string => {
      const keys = path.split(".");
      let value: any = translations[lang];
      for (const key of keys) {
        if (value && typeof value === "object") {
          value = value[key];
        } else {
          return path; // fallback to key path
        }
      }
      return typeof value === "string" ? value : path;
    },
    [lang]
  );

  return (
    <LanguageContext.Provider value={{ lang, setLang, toggleLang, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLanguage must be used within LanguageProvider");
  return ctx;
}
