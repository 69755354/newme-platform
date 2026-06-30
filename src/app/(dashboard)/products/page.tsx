"use client";

import { useState, useEffect, useMemo } from "react";
import { createClient } from "@/lib/supabase";
import { useSupabaseQuery } from "@/lib/supabaseQuery";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { useRequireRole } from "@/hooks/useRequireRole";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  Search, X, Grid3X3, List, Package, Wifi,
  Cpu, SunMedium, Fan, Shield, Music,
  Cable, Wrench, Building2, ArrowLeft, Upload,
} from "lucide-react";
import Link from "next/link";
import ProductImportDialog from "@/components/ProductImportDialog";

/* ─── Category config ─── */
const CATEGORIES = [
  { key: "all", icon: Package },
  { key: "knx", icon: Cpu },
  { key: "hvac", icon: Fan },
  { key: "audio", icon: Music },
  { key: "network", icon: Wifi },
  { key: "security", icon: Shield },
  { key: "intercom", icon: Building2 },
  { key: "cable", icon: Cable },
  { key: "service", icon: Wrench },
  { key: "lighting", icon: SunMedium },
];

const CATEGORY_COLORS: Record<string, string> = {
  knx: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  hvac: "bg-rose-500/10 text-rose-400 border-rose-500/20",
  audio: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  network: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  security: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  intercom: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
  cable: "bg-gray-500/10 text-muted-foreground border-gray-500/20",
  service: "bg-copper-500/10 text-copper-400 border-copper-500/20",
  lighting: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  other: "bg-gray-500/10 text-muted-foreground border-gray-500/20",
};

// Map DB category keys to i18n keys (cable → cables, service → services)
const CATEGORY_I18N_MAP: Record<string, string> = {
  all: "all", knx: "knx", hvac: "hvac", audio: "audio",
  network: "network", security: "security", intercom: "intercom",
  cable: "cables", service: "services", lighting: "lighting",
};

export default function ProductsPage() {
  const supabase = createClient();
  const { t } = useLanguage();
  const { loading: roleLoading } = useRequireRole(["admin", "boss", "operator", "sales"]);

  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("all");
  const [importOpen, setImportOpen] = useState(false);

  // Fetch products using useSupabaseQuery
  const { data: rawProducts, loading, error, refetch } = useSupabaseQuery<any[]>(
    async () => {
      return await supabase
        .from("products")
        .select("*")
        .order("category")
        .order("name");
    },
    []
  );
  const products = rawProducts || [];

  const filtered = useMemo(() => {
    let result = products || [];
    if (activeCategory !== "all") {
      result = result.filter((p) => p.category === activeCategory);
    }
    if (search.trim()) {
      const s = search.toLowerCase().trim();
      result = result.filter(
        (p) =>
          p.name.toLowerCase().includes(s) ||
          (p.sku && p.sku.toLowerCase().includes(s)) ||
          (p.description && p.description.toLowerCase().includes(s))
      );
    }
    return result;
  }, [products, search, activeCategory]);

  const categoryCounts = useMemo(() => {
    const items = products || [];
    const counts: Record<string, number> = { all: items.length };
    for (const p of items) {
      counts[p.category] = (counts[p.category] || 0) + 1;
    }
    return counts;
  }, [products]);

  // Role guard — must be AFTER all hooks
  if (roleLoading) return <div className="text-center py-16 text-muted-foreground">{t("common.loading")}</div>;

  return (
    <div className="space-y-4">
      <Link href="/quotes" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-1">
        <ArrowLeft className="w-3.5 h-3.5" />
        {t("products.backToQuotes")}
      </Link>
      {/* ─── Header ─── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight">
            {t("products.title")}
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {t("products.resultsCount").replace("{shown}", String(products.length)).replace("{total}", String(products.length))}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setImportOpen(true)}
          className="h-8 gap-1.5 text-xs border-gray-700 text-gray-300 hover:bg-gray-800 hover:text-white"
        >
          <Upload className="w-3.5 h-3.5" />
          {t("products.importBtn")}
        </Button>
      </div>

      {/* ─── Search ─── */}
      <div className="relative max-w-xs">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder={t("products.searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9 h-9 text-sm pr-8"
        />
        {search && (
          <button
            onClick={() => setSearch("")}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* ─── Category Tabs ─── */}
      <div className="flex gap-1.5 flex-wrap">
        {CATEGORIES.map((cat) => {
          const Icon = cat.icon;
          const count = categoryCounts[cat.key] || 0;
          const isActive = activeCategory === cat.key;
          const i18nKey = CATEGORY_I18N_MAP[cat.key] || cat.key;
          return (
            <button
              key={cat.key}
              onClick={() => setActiveCategory(cat.key)}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
                isActive
                  ? "bg-copper-500/20 text-copper-400 border border-copper-500/30"
                  : "bg-muted/60 text-muted-foreground border border-transparent hover:bg-muted/60 hover:text-foreground"
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {t(`products.categories.${i18nKey}`)}
              <span className="text-[10px] opacity-60 ml-0.5">({count})</span>
            </button>
          );
        })}
      </div>

      {/* ─── Results count ─── */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {t("products.resultsCount").replace("{shown}", String(filtered.length)).replace("{total}", String(products.length))}
        </p>
      </div>

      {/* ─── Loading ─── */}
      {loading ? (
        <div className="text-center text-muted-foreground py-16 text-sm">
          {t("common.loading")}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center text-muted-foreground py-16 text-sm">
          {t("products.noResults")}
        </div>
      ) : (
        /* ─── Product Grid ─── */
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {filtered.map((p) => {
            const colorClass = CATEGORY_COLORS[p.category] || CATEGORY_COLORS.other;
            const catI18nKey = CATEGORY_I18N_MAP[p.category] || p.category;
            return (
              <div
                key={p.id}
                className="p-4 rounded-xl border border-border/50 bg-card hover:border-copper-500/30 hover:shadow-sm hover:shadow-copper-500/5 transition-all group"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground group-hover:text-copper-400 transition-colors truncate">
                      {p.name}
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                      {p.sku && (
                        <span className="text-[10px] font-mono text-muted-foreground/60">
                          {p.sku}
                        </span>
                      )}
                      <Badge className={cn("text-[9px] px-1 py-0 border", colorClass)}>
                        {t(`products.categories.${catI18nKey}`)}
                      </Badge>
                    </div>
                  </div>
                  <span className="text-base font-bold text-copper-400 shrink-0">
                    AED {p.unit_price?.toLocaleString()}
                  </span>
                </div>

                {p.description && (
                  <p className="text-[11px] text-muted-foreground/70 mt-2 line-clamp-2 leading-relaxed">
                    {p.description}
                  </p>
                )}

                <div className="flex items-center gap-2 mt-2.5 text-[10px] text-muted-foreground/50">
                  <span className="bg-muted/60 px-1.5 py-0.5 rounded">
                    {p.unit || t("products.unitPcs")}
                  </span>
                  {p.brand && (
                    <span className="bg-muted/60 px-1.5 py-0.5 rounded">
                      {p.brand}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <ProductImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => refetch()}
      />
    </div>
  );
}
