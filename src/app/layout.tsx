import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { HtmlLangSync } from "@/components/HtmlLangSync";
import MetaPixel from "@/components/MetaPixel";
import { PHProvider } from "@/lib/posthog-provider";
import { WebVitalsReporter } from "@/lib/WebVitalsReporter";
import { ErrorBoundary } from "@/components/error-boundary";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "NewMe CRM",
  description: "Smart Home Business Platform",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased bg-[#F5F3EF]`}>
        <HtmlLangSync />
        <MetaPixel />
        <PHProvider>
          <WebVitalsReporter />
          <ErrorBoundary>
            {children}
          </ErrorBoundary>
        </PHProvider>
      </body>
    </html>
  );
}
