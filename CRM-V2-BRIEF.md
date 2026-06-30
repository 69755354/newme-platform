# CRM v2 重构 Brief — 给所有总监

## 背景
NewMe智能家居公司，1个销售(Tanya)，266条线索(136活跃/130淘汰)。当前用Google Sheets管理，已有5阶段漏斗：线索池→意向→方案→报价→成交。

## 核心问题
CRM v2第一版做成了"美化版Google Sheets"——展示数据但不帮管理者做决策。

## 老板的真实需求（SAM原话提炼）
1. 打开dashboard，30秒知道：这个月能不能达标？哪里卡住了？谁该干什么？
2. 不是数据看板，是**管理驾驶舱**——有预警、有建议、有预测
3. 比Tanya现在用的Google Sheets产生**增量价值**，不是替代

## 需要各位总监回答的核心问题

### 产品总监
- Tanya的Google Sheets已经能做5阶段分类+筛选+金额追踪，CRM凭什么让她愿意切换？
- 268条线索/1个销售的场景下，什么功能真正产生管理价值？
- Linear/HubSpot/Pipedrive对这个规模的公司，哪个模式最适用？
- 第一版最少要包含哪3个"不可替代"的功能？

### 架构总监  
- 当前Next.js 16 + Supabase + shadcn/ui技术栈是否适合快速迭代？
- 数据模型是否需要重构？（funnel_stage与stage并存、无activities数据、无收入预测字段）
- 是否需要后台任务（cron）做预警计算？还是前端实时查询即可？

### 安全总监
- 销售(Tanya)和管理者(SAM)的RLS策略是否正确？
- 批量操作的安全边界？
- 是否有数据导出/备份风险？

### 测试总监
- 当前266条数据质量如何？
- quotation_value列是否完整？
- activities表是否为空？如果需要时间轴，数据够吗？

## 当前代码状态
- 代码：/home/ubuntu/newme-platform/ (feat/crm-v2分支)
- Dashboard已重写但只有展示价值
- Leads看板未完成（被中断）
- 数据库：Supabase vfopmpxlhwzpxqegayew
- 已知问题清单：/home/ubuntu/newme-platform/CRM-V2-ISSUES.md

## 输出要求
每份报告包含：PASS/FAIL判定 + 具体建议(3-5条) + 优先级排序
