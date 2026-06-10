# NewMe 运维总监方案 — Ops Director Plan

> **版本**: v1.0 | **日期**: 2026-06-04 | **作者**: Ops Director Agent
> **审计范围**: Lighthouse VPS (ap-singapore) + Supabase + COS + Hermes Agent + Next.js

---

## 目录

1. [系统现状快照](#1-系统现状快照)
2. [数据生命周期管理](#2-数据生命周期管理)
3. [备份与灾备方案](#3-备份与灾备方案)
4. [监控告警方案](#4-监控告警方案)
5. [安全与权限治理](#5-安全与权限治理)
6. [成本预估与扩容路径](#6-成本预估与扩容路径)
7. [运维 SOP](#7-运维-sop)
8. [事故复盘与改进](#8-事故复盘与改进)
9. [实施路线图](#9-实施路线图)

---

## 1. 系统现状快照

### 1.1 基础设施概览

| 组件 | 规格 | 状态 | 备注 |
|------|------|------|------|
| Lighthouse VPS | Singapore, 4C/8G/80GB | ✅ 运行中 | ufw deny incoming |
| Nginx | system nginx | ✅ 运行中 | 反向代理 → localhost:3001 |
| Next.js (newme-platform) | v16.2.6, port 3001 | ✅ 运行中 | systemd 管理 |
| Hermes Gateway | Docker (host network) | ✅ 运行中 | Telegram bot @newwme_1_bot |
| Supabase | 托管 PostgreSQL | ✅ 运行中 | 267 leads, 2 quotes, 2 contracts |
| COS (newme) | ap-singapore | ✅ 可用 | 150 项目文件 |
| COS (tanya) | ap-singapore | ✅ 可用 | 设计模板 |
| UFW | deny incoming | ✅ 运行中 | 清退 SSH 关闭 |

### 1.2 现有运维工具链

| 工具 | 频率 | 功能 |
|------|------|------|
| `health-monitor.py` | `/5 * * * *` | 进程存活/端口/磁盘/内存检查 + 日志 JSON |
| `unified-watchdog.sh` | `/15 * * * *` | 三合一: 健康检查 + auto-repair + 小时任务 |
| `ops-director.py` | 多种模式 | auto-repair / hourly / daily / weekly / escalate |
| `cvm-backup.py` | daily | ~/.hermes 配置 → COS tar.gz |
| `zombie-cleaner.py` | hourly | 清理死进程/sessions |

### 1.3 风险矩阵 (当前)

| 风险 | 概率 | 影响 | 缓控措施 | 优先级 |
|------|------|------|---------|--------|
| COS 误删无回滚 | 中 | 高 (丢失项目文件) | ⚠️ 无 | **P0** |
| 无 Supabase 数据库备份 | 高 | 高 (丢失全部 CRM 数据) | ⚠️ 无 | **P0** |
| systemd cgroup 孤儿进程宕机 | 低 | 高 | ✅ health-monitor 可检测 | P1 |
| UFW deny incoming 阻断合法访问 | 低 | 中 | ✅ 但无外部监控 | P2 |
| 磁盘写满 (80GB) | 中 | 高 | ✅ 阈值告警 | P1 |
| 无权限隔离 (所有 sales 见所有数据) | 高 | 中 | ⚠️ RLS 策略不全 | P1 |
| 财务数据为空 (0 payments) | 高 | 高 (无 revenue 数据) | ⚠️ 业务层缺失 | P1 |

---

## 2. 数据生命周期管理

### 2.1 四阶段生命周期模型

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│ Phase 1  │ ──→ │ Phase 2  │ ──→ │ Phase 3  │ ──→ │ Phase 4  │
│  创建    │     │  活跃    │     │  归档    │     │  退役    │
│ Lead→    │     │ 项目执行 │     │ 项目交付 │     │ 保留索引 │
│ Quote→   │     │ 日常沟通 │     │ 最终文件 │     │ 不可变   │
│ Contract │     │ 图纸迭代 │     │ 财务结算 │     │ 只读     │
│ Payment  │     │          │     │          │     │          │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
```

### 2.2 Phase 1: 创建 (Create)

**生命周期开始**: Lead 录入或用户注册

| 数据实体 | 产生位置 | 存储 | 负责人 | 保留策略 |
|---------|---------|------|-------|---------|
| Lead | Meta Ads / WhatsApp / Website | Supabase `leads` 表 | Sales / AI | 失单后保留 2 年 |
| Quote | Hermes Engine → Next.js | Supabase `quotes` 表 | Sales | 关联合同后保留 |
| Contract | Hermes Engine → 签署 | Supabase `contracts` 表 | Sales Manager | 永久保留 |
| Payment | Stripe / 线下 | Supabase `payments` 表 | Finance | 税务要求 7 年 |

**治理规则**:
- ✅ 所有实体必须有 `created_at` / `updated_at` 时间戳 (当前已满足)
- ✅ Lead 必须有来源标记 `source` (当前已满足)
- ❌ 缺少: 数据创建者审计字段 `created_by` (当前无)
- ❌ 缺少: Lead 去重策略 (当前无 `duplicate` 自动判定)
- ❌ 缺少: 报价版本号 (当前无版本控制)

**建议改进**:
```sql
-- 增加审计字段
ALTER TABLE leads ADD COLUMN created_by UUID REFERENCES profiles(id);
ALTER TABLE quotes ADD COLUMN version INTEGER DEFAULT 1;
ALTER TABLE quotes ADD COLUMN previous_version_id UUID REFERENCES quotes(id);
```

### 2.3 Phase 2: 活跃 (Active)

**持续时间**: Lead → Won / Lost (通常 2 周 - 6 个月)

| 活动 | 数据产生 | 存储位置 | 治理要求 |
|------|---------|---------|---------|
| WhatsApp 沟通 | Chat messages | `chat_messages` 表 | 保存 2 年 |
| 方案迭代 | PPT / CAD 文件 | COS `projects/{project_id}/` | 按版本命名 |
| 现场勘察 | 照片 / 测量数据 | COS `projects/{project_id}/survey/` | 原始数据不可变 |
| 图纸修改 | DXF / DWG | COS `projects/{project_id}/cad/` | 每次修改存新版本 |
| 报价修改 | Quote 记录 | Supabase `quotes` | 保留修改历史 |

**关键规则**:
- COS 文件命名必须包含版本号或时间戳: `方案_v2_2026-06-04.pdf`
- 文件删除必须经过 **dry-run 审核** (教训: Mohammed Shami 误删)
- Chat 消息敏感内容标记 (客户电话/地址不可在 Telegram 明文)

### 2.4 Phase 3: 归档 (Archive)

**触发条件**: 项目交付 + 客户验收 + 尾款到账

**归档操作**:
```
1. COS 整理: 所有项目文件打包为 {project_id}_archive_{date}.tar.gz
2. 文件清单: 生成 SHA256 checksum 清单并存为清单文件
3. 数据库标记: UPDATE projects SET status='archived', archived_at=NOW()
4. 知识库快照: 项目相关的 Obsidian 笔记导出到 COS
5. 空间释放: 项目文件从活跃目录移入 `archived/` 前缀
```

**访问控制**: 归档后数据只读, 仅 `admin` 和 `manager` 角色可解压查看

### 2.5 Phase 4: 退役 (Retire)

**触发条件**: 归档满 3 年

**操作**:
- 数据库中保留最小记录: `id`, `customer_name`, `project_type`, `archived_at`, `cos_path`
- COS 完整数据保留 (低成本存储)
- 删除: `chat_messages`, 临时文件, 中间版本图纸
- 财务数据 (合同/发票) 按当地法律保留 (阿联酋要求 7 年)

### 2.6 数据质量仪表盘

建议在 Next.js 管理中增加「数据健康」页面，展示:

- Leads 转化率: won / (won + lost)
- 各阶段停留时间分布
- 缺失字段率 (phone, email, budget_range 缺失百分比)
- 重复 lead 检测 + 一键合并
- 报价平均生成时间

---

## 3. 备份与灾备方案

### 3.1 备份拓扑

```
                    ┌──────────────────────────┐
                    │     Cron 调度中心         │
                    │  (系统 crontab)           │
                    └──────┬───────────┬────────┘
                           │           │
              ┌────────────┘           └────────────┐
              ▼                                      ▼
    ┌─────────────────┐                  ┌──────────────────────┐
    │  每日 04:00 CST  │                  │  每6小时             │
    │  DB Backup       │                  │  COS Cross-Bucket   │
    │  → COS           │                  │  Replication        │
    └────────┬─────────┘                  └──────────┬───────────┘
             ▼                                       ▼
    ┌──────────────────────┐              ┌──────────────────────┐
    │  COS: db-backups/    │              │  COS Backup Bucket  │
    │  {date}/newme-db.sql │              │  (read-only replica) │
    └──────────────────────┘              └──────────────────────┘

    ┌──────────────────────┐
    │  每日 06:00 CST      │
    │  CVM 配置备份        │
    │  → COS               │
    └────────┬─────────────┘
             ▼
    ┌──────────────────────┐
    │  COS: cvm-backups/   │
    │  hermes-cvm-{ts}.tar │
    └──────────────────────┘
```

### 3.2 数据库备份 (P0 — 当前缺失)

#### 方案: Supabase pg_dump 备份 → COS

```bash
#!/bin/bash
# /home/ubuntu/.hermes/scripts/db-backup.sh
# Cron: 0 4 * * * (每天 04:00 CST = 20:00 UTC)

set -e
BACKUP_DIR="/tmp/db-backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DB_URL="postgresql://${SUPABASE_USER}:${SUPABASE_PASS}@${SUPABASE_HOST}:5432/postgres"

mkdir -p "$BACKUP_DIR"

# 1. 完整备份 (schema + data)
pg_dump "$DB_URL" \
  --no-owner \
  --no-acl \
  --format=custom \
  --file="${BACKUP_DIR}/newme-full-${TIMESTAMP}.dump"

# 2. 仅 schema (用于版本对比)
pg_dump "$DB_URL" \
  --no-owner \
  --no-acl \
  --schema-only \
  --file="${BACKUP_DIR}/newme-schema-${TIMESTAMP}.sql"

# 3. 仅关键业务表 (用于快速恢复)
pg_dump "$DB_URL" \
  --no-owner \
  --no-acl \
  --data-only \
  --table=leads \
  --table=quotes \
  --table=contracts \
  --table=payments \
  --table=profiles \
  --file="${BACKUP_DIR}/newme-business-${TIMESTAMP}.sql"

# 4. 上传到 COS
cos.sh upload "${BACKUP_DIR}/newme-full-${TIMESTAMP}.dump" \
  "db-backups/${TIMESTAMP}/newme-full.dump"
cos.sh upload "${BACKUP_DIR}/newme-schema-${TIMESTAMP}.sql" \
  "db-backups/${TIMESTAMP}/newme-schema.sql"
cos.sh upload "${BACKUP_DIR}/newme-business-${TIMESTAMP}.sql" \
  "db-backups/${TIMESTAMP}/newme-business.sql"

# 5. 清理本地临时文件
rm -rf "$BACKUP_DIR"

# 6. 清理 30 天前的旧备份 (保留法律要求的记录)
find /tmp/db-backups* -mtime +30 -delete 2>/dev/null
```

**备份验证**: 每周日 08:00 恢复到一个临时 Supabase 项目验证完整性
```bash
# ops-director.py --mode=weekly-report 中调用
pg_restore --list /tmp/db-backups/newme-full-latest.dump | head -20
# 检查关键表行数
```

#### 备份保留策略

| 备份类型 | 频率 | 保留期 | 用途 |
|---------|------|--------|------|
| pg_dump custom | 每日 | 30 天 | 完整恢复 |
| pg_dump schema | 每日 | 90 天 | 历史 schema 对比 |
| 业务表仅数据 | 每日 | 30 天 | 快速恢复 |
| 周验证备份 | 每周 | 12 周 | 长期归档 |

### 3.3 COS 对象备份 (P0 — 当前缺失)

#### COS 跨桶复制方案

> **问题**: 当前 `newme-1302961787` 桶无冗余保护, 误删不可恢复

**推荐: COS 跨区域复制 (Cross-Region Replication)**

| 主桶 | 备份桶 | 区域 | 说明 |
|------|--------|------|------|
| `newme-1302961787` | `newme-backup-1302961787` | ap-singapore | 同区域跨桶只读副本 |
| — | 或 `newme-dr-1302961787` | ap-tokyo | 跨区域灾备 (推荐) |

**操作步骤**:
1. 创建备份桶 `newme-backup-1420640156` (用 tanya 账号)
2. 在 COS 控制台配置「跨区域复制」规则:
   - 复制范围: 全部对象
   - 目标桶: `newme-backup-1420640156`
   - 同步模式: 增量同步 (实时)
3. 备份桶设置: **禁止写权限** (仅主桶可写入, 备份桶只读)

**如果 COS 不支持 CRR** (腾讯云 COS 支持, 但需要认证):
- 改用 **定时脚本同步**: `rclone sync cos:newme-1302961787 cos:newme-backup-1420640156 --create-empty-dirs`
- 频率: 每 6 小时
- 检查: 每日对比桶对象数量差 < 5%

#### COS 误删恢复 SOP

```
1. 发现误删 → 立即暂停所有 COS 写操作
2. 登录 COS 控制台 → 进入备份桶 `newme-backup-*`
3. 找到目标对象的最近版本
4. 复制回主桶原始路径
5. 验证完整性 (文件大小 + checksum)
6. 复盘: 为什么没有 `delete` 审批流程?
```

### 3.4 CVM 配置备份 (已有, 需改进)

**当前**: `cvm-backup.py` → `hermes-cvm-{timestamp}.tar.gz` → COS `cvm-backups/`

**改进点**:
| 当前 | 改进后 |
|------|--------|
| 仅备份 `~/.hermes/` 配置 | 增加 `newme-platform/` 的 `.env.local` + `next.config.ts` |
| 排除 `venv`/`node_modules` | 保留 `package.json` + `package-lock.json` (重建依赖) |
| 无备份验证 | 周五验证: 解压并检查关键文件 MD5 |
| 无保留策略 | 保留最近 14 天, 每月压缩为月归档 |

### 3.5 灾备演练日历

| 演练 | 频率 | 操作 |
|------|------|------|
| DB 恢复演练 | 每月第 1 个周五 | 从最近的 dump 恢复到测试数据库 |
| COS 恢复演练 | 每季度 | 从备份桶恢复一个随机项目文件 |
| 全系统重建 | 每半年 | 在全新 VPS 上重建所有服务 |
| 密码轮换 | 每季度 | 更新所有 API key 和数据库密码 |

---

## 4. 监控告警方案

### 4.1 监控层级

```
Layer 1: 基础设施
  ├── 进程存活 (health-monitor.py 每 5 分钟)
  ├── 端口可达性 (22884, 3001, 3000)
  ├── 磁盘使用率 (80% warn, 90% crit, 95% panic)
  ├── 内存使用率 (RSS per process + system available)
  └── CPU 负载

Layer 2: 服务健康
  ├── HTTP 端点检查 (Next.js 首页 200)
  ├── Supabase 连接 (health-monitor.py 的 HTTP check)
  ├── COS 上传/下载连通性
  └── Hermes Gateway 响应时间

Layer 3: 业务指标
  ├── 每日新增 Leads 数 (预期 5-20)
  ├── 报价生成成功率 (预期 > 90%)
  ├── Lead 响应时间 (< 5 分钟)
  ├── 支付转化率
  └── AI 调用成功率

Layer 4: 安全监控
  ├── 失败登录尝试
  ├── RLS 策略违规
  ├── COS 匿名访问检测
  └── profile 角色变更审计
```

### 4.2 当前监控体系评估

| 检查项 | 当前状态 | 评估 |
|--------|---------|------|
| 进程存活 | ✅ health-monitor.py | 良好, 覆盖 6 个服务 |
| 端口检查 | ✅ health-monitor.py | 基础 TCP 握手 |
| 磁盘告警 | ✅ 80%/90%/95% 三级 | 良好, 有 auto-clean |
| 内存监控 | ✅ system + process | 基本可用 |
| 日志轮转 | ✅ 小时级 / cron | 需要配置 max size |
| HTTP 端点 | ⚠️ 部分实现 | Next.js 200 检查未覆盖 |
| Supabase 连接 | ❌ 未实现 | 需要 SQL ping |
| COS 连通性 | ✅ 深度检查每 6h | 良好 |
| 业务指标 | ❌ 未实现 | 无 dashboard |
| 外部告警 | ⚠️ Telegram 升级 | 仅 ops-director 输出 |
| Uptime 外部检测 | ❌ 未实现 | 没有外部 ping |

### 4.3 告警分级与升级策略

```
P0 (Critical) — 立即响应, 24/7
├── 服务完全不可用 (Next.js 502, Gateway down)
├── 数据库连接失败
├── COS 冗余桶不可用
├── 磁盘 > 95%
└── 数据丢失事件

P1 (High) — 4 小时内响应
├── 单 MCP 服务挂掉
├── 磁盘 > 80%
├── 备份失败连续 2 次
├── 内存不足警告
└── 日新增 Leads 为 0 (可能是广告或采集故障)

P2 (Medium) — 24 小时内响应
├── 单个进程内存超限
├── 备份延迟 (超过 24h 未备份)
├── 日志目录增长过快
└── 错误率 > 5%

P3 (Info) — 日报/周报
├── 磁盘增长趋势
├── Lead 转化率变化
├── COS 对象数量变化
└── API 调用频次异常
```

### 4.4 告警通知渠道

| 级别 | 渠道 | 目标 |
|------|------|------|
| P0 | Telegram + 邮件 | SAM + Ops Director |
| P1 | Telegram | Ops Director |
| P2 | Telegram (日报摘要) | Ops Director |
| P3 | 日报/周报 | SAM (定期查看) |

### 4.5 业务指标仪表盘建议

在 Next.js 管理端增加 `/ops/dashboard` 页面:

```typescript
// 建议指标查询
interface OpsMetrics {
  // 增长
  daily_new_leads: number;
  weekly_lead_growth: number;
  total_active_leads: number;
  
  // 转化
  lead_to_quote_rate: number;    // 报价转化率
  quote_to_win_rate: number;      // 成交率
  avg_close_days: number;         // 平均成交周期
  
  // 质量
  ai_quality_distribution: { hot: number; warm: number; cold: number };
  duplicate_leads: number;
  missing_fields: string[];
  
  // 财务
  monthly_revenue: number;
  pending_payments: number;
  avg_quote_value: number;
  
  // 运维
  last_backup_time: string;
  backup_status: 'ok' | 'warning' | 'failed';
  disk_usage: number;
  service_uptime: number;
}
```

---

## 5. 安全与权限治理

### 5.1 角色定义与权限矩阵

| 操作 | admin | manager | sales | designer |
|------|-------|---------|-------|----------|
| 查看所有 Leads | ✅ | ✅ | 仅自己的 | ❌ |
| 创建 Lead | ✅ | ✅ | ✅ | ❌ |
| 编辑 Lead | ✅ | ✅ | 仅自己的 | ❌ |
| 删除/合并 Lead | ✅ | ⚠️ 需审批 | ❌ | ❌ |
| 查看报价 | ✅ | ✅ | 仅自己的 | ⚠️ 仅自己的项目 |
| 创建报价 | ✅ | ✅ | ✅ | ❌ |
| 删除报价 | ✅ | ⚠️ 需审批 | ❌ | ❌ |
| 查看合同 | ✅ | ✅ | 仅自己的 | ❌ |
| 创建合同 | ✅ | ✅ | ❌ | ❌ |
| 查看付款 | ✅ | ✅ | ❌ | ❌ |
| 财务报表 | ✅ | ✅ | ❌ | ❌ |
| 用户管理 | ✅ | ✅ | ❌ | ❌ |
| 系统配置 | ✅ | ❌ | ❌ | ❌ |
| 查看运营仪表盘 | ✅ | ✅ | ❌ | ❌ |

### 5.2 RLS 策略审计 (当前状态)

当前 `profiles` 表已有 `role` 检查 (`admin`, `manager`, `sales`, `designer`)。

**当前 RLS 策略** (从 migrations 所见):
- `leads` 表: 有 `assigned_to` 外键 → `profiles(id)`
- 已有 basic RLS on leads (自己或 admin/manager 可见)

**缺失的 RLS 策略**:

```sql
-- quotes: 仅创建者或 manager+ 可见
CREATE POLICY "quotes_owner_access" ON quotes
  FOR ALL USING (
    auth.uid() = created_by
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','manager'))
  );

-- contracts: 仅 manager+ 可见
CREATE POLICY "contracts_admin_manage" ON contracts
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','manager'))
  );

-- payments: 仅 manager+ 可见
CREATE POLICY "payments_finance_only" ON payments
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','manager'))
  );

-- chat_messages: 关联到 lead 的权限
CREATE POLICY "chat_lead_owner" ON chat_messages
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM leads
      WHERE leads.id = chat_messages.lead_id
        AND (leads.assigned_to = auth.uid()
          OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','manager')))
    )
  );
```

### 5.3 安全清单

#### 网络安全
- [x] UFW deny incoming (已启用)
- [ ] SSH 仅允许 key auth (当前需验证)
- [ ] HTTPS 证书 (certbot 已安装, 但需确认自动续期)
- [ ] Rate limiting on auth endpoints
- [ ] CORS 限制 (仅允许 `app.newme.ae`)

#### 应用安全
- [ ] Supabase RLS 策略全覆盖
- [ ] API 端点认证 (Next.js 路由处理器)
- [ ] COS 对象访问签名 (presigned URL)
- [ ] 输入验证 (XSS 防护)
- [ ] Telegram bot 白名单

#### 数据安全
- [x] COS 已配置私密访问
- [ ] COS 备份桶只读
- [ ] 数据库密码轮换 (每季度)
- [ ] API key 存储 (.env 加密)
- [ ] 敏感字段加密 (电话/邮箱)

### 5.4 操作审计 (建议)

当前缺少操作日志。建议在 Supabase 中增加 `audit_log` 表:

```sql
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id),
  action TEXT NOT NULL,          -- 'lead.created', 'lead.deleted', 'quote.generated'
  entity_type TEXT NOT NULL,     -- 'lead', 'quote', 'contract', 'payment'
  entity_id UUID,
  metadata JSONB,                -- 额外的上下文 (旧值, 新值)
  ip_address INET,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 对关键操作创建触发器自动记录
CREATE OR REPLACE FUNCTION log_lead_delete()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
  VALUES (auth.uid(), 'lead.deleted', 'lead', OLD.id,
    jsonb_build_object('customer_name', OLD.customer_name, 'phone', OLD.phone));
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

---

## 6. 成本预估与扩容路径

### 6.1 当前月成本 (预估)

| 项目 | 规格 | 月费 | 备注 |
|------|------|------|------|
| Lighthouse VPS | 4C/8G/80GB (Singapore) | ~$24 | 轻量应用服务器 |
| Supabase Pro | 托管 PostgreSQL (8GB) | ~$25 | 含 Auth + Storage |
| COS 存储 | newme-1302961787 (150 文件) | ~$3 | 按量计费, 极少 |
| COS 存储 | tanya-1420640156 | ~$2 | 设计模板 |
| 域名 (newme.ae) | .ae 域名 | ~$15/年 | $1.25/月 |
| Telegram Bot | 免费 | $0 | 无限制 |
| **总计** | | **~$55/月** | |

### 6.2 扩展成本预测

| 数据规模 | Leads | VPS | DB | COS | 月总计 |
|---------|-------|-----|----|-----|--------|
| 当前 (2026 Q2) | 267 | $24 | $25 | $5 | ~$55 |
| 成长 (2026 Q4) | 2,000 | $24 | $25 | $15 | ~$65 |
| 增长 (2027 Q2) | 10,000 | $48 | $75 | $50 | ~$175 |
| 规模化 (2028) | 50,000 | $96 | $150 | $200 | ~$450 |

### 6.3 扩容路径

#### VPS 扩容阶梯

| 阶段 | 配置 | 月费 | 触发条件 |
|------|------|------|---------|
| 当前 | 4C/8G/80GB | $24 | — |
| Step 1 | 8C/16G/160GB | $48 | CPU > 70% 持续 1 周 |
| Step 2 | 16C/32G/320GB | $96 | 用户 > 50 并发 |
| Step 3 | K8s 集群 | $200+ | 需要多区域部署 |

#### Supabase 扩容

| 阶段 | 方案 | 月费 | 说明 |
|------|------|------|------|
| 当前 | Pro (8GB) | $25 | 适合 < 10K leads |
| 下一阶段 | Team (16GB) | $75 | 适合 < 50K leads |
| 规模 | Enterprise | 自定义 | > 50K leads 或需要多区域 |

#### COS 成本优化

- 当前 150 文件, 日常备份 ~ 500MB/天
- 长期: 使用 COS 生命周期规则将归档文件自动转入 **低频存储** (价格约为标准存储的 1/3)
- 30 天前的备份自动转为归档存储

### 6.4 成本节约建议

1. Supabase 使用 reservable capacity (年付 15% 折扣)
2. Lighthouse 使用月付 → 年付 (约 8 折)
3. 冷数据定时移入 COS 归档 (减少标准存储费用)
4. 图片/PDF 上传自动压缩 (减少 COS 流量费用)

---

## 7. 运维 SOP

### 7.1 日常检查清单 (Ops Director 每日运行)

#### 7.1.1 每日 08:00 自动日报 (`ops-director.py --mode=daily-report`)

```yaml
# 自动检查项
Database:
  - row_count(leads) 对比昨日变化
  - 新 leads 数量 (24h)
  - 新 quotes 数量 (24h)
  - 备份距当前时间 < 28h

Services:
  - Next.js HTTP 200 响应
  - Hermes Gateway 进程存活
  - 3 个 MCP 服务存活

Infrastructure:
  - 磁盘使用率 < 80%
  - 内存可用 > 500MB
  - 系统负载 < 4.0

Backup:
  - 最近 backup 文件时间
  - backup 文件大小 > 100KB
  - COS 备份桶对象数量

Security:
  - 最近 24h 失败登录尝试
  - profile count 变化
```

#### 7.1.2 每周日 09:00 周报 (`ops-director.py --mode=weekly-report`)

额外检查:
- 备份恢复验证 (恢复到一个临时 schema)
- COS 跨桶同步延迟检查
- 证书过期检查 (SSL/TLS)
- 磁盘增长趋势 (本周 vs 上周)
- 错误日志关键词统计
- 用户活跃度 (7 天活跃用户数)

### 7.2 故障恢复手册

#### 7.2.1 Next.js 服务挂掉 (502 Bad Gateway)

```
症状: 浏览器/app.newme.ae 返回 502
检查:
  curl -I http://127.0.0.1:3001          # Next.js 本地是否存活
  curl -I https://app.newme.ae           # Nginx 是否正常工作
  sudo systemctl status newme-platform   # systemd 状态

诊断:
  [Next.js 正常]
    → Nginx 配置问题
    → 检查: sudo nginx -t
    → 重启: sudo systemctl reload nginx

  [Next.js 不正常, systemd 显示 failed]
    → 查看日志: sudo journalctl -u newme-platform -n 50
    → 内存不足? → 检查: free -h  |  OOM killer? → dmesg | grep -i oom
    → 端口被占用? → fuser 3001/tcp
    → 手动启动测试: cd ~/newme-platform && PORT=3001 npm start

  [Next.js 不正常, process exited 0]
    → 检查 .env.local 是否存在 (被清空?)
    → 检查 Supabase 连接: 数据库密码没变?
    → 重建 node_modules: rm -rf node_modules && npm install

恢复:
  sudo systemctl restart newme-platform
  sleep 5
  curl -I http://127.0.0.1:3001
```

#### 7.2.2 数据库故障

```
症状: Login 失败 / 页面显示数据库错误
  Supabase 状态: https://status.supabase.com/

诊断:
  curl -I https://vfopmpxlhwzpxqegayew.supabase.co/rest/v1/
  → 如果 Supabase 官方出问题: 等待恢复 (SLA 99.99%)
  → 如果只有我们出问题: 检查 API key 是否过期

恢复:
  1. 检查 .env.local 中 NEXT_PUBLIC_SUPABASE_ANON_KEY 是否匹配
  2. 检查 Supabase 控制台 → Database → 连接数是否超限
  3. 如果数据损坏 → 从 COS 恢复最近备份:

  pg_restore -h NEW_HOST -U NEW_USER -d postgres \
    --clean --no-owner \
    /tmp/newme-full-latest.dump

  4. 验证数据:
  SELECT count(*) FROM leads;
  SELECT count(*) FROM quotes;
```

#### 7.2.3 COS 误删恢复

```
症状: 项目文件找不到 / 客户投诉附件丢失

立即操作:
  1. 停止所有 COS 写操作
  2. 检查备份桶:
     cos.sh list --bucket newme-backup-1420640156
  3. 如果备份桶有: 复制回主桶
  4. 如果没有备份桶:
     - 检查 COS "回收站" (COS 控制台 → 文件管理 → 回收站)
     - 腾讯云 COS 默认保留 30 天回收站
     - 找到删除的文件 → 恢复

事后:
  1. 更新操作流程: 所有删除前必须 dry-run
  2. 确认跨桶复制正常工作
  3. 如果是脚本误删 → 加 --dry-run 保护
```

#### 7.2.4 cgroup 孤儿进程 (历史教训: gateway 死亡新模式)

```
症状: 服务正常但响应超时, 大量僵尸进程
  ps aux | grep defunct
  ps aux | grep -c Z

诊断:
  systemd-cgroup 在容器删除时未收孤儿进程
  表现: Hermes Gateway 挂掉后 MCP 进程变僵尸

恢复:
  # 批量清理僵尸进程
  ps aux | awk '/Z/ {print $2}' | xargs -r kill -9

  # 强制重启 gateway
  cd /home/ubuntu/.hermes/hermes-agent
  docker compose restart gateway

预防:
  # 已部署 zombie-cleaner.py, cron 每小时运行
  # 确保系统配置
  sudo sysctl -w kernel.pid_max=65536
  cat /proc/sys/kernel/pid_max
```

#### 7.2.5 磁盘写满恢复

```
症状: 服务写日志失败 / DB 无法写入
检查:
  df -h                 # 根分区使用率
  du -sh /var/log       # 系统日志
  du -sh ~/.hermes/logs # 应用日志
  du -sh /tmp           # 临时文件

清理:
  # 日志轮转 (立即)
  sudo logrotate -f /etc/logrotate.conf
  journalctl --vacuum-size=500M

  # 清理应用日志 (保留最近 3 天)
  find ~/.hermes/logs -name "*.log.*" -mtime +3 -delete

  # 清理 node 构建缓存
  rm -rf ~/newme-platform/.next/cache

扩展:
  如果频繁发生 → 考虑增加磁盘或配置日志上限
```

#### 7.2.6 Telegram Bot 无响应

```
症状: @newwme_1_bot 发消息无回复

检查:
  # 检查 gateway 进程
  ps aux | grep gateway
  curl -I http://127.0.0.1:22884

  # 检查 docker 容器
  docker ps | grep hermes
  docker logs hermes --tail 50

  # 检查 Telegram 网络 (新加坡到 Telegram 的连通性)
  curl -I https://api.telegram.org/bot<TOKEN>/getMe

恢复:
  docker compose restart gateway
  sleep 10

预防:
  确认 health-monitor.py 已监控 gateway 进程
  如果 >3 次重启失败 → ops-director.py --mode=escalate
```

### 7.3 部署变更 SOP

```
任何生产变更必须遵循:

1. 计划阶段
   □ 变更描述和影响范围
   □ 回滚方案
   □ 变更窗口 (建议: 凌晨 02:00-06:00)

2. 执行阶段
   □ dry-run 验证 (数据操作必须)
   □ 备份当前状态
   □ 逐步发布 (先 branch, 再 prod)

3. 验证阶段
   □ 健康检查通过
   □ 关键路径测试通过
   □ 监控指标正常

4. 事后阶段
   □ 更新文档
   □ 通知相关方
   □ 记录到变更日志

快速回滚:
  cd ~/newme-platform
  git stash           # 撤销未提交更改
  git checkout HEAD~1 # 回退到上一个版本
  npm run build && sudo systemctl restart newme-platform
```

---

## 8. 事故复盘与改进

### 8.1 历史事故: gateway cgroup 孤儿进程

**问题**: Docker gateway 重启后 systemd-cgroup 未回收 orphan 进程, 导致系统资源泄漏

**已采取**: 
- ✅ `zombie-cleaner.py` (cron 每小时)
- ✅ `health-monitor.py` 检测僵尸进程
- ✅ `unified-watchdog.sh` 自动修复

**仍缺**:
- ❌ `docker compose down` 时未规范化清理子进程
- ❌ 未在 `docker-compose.yml` 中设置 `init: true` (tini 进程管理器)

**建议修复**:
```yaml
# docker-compose.yml gateway section:
services:
  gateway:
    image: hermes-agent
    init: true           # 使用 tini 作为 PID 1
    stop_grace_period: 30s
```

### 8.2 历史事故: COS 误删 Mohammed Shami 项目

**问题**: 无 dry-run 保护直接执行删除操作

**已采取**: 
- ✅ `cos.sh` 脚本 (封装操作)
- ✅ 删除前必须手动确认

**仍缺**:
- ❌ 无 COS 跨桶备份
- ❌ 无回收站检查流程
- ❌ 无删除审批流程

### 8.3 关键改进项目清单 (已识别到实施)

| 项目 | 优先级 | 预估工时 | 依赖 |
|------|--------|---------|------|
| Supabase DB 备份脚本 | P0 | 2h | COS 访问凭证 |
| COS 跨桶复制 | P0 | 1h | 创建备份桶 |
| RLS 策略补全 | P1 | 4h | 角色定义确认 |
| Ops Dashboard 页面 | P1 | 8h | Next.js 前端 |
| 删除审批流程 | P1 | 2h | 前端 + RLS |
| Docker init:true | P1 | 0.5h | docker-compose 修改 |
| 外部 uptime 监控 | P2 | 1h | 注册 uptime.com/checkly |
| 备份验证脚本 | P2 | 3h | 建立测试 DB |

---

## 9. 实施路线图

### Phase 1 (本周) — 救火

| 任务 | 负责人 | ETA |
|------|--------|-----|
| [P0] 实现 Supabase DB 每日备份脚本 (pg_dump → COS) | Ops | Day 1 |
| [P0] 创建 COS 备份桶并配置定时同步 | Ops | Day 1 |
| [P0] 启动第一次手动备份 → 验证恢复流程 | Ops | Day 1 |
| [P1] Docker compose 设置 `init: true` | Ops | Day 1 |

### Phase 2 (下周) — 治理

| 任务 | 负责人 | ETA |
|------|--------|-----|
| [P1] 补全所有表的 RLS 策略 | Dev | Week 2 |
| [P1] 增加 role 管理页面 (admin 可分配权限) | Dev | Week 2 |
| [P1] 实现删除 dry-run + 二次确认 | Dev | Week 2 |
| [P2] Ops Dashboard 第一期 (备份状态 + 磁盘 + 服务) | Dev | Week 2 |
| [P2] 审计日志表 + 关键操作触发器 | Dev | Week 2 |

### Phase 3 (本月) — 完备

| 任务 | 负责人 | ETA |
|------|--------|-----|
| [P1] 配置外部 uptime 监控 (betteruptime / checkly) | Ops | Month 1 |
| [P2] 业务指标仪表盘 (lead 转化率, 报价成功率) | Dev | Month 1 |
| [P2] 备份恢复半自动演练 | Ops | Month 1 |
| [P2] API key 轮换机制 | Dev | Month 1 |
| [P2] 每日日报通知到 Telegram 群 | Ops | Month 1 |

### Phase 4 (季度) — 规模

| 任务 | 负责人 | ETA |
|------|--------|-----|
| 数据保留策略自动化 (归档/退役触发器) | Ops | Q3 |
| 容量规划预测 (基于增长趋势) | Ops | Q3 |
| 灾难恢复手册文档化 + 半年度演练 | Ops | Q4 |
| K8s 评估 (当前不需要, 但开始调研) | Ops | Q4 |

---

## 附录

### A. 参考命令速查

```bash
# 系统
systemctl status newme-platform
journalctl -u newme-platform -n 30 --no-pager
df -h | grep -v overlay
free -h
top -bn1 | head -5

# Docker
docker ps -a --filter name=hermes
docker logs hermes --tail 30
docker compose -f ~/.hermes/hermes-agent/docker-compose.yml restart gateway

# Database (Supabase CLI)
npx supabase db dump -f /tmp/schema.sql

# COS
cos.sh list
cos.sh download <key> [output_path]
cos.sh upload <local_file> <cos_key>

# Backup verification
# 从 COS 下载最近备份
cos.sh download db-backups/20260605_040000/newme-full.dump /tmp/test.dump
pg_restore --list /tmp/test.dump | head -10

# Ops Director
python3 ~/.hermes/scripts/ops-director.py --mode=status
python3 ~/.hermes/scripts/ops-director.py --mode=daily-report
python3 ~/.hermes/scripts/ops-director.py --mode=cos-check
```

### B. 关键文件路径

| 文件 | 路径 |
|------|------|
| Next.js 服务 systemd | `/etc/systemd/system/newme-platform.service` |
| Nginx 配置 | `/etc/nginx/sites-available/default` |
| Supabase 迁移 | `/home/ubuntu/newme-platform/supabase/migrations/` |
| Health Monitor | `/home/ubuntu/.hermes/scripts/health-monitor.py` |
| Ops Director | `/home/ubuntu/.hermes/scripts/ops-director.py` |
| CVM Backup | `/home/ubuntu/.hermes/scripts/cvm-backup.py` |
| COS 脚本 | `/home/ubuntu/.hermes/scripts/cos.sh` |
| Docker Compose | `/home/ubuntu/.hermes/hermes-agent/docker-compose.yml` |
| 环境变量 | `/home/ubuntu/newme-platform/.env.local` |
| 架构图 | `docs/ops-architecture.excalidraw` |

### C. 参考文档

- [NewMe 架构审计报告](ARCHITECTURE_AUDIT.md)
- [Supabase 安全最佳实践](https://supabase.com/docs/guides/auth/row-level-security)
- [COS 跨区域复制指南](https://cloud.tencent.com/document/product/436/12142)
- [Docker container init](https://docs.docker.com/compose/compose-file/#init)
