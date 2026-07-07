"use client";

import { useLanguage } from "@/views/i18n/LanguageContext";
import { Button } from "@/views/ui/button";
import { Globe } from "lucide-react";

export function LanguageToggle() {
  const { lang, toggleLang } = useLanguage();

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={toggleLang}
      className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
    >
      <Globe className="w-4 h-4" />
      <span className="text-xs font-medium">{lang === "en" ? "中文" : "EN"}</span>
    </Button>
  );
}
