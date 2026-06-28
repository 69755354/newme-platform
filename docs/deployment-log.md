# CRM v3.1 部署日志

## 2026-06-28 02:15 Dubai — P0-2+P0-7 合并部署
- **Commit**: 2ffc723 (P0-7) + 7bfcca5 (P0-2) + d501e03 (Phase 1)
- **BUILD_ID**: LagCCIRGDgNE
- **改动**:
  - P0-2: Dashboard `+ New Leads` 按钮 → window.location.href
  - P0-7: due_at UTC锚点统一 + 错误toast化 + QuickCreateLeadDialog同修
  - Phase 1: Workbench + Timeline + Delete + Cron Mute
- **验证**: tsc ✅ | build ✅ | health 200 | /leads/new 200 | /dashboard 200
- **审计**: Codex+CC双审 P0=0 P1=6 P2=6，交叉验证一致
- **已知问题**: router.push跨页缓存（见session-summary）

## 2026-06-26/27 Dubai — Sales Rollout GO
- **Commit**: 33eb119
- **BUILD_ID**: Ldp9LtvoJ-n8
- **Branch**: main
- **Deploy time**: 2026-06-27 02:18 CST (2026-06-26 22:18 Dubai)

## 改动文件
- `src/app/(dashboard)/workbench/page.tsx` — 添加反馈入口 (CC patch)
- `docs/runbooks/crm-rollback-playbook.md` — 新增回滚预案
- `~/.hermes/scripts/crm-daily-ops-report.py` — 新增运维日报脚本
- `~/.hermes/scripts/crm-sales-usage.py` — 新增销售使用量统计
- `~/.hermes/scripts/crm-failure-aggregation.py` — 新增失败聚合统计

## 验证结果
- Build: PASS
- Health: 200
- 14-route smoke: all 200/307, zero 500
- DB unique index: LIVE (409/23505 verified)
- Concurrency sanity: 3/3 PASS
- tsc --noEmit: PASS

## Cron 新增
- 39a8ad06cfd9: CRM Daily Ops Report — 每日 18:00 Dubai → CRM PROJECT 群

## 版本一致性
- git HEAD = release.json = deployed BUILD_ID ✅

## 防护链
- L1: frontend disabled={saving/updating} ✅
- L2: API SELECT → 409 ✅
- L3: API 23505 → 409 ✅
- L4: DB partial unique index: idx_contracts_one_active_per_lead ✅
