# NewMe V4 前端非功能验收门

状态：Target。下列性能数字是 **provisional budgets（暂定预算）**，必须在 F0 用锁定测试设备、网络、数据规模和真实 baseline 复测后批准；未批准前不能作为生产达标事实。

## 1. 暂定性能预算

| 场景 | 数据规模 | 浏览器/设备 | 网络 | 暂定预算 | 证据 |
|---|---|---|---|---|---|
| S02 首屏 | 100 work items；20 可见 | Chrome current-1，4 vCPU/8 GB desktop | 50 Mbps/40 ms | LCP <=2.5s；INP <=200ms；CLS <=0.1 | Lighthouse trace + RUM release cohort |
| S03 团队命令 | 10 teams；10k active items 聚合 | Chrome current-1，4 vCPU/8 GB | 50 Mbps/40 ms | API p95 <=800ms；可交互 <=3s | server timing + browser trace |
| S06/S18 大列表 | 100k records；page 50 | Chrome current-1；Edge current-1 | 20 Mbps/100 ms | page switch p95 <=1s；无 >200ms main-thread task | HAR + performance trace |
| S07/S15/S19 工作区 | 500 timeline facts | Chrome current-1；Safari current-1 on supported macOS | 20 Mbps/100 ms | route transition p95 <=1.5s；action feedback <=100ms | trace + command correlation |
| 320px mobile | 20 visible items | Safari current-1 iOS；Chrome current-1 Android | Fast 3G profile | LCP <=4s；无页面级双向滚动 | device capture + axe/manual |
| noisy neighbor | 10 orgs；1 org 10x load | Chrome synthetic + API harness | controlled | 其他 org p95 退化 <20%；零跨租户缓存 | paired traces + tenant negatives |

支持矩阵首发候选：Chrome/Edge 当前及前一主版本、Safari 当前及前一主版本、Firefox 当前及前一主版本；iOS Safari 和 Android Chrome 当前主版本。F0 必须记录精确版本、OS、viewport、CPU/network profile 后才能把候选改为 approved。

## 2. 可执行无障碍矩阵

| Gate | 屏幕/旅程 | 自动化 | 人工 | 通过证据模板字段 |
|---|---|---|---|---|
| A11Y-01 | S01/S02/S03/S04/S07/S12/S15/S18/S19/S21/S24 | axe: 0 critical/serious | keyboard-only J1-J6 | SHA, route, viewport, browser, axe artifact, keystroke script, result |
| A11Y-02 | 所有 dialog/approval/command | role/name/state assertions | focus move/trap/restore；Esc/Cancel | component ID, trigger, focus before/inside/after, recording |
| A11Y-03 | 列表、表格、Kanban | semantic table/list checks | screen reader headings/row labels；非拖拽替代 | AT/browser/version, utterance log, alternative action result |
| A11Y-04 | 错误/denied/conflict/confirming | live-region assertions | NVDA+Chrome、VoiceOver+Safari 状态播报 | state, message key, announcement, repetition count |
| A11Y-05 | 320 CSS px/400% zoom | screenshot diff + horizontal overflow check | 内容/功能完整、二维例外登记 | viewport, zoom, overflow nodes, exception approval |
| A11Y-06 | Touch/RTL/i18n | target size >=24 CSS px automated inventory | primary controls 44 px target；Arabic RTL/long English/Chinese | locale, direction, control IDs, dimensions, screenshots |

证据文件名：`<SHA>_<AC-ID>_<screen>_<browser>_<viewport>_<result>.<json|png|webm>`。JSON 必填：`release_sha`、`artifact_sha256`、`environment`、`organization_fixture`、`role`、`screen_id`、`journey_id`、`browser`、`browser_version`、`os`、`viewport`、`assistive_technology`、`automated_result`、`manual_result`、`failures`、`cleanup`、`reviewer`、`completed_at`。凭据与 PII 禁止写入证据。

## 3. Release 判定

- provisional budget 任一未形成 approved baseline，只能记录“未测/待批准”，不能写 PASS。
- 自动化 A11y 不能替代人工键盘、screen reader、zoom/reflow；任一关键旅程没有两类证据即 G5 NO-GO。
- 性能/A11y 结果必须绑定 exact SHA、artifact 和环境；重建 artifact 或更换关键浏览器版本需重跑受影响矩阵。
- 发现跨租户缓存、L3/L4 可绕过、关键动作丢失或 screen reader 无法完成时直接 NO-GO，不用平均分抵消。
