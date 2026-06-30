# NewMe CRM — UI System Audit Reference

> 蒸馏自 Next.js 16 + Tailwind CSS 4 + shadcn/ui 源码  
> 导出时间: 2026-06-05 · 不含业务逻辑，纯 UI/UX 层

---

## 一、Design Tokens

### 1.1 品牌色系 (Dark Mode — 实际使用)

| Token | Hex | OKLCH | 用途 |
|-------|-----|-------|------|
| `--background` | `#1E2328` | — | 全局背景（深炭灰） |
| `--foreground` | `#EAE6DF` | — | 全局前景（暖奶油） |
| `--card` | `rgba(245,240,236,0.06)` | — | 卡片背景 6% 透 |
| `--card-foreground` | `#EAE6DF` | — | 卡片文字 |
| `--popover` | `rgba(30,35,40,0.95)` | — | 弹出层 |
| `--primary` | `#D4A373` | — | 主色 = 铜色 |
| `--primary-foreground` | `#1E2328` | — | 主色上文字（深底） |
| `--secondary` | `rgba(245,240,236,0.08)` | — | 次要背景 |
| `--muted` | `rgba(245,240,236,0.06)` | — | 弱化背景 |
| `--muted-foreground` | `rgba(234,230,223,0.7)` | — | 弱化文字 70% 透 |
| `--accent` | `rgba(212,163,115,0.15)` | — | 强调背景 15% 铜 |
| `--accent-foreground` | `#D4A373` | — | 强调文字 = 铜色 |
| `--destructive` | `#9B2D5E` | — | 破坏/错误 = 酒红 |
| `--border` | `rgba(234,230,223,0.15)` | — | 边框 15% 透 |
| `--input` | `rgba(234,230,223,0.12)` | — | 输入框 12% 透 |
| `--ring` | `#D4A373` | — | 聚焦环 = 铜色 |

### 1.2 扩展品牌色

**铜色 (Copper)** — 主品牌色
```
copper-50:  #FAF6F0    copper-400: #D4A373 ← PRIMARY
copper-100: #F5EDE1    copper-500: #C48A52
copper-200: #EBD9C1    copper-600: #A87040
copper-300: #E0C4A0    copper-700: #8C5A32
```

**酒红 (Wine)** — 强调/危险
```
wine-400: #D96A8A    wine-500: #9B2D5E ← DESTRUCTIVE
wine-600: #82254E    wine-700: #6A1D3F
```

**暖色表面 (Cream/Ink)** — Light mode 备用
```
cream:        #F5F0EC
cream-bright: #EAE6DF
ink:          #2C2420
ink-muted:    #3A3028
charcoal:     #1E2328 ← ≈ background
```

**Legacy Gold** — 向后兼容
```
gold-400: #E0B95A    gold-500: #D4A843
gold-600: #C49A3C    gold-700: #B28931
```

### 1.3 图表色 (Chart)

```
chart-1: #D4A373 (copper-primary)    chart-4: #3A3028 (ink-muted)
chart-2: #C48A52 (copper-500)        chart-5: #EAE6DF (cream-bright)
chart-3: #9B2D5E (wine-500)
```

### 1.4 侧边栏 (Sidebar)

```
sidebar:                  #1A1F24 (略深于背景)
sidebar-foreground:       #EAE6DF
sidebar-primary:          #D4A373
sidebar-accent:           rgba(245,240,236,0.06)
sidebar-border:           rgba(234,230,223,0.12)
sidebar-ring:             #D4A373
```

### 1.5 半径 (Radius)

```
--radius:      0.625rem (10px)      radius-sm:  0.375rem (6px)
radius-md:     0.5rem   (8px)       radius-lg:  0.625rem
radius-xl:     0.875rem (14px)      radius-2xl: 1.125rem (18px)
radius-3xl:    1.375rem (22px)      radius-4xl: 1.625rem (26px)
```

### 1.6 字体

```
font-sans:    var(--font-sans)      ← Geist (默认 Next.js 字体)
font-mono:    var(--font-geist-mono)
font-heading: var(--font-sans)      ← 标题同正文字体
```

### 1.7 字号与使用模式

| 尺寸 | Tailwind Class | 使用场景 |
|------|---------------|---------|
| `text-[10px]` | — | 极小文字（版本号、角色标签、状态点） |
| `text-[11px]` | — | 副标签、角色徽章 |
| `text-xs` | `text-xs` (12px) | 辅助文字、筛选器标签 |
| `text-[13px]` | — | 导航菜单项 |
| `text-sm` | `text-sm` (14px) | 正文、卡片内容、表格 |
| `text-base` | `text-base` (16px) | 标题 (Logo "N") |
| `text-xl` | `text-xl` (20px) | Logo 区域 |
| `text-2xl` | `text-2xl` (24px) | 页面标题、登录标题 |

### 1.8 字重

```
font-medium:  导航激活项、卡片标题
font-semibold: 按钮、重要数值
font-bold:     Logo、KPI 大数字、统计卡片主数值
```

---

## 二、Layout 系统

### 2.1 整体结构

```
┌─────────────────────────────────────────┐
│ ┌──────────┬──────────────────────────┐ │
│ │          │  Top Header Bar           │ │
│ │ Sidebar  │  (sticky, backdrop-blur)  │ │
│ │          ├──────────────────────────┤ │
│ │ w-64     │                          │ │
│ │ #1A1D22  │  Main Content            │ │
│ │          │  p-6                     │ │
│ │          │                          │ │
│ └──────────┴──────────────────────────┘ │
└─────────────────────────────────────────┘
```

- 容器: `min-h-screen bg-background text-foreground flex`
- 侧边栏: `w-64`, fixed on mobile (`lg:static`), `bg-[#1A1D22]` (非 token 硬编码)
- 主内容: `flex-1 min-w-0 flex flex-col`
- 内容区 padding: `p-6`

### 2.2 侧边栏导航

- 平铺结构，无分组
- 菜单项: `flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px]`
- 激活态: `bg-copper-500/10 text-copper-400 font-medium`
- 默认态: `text-muted-foreground hover:text-foreground hover:bg-accent`
- 图标尺寸: `w-4 h-4 shrink-0` (Lucide icons)
- 11 项管理导航 + 6 项销售导航

### 2.3 顶栏 (Top Header Bar)

```css
flex items-center justify-end gap-3 px-6 py-2.5
border-b border-border/50
bg-background/80 backdrop-blur-sm
sticky top-0 z-30
```

- 仅在 `role` 或 `authError` 存在时显示
- 右侧: 用户头像 (7×7 `bg-copper-500/20` 圆形) + 邮箱 + 角色标签 + 退出按钮

### 2.4 响应式

- 移动端汉堡菜单: `fixed top-3 left-3 z-50 lg:hidden`
- 遮罩层: `fixed inset-0 bg-black/60 z-40 lg:hidden`
- 侧边栏: `translate-x-0` (开) / `-translate-x-full lg:translate-x-0` (关/桌面常显)

---

## 三、组件模式

### 3.1 状态色系统

| 状态 | 文字色 | 背景色 | 边框色 |
|------|--------|--------|--------|
| 紧急/过热 | `text-rose-400` | `bg-rose-500/10` | `ring-rose-500/30` |
| 警告/中等 | `text-amber-400` | `bg-amber-500/10` | `ring-amber-500/30` |
| 成功/已完成 | `text-emerald-400` | `bg-emerald-500/10` | `border-emerald-700/50` |
| 信息/进行中 | `text-blue-400` | `bg-blue-500/10` | `border-blue-700/50` |
| 中性/默认 | `text-muted-foreground` | `bg-accent` | `border-border` |
| 热力 (hot) | `text-rose-400` | `bg-rose-500/10` | — |
| 温暖 (warm) | `text-amber-400` | `bg-amber-500/10` | — |
| 冷 (cold) | `text-sky-400` | `bg-sky-500/10` | — |
| 休眠 (dormant) | `text-gray-400` | `bg-gray-500/10` | — |

### 3.2 9 阶段管道颜色

```
new:               #6B7280  gray-500
contacted:         #C48A52  copper-500
requirement_confirmed: #E0B95A gold-400
solution_submitted: #9B2D5E  wine-500
quotation_submitted: #8B5CF6 purple-500
negotiation:       #3B82F6  blue-500
pending_decision:  #F59E0B  amber-500
won:               #4ADE80  green-400
lost:              #6B7280  gray-500
```

### 3.3 卡片 (Card)

**统计卡片 (KPI card):**
```
bg-card border border-border rounded-xl p-4
hover:bg-card/80 transition-colors
```

**可操作卡片 (Lead card):**
```
p-3 rounded-lg border bg-gray-900/60
cursor-grab active:cursor-grabbing
hover:bg-gray-800/80 hover:border-gray-600
```
- 热力指示: `ring-1 ring-rose-500/30`
- 严重过期: `ring-2 ring-red-500/40`
- 警告过期: `ring-1 ring-amber-500/30`
- 已赢: `border-emerald-700/50 bg-emerald-950/20`
- 已丢: `border-gray-700/30 bg-gray-900/40`

**功能卡片:**
```
bg-[#1A1D22] border border-border/40 rounded-xl
```

### 3.4 按钮 (Button)

- 主按钮: `bg-gradient-to-r from-gold-500 to-gold-600 text-black font-semibold`
- 次要按钮: `border border-border text-muted-foreground hover:bg-accent`
- 图标按钮: `p-2 rounded-lg bg-accent text-muted-foreground`
- 小按钮: `text-[10px]`, `text-[13px]`
- 加载态: `disabled:opacity-50`

### 3.5 输入框 (Input)

```
bg-gray-900 border-gray-700 text-white
rounded-lg h-9 px-3 text-sm
focus:border-copper-500 focus:ring-1 focus:ring-copper-500
```

### 3.6 徽章 (Badge)

```
inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full
text-[11px] font-medium
```

角色徽章:
- 管理: `bg-purple-500/10 text-purple-400 border border-purple-500/20`
- 销售: `bg-emerald-500/10 text-emerald-400 border border-emerald-500/20`

### 3.7 进度条

```
h-2 rounded-full bg-muted overflow-hidden
```
- 填充条: `h-full rounded-full transition-all`
- 颜色逻辑: `>= expectedPct` → `bg-emerald-500`, 否则 → `bg-amber-500`
- 文字颜色: 同逻辑 `text-emerald-400` / `text-amber-400` / `text-muted-foreground`

### 3.8 分隔线

```
h-px bg-border mx-3
```
或
```
border-t border-border
```

---

## 四、页面 UI 模式

### 4.1 Dashboard (`/dashboard`)

**Today's 5 Actions（L4 今日待办）:**
- 主区块标题 + 5 个行动项
- 每项: 图标 + 标题 + 副标题 + 价值 + 优先级标签 + 链接
- 优先级: `high` → 红色左边框, `medium` → 琥珀色, `low` → 灰色
- 无数据: "No pending actions" 居中显示

**KPI 卡片 2 列 (L1 财务):**
- 签单完成率 + 回款完成率
- 完成率%: `text-4xl font-bold` 大号主视觉
- 金额: `text-sm text-muted-foreground` 次要信息
- 进度条 + 目标对比
- 时间比例着色 (与期望进度比较)

**市场情报 (L2):**
- 来源分布: 水平条形图（来源 × 线索数 × 赢单数）
- 管道健康: 阶段分布 + 高价值线索
- 风险池: 超期未跟进数

**销售排行 (L3):**
- 每个销售的签单额、赢单数、管道额、活跃线索
- 联系人率、转化率
- KPI 完成率 (时间比例着色)

**压缩区域 (L4):**
- 今日待办: 一行摘要 或 快速行动
- 最近活动摘要

### 4.2 Leads (`/leads`)

- 卡片网格布局: `grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4`
- 每个线索卡片: 客户名 + 阶段徽章 + 价值 + 来源 + 状态
- 过滤器: 搜索 + 阶段/状态/来源下拉
- 快速创建: 弹窗对话框
- 排序: updated_at DESC

### 4.3 Pipeline (`/pipeline`)

- 看板视图: 9 列横排 `flex gap-3 overflow-x-auto`
- 每列: 阶段标题 + 线索数 + 金额合计
- 可拖拽卡片 (HTML5 Drag & Drop)
- 悬停态: 抓取光标 + 拖拽手柄 (drag handle)
- 列背景: 不同阶段的暗色背景变体

### 4.4 Quotes (`/quotes`)

- SSR 数据获取 (`force-dynamic`)
- 客户端: `QuotesClient` + `initialData`
- 报价单列表 + 产品选择器
- COS 下载链接

### 4.5 Login (`/login`)

- 居中卡片: `min-h-screen bg-black flex items-center justify-center p-4`
- 卡片: `w-full max-w-md border-gold-500/20 bg-gray-950`
- Logo: `w-12 h-12 rounded-xl bg-gradient-to-br from-gold-500 to-gold-700` + "N"
- 表单: email + password input → gradient button
- 错误: `text-red-400 text-sm`

---

## 五、UX 模式

### 5.1 加载状态

- 全页加载: `flex items-center justify-center h-64 text-muted-foreground text-sm` → "Loading..."
- Suspense fallback: 同上
- 局部加载: 骨架屏 (未实现，使用条件渲染)
- 按钮加载: `disabled` + loading 文本

### 5.2 错误状态

- `ErrorState` 组件: "加载失败，请刷新重试" + 重试按钮
- 连接错误: `text-rose-400 text-sm` "Connection failed" + Retry
- Toast 通知: `sonner` 库, `position="top-center" richColors`

### 5.3 空状态

- 无数据时返回 `null` 或 "No pending actions" 等文本
- 空数组处理: 条件渲染，不报错

### 5.4 交互反馈

- 悬停: `hover:bg-*`, `hover:text-*`, `hover:border-*`
- 过渡: `transition-colors`, `transition-all duration-150`
- 点击: `active:cursor-grabbing` (拖拽), `cursor-pointer`
- 选择: `ring-1` / `ring-2` 指示选中/拖拽目标

### 5.5 通知 (Toast)

```
<Toaster position="top-center" richColors />
```
- 成功: 绿色
- 错误: 红色
- 信息: 蓝色

### 5.6 Modal / Dialog

```
bg-[#1A1D22] border border-border/40 rounded-xl
backdrop: bg-black/80
```
- shadcn/ui Dialog 组件
- 关闭: × 按钮 + 点击遮罩

### 5.7 i18n

- 中英文双语 (`LanguageContext`)
- 导航标签: `{ zh: "驾驶舱", en: "Dashboard" }`
- 动态文本: `t("key")` 函数
- 语言切换: `LanguageToggle` 按钮 (侧边栏顶部)

---

## 六、代码约定

### 6.1 命名

- 组件文件: kebab-case (`lead-workflow.tsx`)
- 函数组件: PascalCase (`DashboardPage`)
- 内联函数: camelCase (`fmtAED`, `daysSince`)
- CSS 类: Tailwind utility classes (无自定义 class 名，除 shadcn/ui 外)
- 常量: UPPER_SNAKE (`STAGES`, `MGMT_NAV`)

### 6.2 图标

- 来源: `lucide-react`
- 尺寸: `w-4 h-4` (nav), `w-5 h-5` (mobile), `w-3 h-3` (小标签)
- 使用模式: 导入时解构，使用时 `<IconName className="w-4 h-4 shrink-0" />`

### 6.3 数值格式化

- 金额: `fmtAED(v)` → AED + K/M/LocaleString
- 日期: `daysSince(d)` → 天数差
- 百分比: `Math.round(value * 100)` → 整数

### 6.4 条件样式

```tsx
className={cn(
  "base-classes",
  isActive && "active-classes",
  isError ? "error-classes" : "normal-classes"
)}
```

---

## 七、已知问题 / 待改进

1. **侧边栏背景硬编码**: `bg-[#1A1D22]` 未使用 CSS 变量 `--sidebar`
2. **未使用 brand 扩展色**: copper-50~300, wine-50~300, cream/ink 未实际使用
3. **2 套 gold token**: `gold-*` (legacy) 和 `copper-*` (brand) 并存，导航已迁移但部分页面仍用 gold
4. **无骨架屏**: 加载时只显示文字 "Loading..."
5. **移动端优化不足**: 看板横向滚动无触控优化，拖拽不支持触屏
6. **键盘导航**: 未测试 Tab 序、焦点环可见性
7. **暗色模式硬假设**: Light mode CSS variable 已定义但未使用 `dark` class 切换
8. **无响应式断点文档**: 仅有 `lg:` 和 `md:` / `xl:` 少数断点
9. **卡片背景不一致**: `bg-gray-900/60` vs `bg-[#1A1D22]` vs `bg-card`
10. **Font size 碎片化**: 使用 `text-[10px]`, `text-[11px]`, `text-[13px]` 等非标准值
