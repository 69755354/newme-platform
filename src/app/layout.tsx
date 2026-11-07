import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { HtmlLangSync } from "@/components/HtmlLangSync";
import MetaPixel from "@/components/MetaPixel";
import { ErrorBoundary } from "@/components/error-boundary";
import { cookies } from "next/headers";
import { InitialLanguage } from "@/lib/i18n/LanguageContext";
import { DEFAULT_LANGUAGE, LANGUAGE_COOKIE, parseLanguage } from "@/lib/i18n/language-preference.mjs";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "NewMe OS",
  description: "Smart Home Business Platform",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // S6 (review 4d #21): render the first HTML in the user's chosen language.
  const lang = parseLanguage((await cookies()).get(LANGUAGE_COOKIE)?.value);
  return (
    <html lang={lang ?? DEFAULT_LANGUAGE}>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased bg-[#F5F3EF]`}>
        <HtmlLangSync />
        <MetaPixel />
        <ErrorBoundary>
          <InitialLanguage lang={lang}>{children}</InitialLanguage>
        </ErrorBoundary>
      </body>
    </html>
  );
}
