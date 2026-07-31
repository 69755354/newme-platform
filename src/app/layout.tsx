import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { HtmlLangSync } from "@/components/HtmlLangSync";
import MetaPixel from "@/components/MetaPixel";
import { PostHogProviderWrapper } from "@/components/PostHogProvider";
import { ErrorBoundary } from "@/components/error-boundary";

const geistSans = localFont({
  src: "./fonts/Geist-Variable.woff2",
  variable: "--font-geist-sans",
  display: "swap",
});
const geistMono = localFont({
  src: "./fonts/GeistMono-Variable.woff2",
  variable: "--font-geist-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "NewMe OS",
  description: "Smart Home Business Platform",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased bg-[#F5F3EF]`}>
        <HtmlLangSync />
        <MetaPixel />
        <PostHogProviderWrapper>
          <ErrorBoundary>
            {children}
          </ErrorBoundary>
        </PostHogProviderWrapper>
      </body>
    </html>
  );
}
