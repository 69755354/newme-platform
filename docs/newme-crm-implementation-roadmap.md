# NewMe CRM v2.1 — 实施路线图（架构总监终审版）

> **目标版本**: CRM v2.1（5层数据模型重构）  
> **基线代码**: `supabase/migrations/20260605000000_newme_crm_v21_full.sql`  
> **修正文件**: `supabase/migrations/20260605000001_newme_crm_v21_final.sql`  
> **项目**: `vfopmpxlhwzpxqegayew`（Supabase）  
> **环境**: SQL Editor 执行（psql不可用）

---

## 0. 执行前准备（今天）

### 0.1 数据库连接
访问 Supabase Dashboard → SQL Editor → 粘贴并逐段执行 `20260605000001_newme_crm_v21_final.sql`

### 0.2 执行计划
| 步骤 | SQL Editor 操作 | 预计耗时 |
|------|---------------|---------|
| STEP 0 | 粘贴DROP POLICY部分 → Run | <1秒 |
| STEP 1 | 粘贴角色迁移部分（UPDATE + ALTER）→ Run | <1秒 |
| STEP 2-14 | 粘贴表结构创建部分 → Run | <5秒 |
| STEP 15 | 粘贴视图创建部分 → Run | <2秒 |
| STEP 16 | 粘贴索引创建部分 → Run | <5秒（大表较慢） |
| STEP 17 | 粘贴RLS策略部分 → Run | <3秒 |
| STEP 18 | 粘贴触发器部分 → Run | <2秒 |
| 验证 | 粘贴验证SQL → Run | <1秒 |

### 0.3 执行后验证

```sql
-- 1. 确认所有新表
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name;

-- 2. 确认boss角色已加入枚举
SELECT DISTINCT role FROM profiles;

-- 3. 确认角色迁移成功（manager应该为0条）
SELECT role, COUNT(*) FROM profiles GROUP BY role;

-- 4. 确认RLS已启用
SELECT tablename, rowsecurity FROM pg_tables
WHERE schemaname = 'public' ORDER BY tablename;

-- 5. 确认视图
SELECT table_name FROM information_schema.views
WHERE table_schema = 'public' ORDER BY table_name;

-- 6. 确认索引
SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname = 'public' AND tablename IN ('leads','contracts','payments')
ORDER BY tablename, indexname;
```

### 0.4 如果出错回滚

```sql
-- 全部回滚（删除本次迁移新增的内容）
-- STEP 18: DROP 触发器
DROP FUNCTION IF EXISTS auto_assign_lead() CASCADE;
DROP FUNCTION IF EXISTS update_installment_status() CASCADE;
DROP FUNCTION IF EXISTS log_contract_status_event() CASCADE;

-- STEP 17: DROP 所有新增的RLS策略（用对应名称）
-- STEP 16: DROP 新增索引
-- STEP 15: DROP 新增视图
-- STEP 13-14: ALTER回退
-- STEP 4-12: DROP TABLE ... CASCADE
-- STEP 1: ALTER profiles_role_check 还原

-- 或直接: 恢复20260605000000版本（前提是已备份）
-- 强烈建议执行前在Dashboard做一次Database Backup
```

---

## 阶段1（Day 1-2）：核心DDL部署 + 安全加固

### 任务

| # | 工作项 | 责任人 | 依赖 | 产出 |
|---|--------|-------|------|------|
| 1.1 | 执行最终DDL修正文件 | 架构师 | 无 | 16张表结构就绪 |
| 1.2 | 验证BOSS角色可登录 | 架构师 | 1.1 | auth.users ↔ profiles 联动 |
| 1.3 | 将SAM账号role设为boss | 架构师 | 1.2 | `UPDATE profiles SET role='boss' WHERE ...` |
| 1.4 | 将Tanya账号role设为sales | 架构师 | 1.2 | `UPDATE profiles SET role='sales' WHERE ...` |
| 1.5 | 测试RLS策略 | 架构师 | 1.3-1.4 | 每个角色SQL测试 |

### 验证点

- ✅ BOSS看全部leads → 能看不能改（除assigned_to）
- ✅ BOSS看全部contracts → 能看不能改
- ✅ Sales只看自己线索 → 插入新线索自动分配
- ✅ Sales看不到回款金额聚合
- ✅ Operator CRUD合同/回款/项目
- ⚠️ 旧manager用户全部降级为sales

### 风险控制

- **风险**: PAT可能403 → 只在SQL Editor执行
- **风险**: 旧数据中有manager记录 → STEP 1已处理
- **风险**: 旧RLS策略残留 → STEP 0已DROP

---

## 阶段2（Day 2-5）：销售Tanya界面开发

### Sprint 1：核心销售工作流

```
优先级: 🥇 最高（唯一日活用户）
```

| # | 功能点 | 后端 | 前端 | 预计工时 |
|---|--------|------|------|---------|
| 2.1 | **今日待办主页** — 优先级排序的跟进列表 | `v_sales_today_tasks` 视图已就绪 | 卡片列表组件 | 0.5天 |
| 2.2 | **我的管道 Kanban** — 9阶段拖拽推进 | 已有 leads.stage + trigger | Kanban 组件（react-beautiful-dnd） | 1天 |
| 2.3 | **快速跟进记录** — 活动录入弹窗 | RLS已允许sales INSERT activities | Modal + 表单 | 0.5天 |
| 2.4 | **线索详情页** — 基础信息 + 阶段历史 | 已有 leads + business_events | 详情页面 | 1天 |
| 2.5 | **标记成交/输单** — 一键操作 | leads UPDATE（已有） | 操作按钮 | 0.5天 |
| 2.6 | **新建线索** — 简单表单 | leads INSERT（RLS已补P0-4） | 表单页面 | 0.5天 |

### Sprint 2：销售增强功能

| # | 功能点 | 后端 | 前端 | 预计工时 |
|---|--------|------|------|---------|
| 2.7 | **从线索创建报价** — 粗版（填写总金额） | quotations INSERT（RLS已就绪） | Modal表单 | 0.5天 |
| 2.8 | **我的合同（只读）** — 仅状态和合同号 | `v_sales_contracts`（前端过滤金额） | 只读列表 | 0.5天 |
| 2.9 | **我的业绩（无金额）** | `v_sales_personal_stats` 视图已就绪 | 统计卡片 | 0.5天 |
| 2.10 | **我的客户列表** — 自己关联的客户 | customers RLS已就绪 | 列表页 | 0.5天 |

### 前端实现要点

```typescript
// 角色判断 middleware（app router）
function roleMiddleware(profile: { role: string }) {
  const menus = MENU_CONFIG[profile.role];
  return { allowedMenus: menus, defaultRoute: menus[0].path };
}

// API层过滤（示例）
async function getLeads() {
  // RLS自动过滤，不需要额外where条件
  const { data } = await supabase.from('leads').select('*');
  // 如果是boss角色，需要额外的UPDATE权限控制
  return data;
}
```

---

## 阶段3（Day 5-7）：老板SAM Dashboard

### Sprint 3：核心驾驶舱

```
优先级: 🥈 重要（老板反馈决定项目生死）
```

| # | 功能点 | 后端 | 前端 | 预计工时 |
|---|--------|------|------|---------|
| 3.1 | **4 KPI Card** — 管道总额/本月签约/本月回款/逾期 | `v_boss_pipeline_overview` + `v_contract_payment_overview` 已就绪 | 仪表盘组件 | 0.5天 |
| 3.2 | **预警区块** — 红线线索/逾期分期/回收标记 | leads查询（索引已优化） | Alert卡片 | 0.5天 |
| 3.3 | **管道漏斗（简版）** — 各阶段线索数量+金额 | `v_boss_pipeline_overview` 已就绪 | 条形图（recharts） | 0.5天 |
| 3.4 | **团队速览** — 每人一行 | `v_sales_performance` 已就绪 | 表格组件 | 0.5天 |
| 3.5 | **线索分配/转移操作** — 老板唯一可写操作 | leads UPDATE RLS已就绪 | Modal选择销售 | 0.5天 |

### Sprint 4：老板增强

| # | 功能点 | 前端 | 预计工时 |
|---|--------|------|---------|
| 3.6 | **合同总览（只读）** | 2.8重用 | 0.5天 |
| 3.7 | **回款看板** — 现金流概览 | 聚合查询 | 0.5天 |
| 3.8 | **移动端适配** — 响应式布局 | tailwind responsive | 0.5天 |

---

## 阶段4（Day 8-12）：运营Operator界面 + 项目交付

### Sprint 5：合同+回款管理

```
优先级: 🥉 最后（当前运营空缺或由老板兼任）
```

| # | 功能点 | 后端 | 前端 | 预计工时 |
|---|--------|------|------|---------|
| 4.1 | **待办工作台** — 待确认回款 + 逾期分期 | `v_operator_todo` 已就绪 | 面板组件 | 0.5天 |
| 4.2 | **合同管理 CRUD** | RLS已就绪 | 表单+列表+详情 | 1天 |
| 4.3 | **分期计划管理** — 按合同设置分期 | installment_plans已就绪 | 嵌入列表+表单 | 0.5天 |
| 4.4 | **回款登记** — 选择合同→登记金额 | payments RLS已就绪 | 表单 | 0.5天 |
| 4.5 | **合同文件上传** — PDF上传 | Supabase Storage | 上传组件 | 0.5天 |

### Sprint 6：项目交付 + 产品库

| # | 功能点 | 备注 | 预计工时 |
|---|--------|------|---------|
| 4.6 | **项目交付管理** — 里程碑进度 | project_milestones已就绪 | 1天 |
| 4.7 | **项目文档上传** — CAD/PDF/照片 | project_documents已就绪 | 0.5天 |
| 4.8 | **产品库 CRUD** — 运营管理产品 | products RLS已就绪 | 0.5天 |
| 4.9 | **客户档案统一管理** — 统一视图 | customers增强已就绪 | 0.5天 |
| 4.10 | **启用delivery_plans** — 取消注释DDL | 注释保留在SQL中 | 0.5天 |

---

## 部署检查清单

### 每个Sprint结束前

- [ ] 所有新页面在BOSS角色下能正常加载（不报权限错误）
- [ ] 所有新页面在SALES角色下不显示不该看到的数据
- [ ] 所有新页面在OPERATOR角色下能正常CRUD
- [ ] API调用返回的数据量与RLS预期一致
- [ ] 移动端至少可读

### v2.1 发布标准

- [ ] Tanya连续使用1周
- [ ] 至少成交1单通过系统完成
- [ ] 老板每天看Dashboard
- [ ] 无P0/P1 Bug
- [ ] RLS无泄漏

---

## 延迟交付的功能（v2.2 考虑）

| 功能 | 理由 | 依赖 |
|------|------|------|
| delivery_plans 交付计划 | 当前手动管理即可 | 运营界面完成后 |
| project_inspections 验收记录 | 当前验收走线下 | 运营界面完成后 |
| sales_targets 销售目标 | 老板当前不需要设定目标 | 老板Dashboard完成后 |
| 自动逾期催款消息 | 需要WhatsApp集成 | 独立工程 |
| 电子签名集成 | 需要DocuSign/HubSpot集成 | v2.2 |
| Hermes AI 报价系统 | 需要AI模型集成 | v2.2 |
| 多语言（中/英/阿） | 当前英文够用 | v2.2 |
| Activity 360 视图 | 非核心流程 | v2.2 |

---

## 修正清单速查

| ID | 严重度 | 问题 | 修正方式 |
|----|--------|------|---------|
| B1 | 🔴阻断 | activities FK顺序错误 | 移到所有新表之后 |
| B2 | 🔴阻断 | 角色移除manager无数据迁移 | UPDATE → ALTER |
| P0-1 | 🔴安全 | 旧manager RLS策略残留 | STEP 0 DROP |
| P0-2 | 🔴安全 | SECURITY DEFINER触发器 | 移除关键字 |
| P0-3 | 🔴安全 | activities无RLS | 新增5个策略 |
| P0-4 | 🔴安全 | leads无INSERT策略 | 新增sales INSERT |
| W1 | 🟡性能 | leads缺assigned_to索引 | 新增 |
| W2 | 🟡性能 | leads缺组合索引 | 新增 |
| W4 | 🟡逻辑 | 无超额支付防护 | 触发器内日志 |
| W5 | 🟡安全 | designer无RLS策略 | 新增select策略 |
| W6 | 🟡性能 | leads缺stage_changed_at索引 | 新增 |
| NEW | 🆕功能 | boss角色缺失 | role枚举+RLS |
| NEW | 🆕功能 | 线索自动分配触发器 | 新增 |
| NEW | 🆕功能 | 5个补充视图 | 新增 |
| NEW | 🆕功能 | 运营/销售优化索引 | 新增 |
| DEFER | 🗄️延迟 | 3张表延迟到Phase 3 | 注释保留 |
