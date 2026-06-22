# Architecture Baseline Audit

> 审计编号: AUDIT-20260623-001
> 状态: **BLOCKED** — 迁移暂停，待所有冲突确认后继续
> 审计范围: CRM v3 Phase A 数据库层（Epic 1）
> 审计日期: 2026-06-23
> 审计依据: GPT-5.5 四轮评审 + Hermes 执行记录 + 生产schema直接查询

---

## 1. Executive Summary

**审计结论：发现多处架构文档漂移。当前生产和 ARCHITECTURE_RULES.yaml 已形成事实基线，DEV_PLAN.md 和 PRD 已过时。**

当前系统有三个"真相"在竞争：

| 来源 | 状态 | 说明 |
|------|------|------|
| 生产数据库 schema | ✅ 事实运行时 | 已运行6张新表+leads扩展 |
| ARCHITECTURE_RULES.yaml | ✅ 当前设计基准 | 与生产一致，但未正式声明为权威 |
| 02_DEV_PLAN.md | ❌ 已过期 | 部分schema描述与生产不一致 |
| PRD-CRM-v3-sales-workflow.md | ❌ 已过期 | 冻结业务逻辑，不影响schema |

**核心风险：** 如果不做本次审计直接继续Epic 5，后续所有模块将建立在不可靠的文档基础上。半年后会出现"字段名该用哪个"的认知分裂。

**建议的权威链路：**

```
ARCHITECTURE_RULES.yaml  ← Source of Truth (Schema Authority)
      +
Production schema       ← Ground Truth (Runtime Authority)
      ↓
Migration files         ← Implementation
      ↓
Application code        ← Consumer
      ↓
DEV_PLAN.md / PRD       ← Documentation (follows, does not lead)
```

---

## 2. Source of Truth Declaration

### 2.1 权威层级

| 优先级 | 来源 | 角色 | 理由 |
|--------|------|------|------|
| 1 | 生产数据库 schema | Ground Truth | 不可逆事实，承载真实数据 |
| 2 | ARCHITECTURE_RULES.yaml | Schema Authority | 与生产一致，所有migration和代码按此构建 |
| 3 | Migration SQL 文件 | Implementation | 生产schema的可重复构建脚本 |
| 4 | 应用代码 (src/) | Consumer | 必须消费schema定义的内容 |
| 5 | DEV_PLAN.md | Design Archive | 记录设计意图，不作为schema定义源 |
| 6 | PRD-CRM-v3-sales-workflow.md | Product Archive | 记录业务需求，不定义技术实现 |

### 2.2 禁令

- **禁止** migration SQL 从 DEV_PLAN 或 PRD 中的schema描述直接生成
- **禁止** schema 变更不先更新 ARCHITECTURE_RULES.yaml
- **禁止** 应用代码通过 ORM 定义/产生 schema 变更

---

## 3. Drift Matrix

### 3.1 P0 — 语义冲突（必须确认，不能默认保留）

#### 1. follow_up_logs: 操作主体字段

| 维度 | DEV_PLAN | ARCH_RULES | 生产DB | 代码 |
|------|----------|------------|--------|------|
| 字段名 | `sales_id` | `user_id` | `user_id` | `user_id` |
| 类型 | UUID NOT NULL | UUID, ON DELETE SET NULL | 可为NULL | 必传 |
| 语义 | 业务归属：这个跟进是谁的客户 | 操作主体：这个操作是谁做的 | — | — |
| 约束 | FK → profiles(id) | FK → profiles(id) ON DELETE SET NULL | 同ARCH | 同ARCH |

**决策：保留 `user_id`**

理由：follow_up_logs 是**行为日志**，不是**销售分配记录**。`user_id` 记录"谁做了这个操作"语义正确。`sales_id` 和 `user_id` 是两个独立概念，如果业务需要追踪"这个客户归属哪个销售"，应该是 leads.assigned_to 而不是 follow_up_logs.sales_id。

影响：无。生产和代码已使用 user_id，无需迁移。

---

#### 2. follow_up_logs: 联系方式字段

| 维度 | DEV_PLAN | ARCH_RULES | 生产DB | 代码 |
|------|----------|------------|--------|------|
| 字段名 | `contact_method` | `contact_type` | `contact_type` | `contact_type` |
| 可选值 | phone/whatsapp/meeting/email/other | phone（默认值） | 同ARCH | 同ARCH |
| 补充字段 | content, customer_feedback, intention_change | summary, result, no_answer, next_action | 同ARCH | 同ARCH |

**决策：保留 `contact_type` + `summary` + `result` 模型**

理由：DEV_PLAN 将 follow_up_logs 设计为"销售跟进记录"（记录客户反馈和意向变化）。ARCH_RULES 将其设计为"行为日志"（记录操作类型、结果摘要、是否No Answer、下一步动作）。两者是不同的概念模型，ARCH_RULES 更通用且与 tasks 表职责分离清晰。

影响：无。生产和代码已使用该模型。

---

#### 3. tasks.assignee_id 空值策略

| 维度 | DEV_PLAN | ARCH_RULES | 生产DB |
|------|----------|------------|--------|
| nullable | NOT NULL | ON DELETE SET NULL | 可为NULL |
| 语义 | 任务必须属于某人 | 任务可以无负责人 | — |

**决策：保留可为NULL（ON DELETE SET NULL）**

理由：员工离职时，任务不应该随员工一起消失。"无人认领的任务"比"丢失的任务"安全。后续可以做自动重新分配。

影响：无。生产和ARCH_RULES一致。

---

### 3.2 P1 — 设计分歧（需要业务决策）

#### 4. crm_daily_funnel_snapshot: 表模型

| 维度 | DEV_PLAN | ARCH_RULES | 生产DB |
|------|----------|------------|--------|
| 模型 | 宽表（10列stage） | 窄表（milestone key-value） | 窄表 |
| 行数 | 每天1行 | 每天N行（每个milestone一行） | — |
| 主键 | snapshot_date | (snapshot_date, id) | (id) |
| 查询 | SELECT stage_new, stage_contacted... | SELECT WHERE current_milestone='new' | — |
| 趋势 | 加新stage需ALTER TABLE | 自动适应新milestone | — |

**决策：待确认**

两种方案的选择取决于未来报表需求：
- **宽表**：查询简单，适合固定看板（Excel兼容），但加stage要改表结构
- **窄表**：灵活，适合动态查询，但趋势报表需要PIVOT操作

建议：当前保留窄表（生产和代码已运行）。如果后续发现趋势查询性能瓶颈，再通过物化视图或cron转宽表。

影响：日报cron（daily-funnel-snapshot）的SQL已经按窄表实现。切换宽表需要重写该cron。

---

#### 5. RLS 实现方式

| 维度 | DEV_PLAN | ARCH_RULES | 生产DB |
|------|----------|------------|--------|
| 角色函数 | 使用 `get_my_role()` 函数 | 行内 subquery | 行内 subquery |
| 策略粒度 | 每张表 SELECT/INSERT/UPDATE/DELETE 独立策略 | 合并为 own + admin 策略 | 同ARCH |
| admin可见 | 通过角色判断 | 通过 profiles.role 行内查询 | 同ARCH |

**决策：保留行内 subquery 模式**

理由：行内 subquery 不需要额外函数依赖，对 RLS 性能影响可忽略。`get_my_role()` 函数方式更简洁但增加了一层抽象，且当前生产没有该函数。

影响：无。

---

### 3.3 P2 — Scope 差异（非冲突，Deferred）

#### 6. leads 表扩展字段

| 字段 | DEV_PLAN | ARCH_RULES | 生产DB | 状态 |
|------|----------|------------|--------|------|
| current_milestone | ✅ | ✅ | ✅ | 已落地 |
| final_status | ✅ | ✅ | ✅ | 已落地 |
| no_answer_flag | ❌ (未列出) | ❌ (未列出) | ✅ | Epic 4 额外添加 |
| contact_result | ✅ | ❌ | ❌ | Deferred |
| not_interested_reason | ✅ | ❌ | ❌ | Deferred |
| project_type | ✅ | ❌ | ❌ | Deferred |
| project_status | ✅ | ❌ | ✅ | 生产有（未定义在ARCH_RULES） |
| emirate | ✅ | ❌ | ❌ | Deferred |
| area | ✅ | ❌ | ❌ | Deferred |
| customer_company_type | ✅ | ❌ | ❌ | Deferred |
| customer_position | ✅ | ❌ | ❌ | Deferred |
| ac_brand | ✅ | ❌ | ❌ | Deferred |
| smart_requirements (JSONB) | ✅ | ❌ | ❌ | Deferred |
| customer_budget | ✅ | ❌ | ❌ | Deferred |
| expected_sign_date | ✅ | ❌ | ❌ | Deferred |
| lost_reason | ✅ | ❌ | ✅ | 生产有（未定义在ARCH_RULES） |

**决策：列入 Deferred Scope，不做迁移**

理由：DEV_PLAN 中列出的13个字段是"未来业务需求字段池"，而非 Phase A 的交付清单。当前 Phase A MVP 只要求 current_milestone + final_status。`lost_reason` 和 `project_status` 在生产中出现的原因不明，需后续单独审计。

---

#### 7. RLS — 5张新表的策略数量

| 表 | DEV_PLAN | ARCH_RULES | 生产DB |
|----|----------|------------|--------|
| follow_up_logs | 2条(select+insert) | 5条(insert+select+no_update+no_delete+default) | 5条 |
| tasks | 2条(select+insert) | 2条(own+admin) | 3条(含default deny) |
| user_features | 2条 | 2条(own+admin) | 同ARCH |
| lead_documents | 2条 | 2条(own+admin) | 同ARCH |
| lead_milestones | 2条 | 2条(own+admin) | 同ARCH |

**决策：保留生产策略**

ARCH_RULES 对 follow_up_logs 设计了更严格的 immutable 防护（no_update/no_delete 策略），这是正确的做法。DEV_PLAN 版本只做了基本权限控制。

---

## 4. Semantic Conflict Analysis

### 4.1 核心概念模型差异

整个 CRM v3 设计呈现两个不同的概念模型：

**模型 A — DEV_PLAN 版本（已过期）：**

```
follow_up_logs = 销售跟进记录
  - sales_id: 哪个销售
  - contact_method: 怎么联系的
  - content: 说了什么
  - customer_feedback: 客户反馈了什么
  - intention_change: 意向变了没
  
tasks = 任务（Phase B）
```

**模型 B — ARCH_RULES 版本（当前基线）：**

```
follow_up_logs = 行为日志
  - user_id: 谁做的
  - contact_type: 什么类型操作
  - summary: 做了什么
  - result: 结果是什么
  - no_answer: 是否未接听
  - next_action: 下一步做什么 → 触发 tasks 自动创建

tasks = 待办队列（Phase A）
  - 由 follow_up_logs 的 next_action 自动创建
  - 仅包含 future items（due_at > now()）
  - 历史记录在 follow_up_logs 查询
```

模型 B 更优的理由：
1. **职责分离**：follow_up_logs = 历史，tasks = 未来，不耦合
2. **自动流转**：记录跟进 → 自动生成下次任务，减少人工操作
3. **标准事件模型**：summary/result/no_answer 是通用的行为日志结构，可复用于任何操作（跟进、电话、邮件...）
4. **不可变历史**：follow_up_logs 只 INSERT，不 UPDATE/DELETE，保证审计完整性

### 4.2 `user_id` 不是 `sales_id` 的 rename

这是本次审计最关键的语义判定：

```
sales_id: "这个跟进发生在谁的客户身上"
  → 业务归属关系
  → 未来应该从 leads.assigned_to 推导
  → follow_up_logs 不需要单独记录

user_id: "这个操作是谁执行的"
  → 操作主体标识
  → 可以复用 profiels.id
  → follow_up_logs 作为行为日志必须记录
```

场景示例：
- 销售 Alice 给客户打电话：user_id=Alice, lead.assigned_to=Alice
- 管理员 Bob 补录 Alice 的跟进记录：user_id=Bob, lead.assigned_to=Alice
- 系统 cron 自动创建任务：user_id=null, lead.assigned_to=Alice

### 4.3 funnel 快照模型选择

```
宽表（DEV_PLAN）:     窄表（ARCH_RULES/生产）:
stage_new: 12         current_milestone: 'new', count: 12
stage_contacted: 8    current_milestone: 'contacted', count: 8
stage_qualified: 5    current_milestone: 'qualified', count: 5
stage_drawings: 3     current_milestone: 'drawings', count: 3
```

窄表选择意味着：
- 加新 milestone 不需要改表结构
- 但趋势查询（"new这个月每天的变化"）需要 PIVOT
- 后续可以做物化视图转为宽表供看板使用

---

## 5. Deferred Scope

以下项确认不属于 Phase A 交付，标记为 Deferred：

| 项 | 关联文档 | 目标Phase | 说明 |
|----|---------|-----------|------|
| leads 13个扩展字段 | DEV_PLAN 2.2 | Phase B/C | MVP只含current_milestone+final_status |
| health_score 规则算法 | PRD 3.4 | Phase B | Phase A不做前端暴露 |
| Command Center Dashboard | PRD 3.9 | Phase B | 现有dashboard继续使用V2数据 |
| Pipeline 项目视图 | PRD 3.6 | Phase B | — |
| WhatsApp 时间线融合 | PRD 3.7 | Phase C | — |
| funnel 宽表物化视图 | DEV_PLAN 5.3 | Phase B | 窄表先用，性能不满足时再切 |

---

## 6. Migration Impact

### 6.1 不可变项（不允许修改）

- `follow_up_logs.user_id` — 保留字段名和语义
- `follow_up_logs.contact_type` — 保留字段名
- `follow_up_logs.summary` + `result` + `no_answer` + `next_action` — 保留行为日志模型
- `tasks.assignee_id` — 保留可为NULL
- `crm_daily_funnel_snapshot` — 保留窄表模型

### 6.2 允许变更项（如需）

- `leads` 表可以增量加扩展字段（contact_result, project_type 等），但属于 Phase B 范围
- `crm_daily_funnel_snapshot` 可以加物化视图做宽表，但不替换原表

### 6.3 紧急修复项

migration SQL 中的 `%%` RAISE 语法错误已修复，已同步到本地文件和 COS 文档。

---

## 7. Governance Rule Proposal

### 建议新增 rule_011: Architecture Source Control

```yaml
rule_id: rule_011
name: architecture_source_control
severity: P0

authority_order:
  - ARCHITECTURE_RULES.yaml
  - production database schema
  - migration files (supabase/migrations/)
  - application code (src/)
  - DEV_PLAN.md (design intent, not schema source)
  - PRD.md (product intent, not schema source)

constraints:
  - Any schema change MUST update ARCHITECTURE_RULES.yaml FIRST
  - DEV_PLAN and PRD cannot define database schema (design intent only)
  - Migration files must reference ARCHITECTURE_RULES.yaml version
  - Application code must not define or generate schema (no ORM auto-migrate)

forbidden_patterns:
  - "DEV_PLAN says X" used as justification for schema change without ARCH_RULES update
  - Schema change by modifying migration SQL without corresponding ARCH_RULES diff

enforcement:
  - Pre-push hook must check: migration file diff ↔ ARCH_RULES diff at git diff HEAD
  - Monthly drift scan: ARCH_RULES ↔ production schema ↔ migration files

  ```
  
### 建议审计周期

| 频率 | 动作 | 负责方 |
|------|------|--------|
| 每次 migration | ARCH_RULES 更新在前，migration在后 | 执行人 |
| 每次 push | 检查 migration ↔ ARCH_RULES 同步 | pre-push hook |
| 每月 | ARCH_RULES ↔ production ↔ migration 全量核对 | cron job |

---

## 8. 审计结论与决策建议

**结论：有漂移，但不致命。**

经过审计，当前生产和 ARCH_RULES 之间没有不可修复的冲突。涉及语义差异的三项（user_id、contact_type、assignee_id nullable）生产和ARCH_RULES一致，DEV_PLAN已过期。

**建议动作：**

1. ✅ 确认 ARCHITECTURE_RULES.yaml 为 Schema Source of Truth（本文档即确认）
2. 🔲 更新 02_DEV_PLAN.md — 删除或修正与ARCH_RULES冲突的schema描述（2.1和2.2节）
3. 🔲 在 ARCHITECTURE_RULES.yaml 中追加 rule_011
4. 🔲 将 `project_status` 和 `lost_reason` 两个"幽灵字段"补注册到 ARCH_RULES（或移除）
5. 🔲 恢复Epic 5执行（已上线，无需额外migration）

**迁移条件：** 以上5项完成后，可以恢复后续Epic。
