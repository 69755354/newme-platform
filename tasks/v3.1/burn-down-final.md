# CRM v3.1 PRD Burn-down — FINAL

**Updated**: 2026-06-26 19:50 WIB
**Latest commit**: `9beb20d`

---

## P0: ALL PASS ✅

| Item | Status |
|------|--------|
| Timeline rule_013 (UNION 7 tables) | ✅ |
| Pipeline rule_005 (current_milestone) | ✅ |
| Won→Contract chain | ✅ Verified: 150K AED → contract + 3 installments + project |
| Workbench MVP | ✅ |

## P1: 2 remaining

| Item | Status | Notes |
|------|--------|-------|
| Analytics accuracy | ✅ Batch 6: 3 APIs agree at 67 leads | |
| Ads/ROI archive filter | ✅ Batch 7: +archived=false | |
| ~~Ads page "Coming Soon"~~ | ✅ Already functional, 259 lines | |
| Won chain live test | ✅ Batch 8: full chain verified | |

## P2: 2 remaining

| Item | Status |
|------|--------|
| i18n raw keys | 1 known gap fixed (Batch 1). Nested key scan noisy — minor |
| Data cleanup | 1 fake lead (095a6fe4), 2 null profiles (0bdb28a1, 1cd94d17) with 0 leads |

## Batch Summary

| Batch | Date | Content | CC Cost |
|-------|------|---------|---------|
| 1 | 06-26 | created→imported, i18n, phase comment | $0.33 |
| 2 | 06-26 | imported_by verify, project phases | — |
| 3 | 06-26 | PRD Burn-down table (18 modules) | — |
| 4 | 06-26 | Timeline UNION, Pipeline milestone, Won trigger | $0.37 |
| 5 | 06-26 | Workbench MVP | $1.27 |
| 6 | 06-26 | Analytics accuracy (3 APIs) | $0.43 |
| 7 | 06-26 | Ads ROI archived filter | $0.69 |
| 8+9 | 06-26 | Won chain test + P2 scan | — |

**Total CC cost**: $3.09
**Total commits**: 6 (f31ba50 → 9beb20d)

## Model Switch

CC now uses **Qwen3-Coder-Plus** (Anthropic-compatible). GLM 5.2 paused.
Qwen: 2-14x faster, comparable cost, quality 8/10.
