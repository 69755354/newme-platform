"use client";

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { translations, type Language } from "./translations";

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

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Language>("en");

  useEffect(() => {
    const saved = localStorage.getItem("newme-lang");
    if (saved === "en" || saved === "zh") setLangState(saved);
  }, []);

  const setLang = useCallback((l: Language) => {
    setLangState(l);
    localStorage.setItem("newme-lang", l);
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
