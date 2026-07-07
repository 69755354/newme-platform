"use client";

import Link from "next/link";
import { LanguageProvider, useLanguage } from "@/lib/i18n/LanguageContext";

function NotFoundContent() {
  const { lang } = useLanguage();

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      minHeight: "100vh",
      fontFamily: "system-ui, sans-serif",
      color: "#666",
    }}>
      <h1 style={{ fontSize: "4rem", margin: 0, color: "#ccc" }}>404</h1>
      <p style={{ fontSize: "1.1rem", margin: "1rem 0" }}>
        {lang === "zh" ? "页面不存在" : "Page not found"}
      </p>
      <Link
        href="/dashboard"
        style={{
          marginTop: "1rem",
          padding: "0.6rem 1.5rem",
          background: "#4A5568",
          color: "white",
          borderRadius: "6px",
          textDecoration: "none",
        }}
      >
        {lang === "zh" ? "返回工作台" : "Back to Workbench"}
      </Link>
    </div>
  );
}

export default function NotFound() {
  return (
    <LanguageProvider>
      <NotFoundContent />
    </LanguageProvider>
  );
}
