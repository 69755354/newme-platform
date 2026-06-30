"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Calculator, Package, FileText, Briefcase, Users, Megaphone, Settings, type LucideIcon } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageContext";

const ICON_MAP: Record<string, LucideIcon> = {
  calculator: Calculator,
  package: Package,
  "file-text": FileText,
  briefcase: Briefcase,
  users: Users,
  megaphone: Megaphone,
  settings: Settings,
};

interface SubNavTabsProps {
  items: {
    href: string;
    labelKey: string;
    iconName?: string;
  }[];
}

export default function SubNavTabs({ items }: SubNavTabsProps) {
  const pathname = usePathname();
  const { t } = useLanguage();

  return (
    <nav className="flex items-center gap-1 mb-5 border-b border-border pb-0 overflow-x-auto">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(item.href + "/");
        const Icon = item.iconName ? ICON_MAP[item.iconName] : null;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium rounded-t-lg border-b-2 -mb-[1px] transition-colors whitespace-nowrap",
              active
                ? "border-slate-600 text-slate-700 bg-slate-600/5"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
            )}
          >
            {Icon && <Icon className="w-4 h-4" />}
            {t(item.labelKey)}
          </Link>
        );
      })}
    </nav>
  );
}
