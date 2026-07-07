"use client";

/**
 * useDashboardScroll
 * ──────────────────
 * T2-1 (Taskboard): 统一滚动策略 — hook 版本.
 *
 * 适用场景: 页面已经用了一个根 div, 想把根 div 直接升级为 "dashboard 滚动容器"
 * 又不想换成 `<DashboardScrollContainer>` 组件.
 *
 * 用法:
 *   ```tsx
 *   const scrollProps = useDashboardScroll();
 *   return <div {...scrollProps}>...</div>;
 *   ```
 *
 * 也可以传 ref:
 *   ```tsx
 *   const myRef = useRef<HTMLDivElement>(null);
 *   const scrollProps = useDashboardScroll({ ref: myRef });
 *   return <div ref={myRef} {...scrollProps}>...</div>;
 *   ```
 *
 * 不应再用:
 *   - `min-h-screen` / `h-screen` / `100vh` on page root
 *   - `calc(100vh - 280px)` 等 magic number
 *   - 在根 div 同时声明 `overflow-y-scroll` (会和 layout.tsx 的 overflow-hidden 冲突)
 */

import { type Ref, useMemo } from "react";
import { cn } from "@/models/utils";

export interface UseDashboardScrollOptions {
  /** Variant: default = vertical scroll, contained = child handles its own scroll. */
  variant?: "default" | "contained";
  /** Forward a ref to the element (useful if you also need to call .scrollTo). */
  ref?: Ref<HTMLElement>;
  /** Allow horizontal scroll at the root (default: false). */
  allowHorizontalScroll?: boolean;
  /** Extra className to merge. */
  className?: string;
}

export function useDashboardScroll(options: UseDashboardScrollOptions = {}) {
  const { variant = "default", className, allowHorizontalScroll = false } = options;

  return useMemo(
    () => ({
      "data-dashboard-scroll": "",
      "data-variant": variant,
      className: cn(
        // h-full + min-h-0 lets the flex chain in layout.tsx dictate the
        // available space — no 100vh, no calc(), no magic numbers.
        "h-full min-h-0",
        variant === "contained" ? "overflow-hidden" : "overflow-y-auto",
        allowHorizontalScroll ? "overflow-x-auto" : "overflow-x-hidden",
        className
      ),
    }),
    [variant, className, allowHorizontalScroll]
  );
}

export default useDashboardScroll;
