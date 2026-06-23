# 06 — Operations Log

> 生产操作执行记录。每次数据库迁移、部署、回滚均在此登记。

---

## 迁移执行记录

| # | 迁移文件 | 操作 | 环境 | 日期 | 结果 |
|---|----------|------|------|------|------|
| 1 | 20260623020000_crm_v3_new_tables.sql | 新建6张表 | prod | 2026-06-23 | ✅ |
| 2 | 20260623020000_crm_v3_leads_extensions.sql | leads 扩展字段 | prod | 2026-06-23 | ✅ |
| 3 | 20260623020000_crm_v3_rls_policies.sql | RLS 策略 | prod | 2026-06-23 | ✅ |
| 4 | 20260623021000_add_no_answer_flag.sql | no_answer 标记 | prod | 2026-06-23 | ✅ |
| 5 | 20260623030000_crm_v3_stage_to_milestone_mapping.sql | stage→milestone 数据回填 | prod | 2026-06-23 | ✅ |
| 6 | 20260623040000_crm_v3_phase_b_fields.sql | Phase B 13个扩展字段 | prod | 2026-06-23 | ✅ |

---

## 部署记录

| # | 分支 | BUILD_ID | 操作 | 日期 | 结果 |
|---|------|----------|------|------|------|
| 1 | feat/crm-v3 | Ck2LqwPhoP6CeP2sTmPkh | Phase A 全量部署 | 2026-06-23 | ✅ |
| 2 | feat/crm-v3 | 56VdNLJf30zrdAKZLPnLb | Phase B 第一波 (扩展字段migration + health-score) | 2026-06-23 | ✅ |
| 3 | feat/crm-v3 | V6oJ1ZkMSMsdks_RQ2lDe | Phase B Command Center + 导航隐藏 | 2026-06-23 | ✅ |
| 4 | main | 待更新 | Phase B 剩余 (Health Score UI + 扩展字段UI) | 待部署 | ⏳ |
