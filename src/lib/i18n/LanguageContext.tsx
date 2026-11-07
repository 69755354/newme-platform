"use client";

import { createContext, useContext, useEffect, useCallback, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { translations, type Language } from "./translations";
import { DEFAULT_LANGUAGE, languageAfterMount, languageCookie, parseLanguage } from "./language-preference.mjs";

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

// What the provider puts in context never changes while the page is open: the
// language the server rendered with, and the setter.
interface LanguageProviderValue {
  rendered: Language;
  setLang: (lang: Language) => void;
}

const LanguageContext = createContext<LanguageProviderValue | undefined>(undefined);

// S6 (review 4d #21): the language the server already rendered with, read from
// the `newme-lang` cookie by the root layout. Starting from it (instead of a
// hard-coded "en") removes the English flash before the switch to Chinese.
const InitialLanguageContext = createContext<Language | null>(null);

export function InitialLanguage({ lang, children }: { lang: Language | null; children: ReactNode }) {
  return <InitialLanguageContext.Provider value={lang}>{children}</InitialLanguageContext.Provider>;
}

// S13: the chosen language lives in localStorage, which the server cannot read, so
// it is exposed as an external store read with useSyncExternalStore. React renders
// the hydration pass of every component with the server snapshot (the language the
// server HTML used) and then re-renders just that component if the client snapshot
// differs. Putting the stored choice in React state or context instead changes the
// value above a Suspense boundary that may still be waiting to hydrate, and React
// throws error #418 for it (login page failed the production release check that way).
let chosenInThisPage: Language | null = null;
const listeners = new Set<() => void>();

function readStoredLanguage(): Language | null {
  try {
    return parseLanguage(localStorage.getItem("newme-lang"));
  } catch {
    return null;
  }
}

function subscribeLanguage(onChange: () => void) {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === "newme-lang" || e.key === null) {
      chosenInThisPage = null; // another tab changed it: storage wins again
      onChange();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

function notifyLanguageChanged() {
  listeners.forEach((l) => l());
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const initial = useContext(InitialLanguageContext);
  const rendered: Language = initial ?? DEFAULT_LANGUAGE;

  // After mount (never during render): make the document language and the cookie
  // match the stored choice, so the next page load is rendered in it by the server.
  useEffect(() => {
    const target = languageAfterMount(readStoredLanguage(), initial);
    if (!target) return;
    document.documentElement.lang = target.lang;
    if (target.writeCookie) document.cookie = languageCookie(target.lang);
  }, [initial]);

  const setLang = useCallback((l: Language) => {
    // Keep the document language in the same synchronous transaction as the
    // visible copy. Storage events do not fire in the tab that performed the
    // write, so HtmlLangSync's cross-tab fallback cannot own this update.
    document.documentElement.lang = l;
    chosenInThisPage = l;
    try {
      localStorage.setItem("newme-lang", l);
    } catch {
      // storage unavailable: the choice still holds for this page view
    }
    document.cookie = languageCookie(l);
    notifyLanguageChanged();
  }, []);

  const value = useMemo(() => ({ rendered, setLang }), [rendered, setLang]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextType {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLanguage must be used within LanguageProvider");
  const { rendered, setLang } = ctx;
  const getSnapshot = useCallback(() => chosenInThisPage ?? readStoredLanguage() ?? rendered, [rendered]);
  const getServerSnapshot = useCallback(() => rendered, [rendered]);
  const lang = useSyncExternalStore(subscribeLanguage, getSnapshot, getServerSnapshot);

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

  return useMemo(() => ({ lang, setLang, toggleLang, t }), [lang, setLang, toggleLang, t]);
}
