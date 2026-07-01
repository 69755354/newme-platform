"use client";

/**
 * DashboardScrollContainer
 * ────────────────────────
 * T2-1 (Taskboard): 统一滚动策略.
 *
 * 为什么需要这个组件:
 *   之前每个页面用不同的方式处理滚动 (min-h-screen, 100vh, calc(100vh - 280px)
 *   等等), 导致:
 *     1. pipeline 用 calc(100vh - 280px) — 硬编码 magic number, 改 navbar 高度就破
 *     2. command-center / leads/[id]/timeline 用 min-h-screen — 和 layout 的 flex
 *        链条打架, 出现双滚动条
 *     3. 其他页面靠 layout 的 overflow-hidden "碰巧" 工作, 没有显式契约
 *
 * 设计原则:
 *   - **完全相对**: 不引用 100vh / 100dvh, 用 flex-1 + min-h-0 占满父级
 *   - **不打架 layout**: 父级是 layout.tsx 的 `<div className="flex-1 p-6 min-w-0 overflow-hidden">`,
 *     本组件用 `h-full` 占满父级可滚动区域, 滚动发生在此组件内部
 *   - **API 简洁**: 一个 default slot, 一个可选 `as` 多态, 一个 `variant` 控制横滚
 *
 * 用法:
 *   ```tsx
 *   <DashboardScrollContainer>
 *     <h1>My page</h1>
 *     <DataTable />
 *   </DashboardScrollContainer>
 *
 *   // 内部需要独立横滚 (Kanban / 横向表格):
 *   <DashboardScrollContainer>
 *     <h1>Pipeline</h1>
 *     <KanbanBoard />   {/* 内部自己处理横滚 *\/}
 *   </DashboardScrollContainer>
 *   ```
 *
 * 不应再用:
 *   - min-h-screen, h-screen, 100vh, calc(100vh - Xpx) in pages
 *   - 在根 div 用 overflow-y-scroll (会和 layout 的 overflow-hidden 双滚动)
 */

import { type ElementType, type ReactNode, type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export type DashboardScrollVariant = "default" | "contained" | "padded";

interface DashboardScrollContainerProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
  /**
   * Polymorphic element type. Defaults to `div`.
   * Use `section` / `article` when semantic HTML is preferred.
   */
  as?: ElementType;
  /**
   * Visual variant:
   *   - default:  h-full + overflow-y-auto (default, most pages)
   *   - contained: h-full + overflow-hidden (rare — child handles its own scroll, e.g. pipeline kanban)
   *   - padded: default + extra padding p-6 (pages that want built-in padding)
   */
  variant?: DashboardScrollVariant;
  /**
   * When true, also enable horizontal scroll at the root level.
   * Default false — horizontal scrolling should normally live in a child
   * (table wrapper, kanban) so the page header stays pinned.
   */
  allowHorizontalScroll?: boolean;
}

export function DashboardScrollContainer({
  children,
  as: Tag = "div",
  variant = "default",
  allowHorizontalScroll = false,
  className,
  ...rest
}: DashboardScrollContainerProps) {
  // T2-1: no calc(), no 100vh, no min-h-screen. h-full + min-h-0 lets the
  // flex chain in layout.tsx dictate the available space.
  const variantClass =
    variant === "contained"
      ? "h-full min-h-0 overflow-hidden"
      : variant === "padded"
      ? "h-full min-h-0 overflow-y-auto p-6"
      : "h-full min-h-0 overflow-y-auto";

  const overflowX = allowHorizontalScroll ? "overflow-x-auto" : "overflow-x-hidden";

  return (
    <Tag
      data-dashboard-scroll=""
      data-variant={variant}
      tabIndex={-1}
      className={cn(variantClass, overflowX, className)}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export default DashboardScrollContainer;
