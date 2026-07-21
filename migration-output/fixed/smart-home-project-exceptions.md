---
title: smart-home-project-exceptions
type: note
permalink: personal/newme-os/knowledge/smart-home/smart-home-project-exceptions
canonical_status: active
owner: 森哥
last_verified: 2026-07-21
volatility: high
truth_source: cross-project lessons (Pennaz 2026-06, Ibrahim 2026-05) + per-project confirmed decisions
source_paths:
  - /home/ubuntu/.hermes/knowledge/02-projects/00-cross-project-lessons.md
  - Pennaz V3→V4 fix log (2026-06-11)
  - Ibrahim project state
  - Mohit Villa (generic-mode reference)
knowledge_class: mixed (project_exception for per-project deviations; company_standard for cross-project lessons and post-mortem policies)
verification_status: partial
supersedes: migration-output/smart-home-project-exceptions.md (pre-classification version)
relations:
  - smart-home-index
  - smart-home-room-rules
  - proposal-factory-quality-gates
  - proposal-factory-pipeline
---

# Smart Home — Project Exceptions & Lessons

> This file captures **deviations from the standard rules** in `smart-home-room-rules` / `smart-home-design-principles`, plus **cross-project lessons**. Universal rules live in their canonical files; **only exceptions live here**.

> **Classification note (2026-07-21):** Per-project deviations retain their project attribution and are tagged `project_exception`. Cross-project lessons and post-mortem policies (including each Pennaz V3→V4 checklist item) are tagged `company_standard` where they have been generalised into NewMe policy, or `project_exception` where they remain Pennaz-specific. Each Pennaz checklist item in §4 now carries its own tag.

## 1. Project Parameters Comparison (`project_exception`)
| Parameter | Pennaz | Ibrahim | knowledge_class |
|-----------|--------|---------|-----------------|
| 面积 | ~1200 sqm | ~770 sqm | `project_exception` |
| 楼层 | GF + FF + SF (3 layers) | GF + FF (2 layers) | `project_exception` |
| 灯光回路 | ~72 | ~72 | `project_exception` |
| 窗帘电机 | 20 (双层 double-track) | 14 (单层 single-track) | `project_exception` |
| 温控面板 | 16 | ~12 | `project_exception` |
| 传感器 | 24 | ~18 | `project_exception` |
| 报价总额 | 163,880 AED | — | `project_exception` |
| 含价模板 | ✅ yes | ❌ no (Creatrol 24G) | `project_exception` |

## 2. Reusable Patterns (apply across projects)
> Each pattern is `company_standard` (NewMe post-lesson policy) unless tagged otherwise.

### 2.1 Device counting — PDF text layer is truth (`company_standard`, Pennaz V3 post-mortem 2026-06-11)
**Pattern:** Do **not** count devices via Vision. PDF `pg.get_text("words")` with coordinates is authoritative.
**Validation:** Pennaz — Vision counts disagreed with PDF text layer; PDF was correct.

### 2.2 Quotation fill — UNO image-preserving writeback (`company_standard`)
**Pattern:** LibreOffice UNO macro writes back to the quotation while preserving embedded images.
**Applies to:** all `.xls` format templates that ship with embedded pricing images.
**Script:** `scripts/fill_quotation_preserve_images.py`.

### 2.3 Layout diagrams — template-generic fallback (`company_standard`, Ibrahim ruling 2026-05)
**Pattern:** When client doesn't supply DWG (or DWG is incompatible), use `NEWME_layout_template.pptx` with corrected page notes.
**Precedent:** Ibrahim — 森哥 ruled "template generic is enough".

### 2.4 Boundary room adjudication (`company_standard`)
**Pattern:** These rooms cannot be auto-decided — must be surfaced for human ruling:
- 员工区 (driver / maid / staff kitchen)
- 封闭式厨房 (closed kitchen — dim vs no-dim)
- 室外 (terrace / deck — not climate-controlled)
- 桑拿 / 蒸汽房 (sauna / steam — not climate-controlled)
- 影音室 (home theater — dim required by NewMe design)

### 2.5 DWG format fallback (`company_standard`, Pennaz lesson)
**Pattern:** DWG AC1032 format = dead end. Go straight to PDF; do **not** waste time trying converters.

## 3. Project-Specific Deviations (`project_exception`)
> These cannot be cross-applied without re-asking.

| Deviation | Pennaz | Ibrahim | Decision Source | knowledge_class |
|-----------|--------|---------|-----------------|-----------------|
| Curtain layers | 双层 (fabric + sheer) = 20 motors | 单层 = 14 motors | **ASK per project** | `project_exception` |
| 员工区 | 全不配 | — | Ask per project | `project_exception` |
| Temperature panels | 16 × Citron | ~12 | Derive room-by-room | `project_exception` |
| 含价模板 | Yes | No (Creatrol 24G) | Search COS at project start | `project_exception` |
| SONOS pricing | Take highest SKU price | TBD | Brand confirm then backfill | `project_exception` |

## 4. Pennaz V3→V4 Delivery Checklist (2026-06-11 post-mortem)
> **Incident:** V3 was declared delivery-ready; Tanya found 4 problems on inspection.
> Full checklist mirrored in `proposal-factory-quality-gates` §5.

> **Classification (2026-07-21):** Each item below is tagged individually. Items that have been generalised into NewMe policy (apply to every project) are `company_standard`. Items that remain Pennaz-specific are `project_exception`.

| # | Checklist item | knowledge_class | rationale |
|---|----------------|-----------------|-----------|
| 1 | PPT底图 MD5 matches customer source — NO template-generic images | `company_standard` | Generalised post-mortem policy: applies to every project. |
| 2 | PPT楼层 — non-existent floor (BF) pages deleted; GF/FF/SF labels consistent | `company_standard` | Generalised post-mortem policy. |
| 3 | Excel页脚 — libreoffice→PDF→pdftotext shows ZERO Chinese | `company_standard` | Generalised post-mortem policy: applies to every UAE client deliverable. |
| 4 | Excel费率 — every section Design 10% + Install 10% + Program 5% | `company_standard` | Generalised NewMe pricing policy (rate constants). |
| 5 | Excel Grand Total — Σ(Section Subtotals) == Summary Total | `company_standard` | Generalised QA invariant. |
| 6 | COS凭证 — per-target-bucket credentials, never mixed | `company_standard` | Generalised NewMe infra policy. |
| 7 | 视觉QA — render Excel/PPT to PNG; don't trust data reads | `company_standard` | Generalised post-mortem policy. |
| 8 | python-pptx删页 — NEVER attempt; only replace images | `company_standard` | Generalised engineering policy (python-pptx page-delete is unsafe). |
| 9 | openpyxl页脚 — `HeaderFooterItem(center=_HeaderFooterPart())` three-level nesting | `company_standard` | Generalised implementation policy. |
| 10 | GLM视觉对比 — NEVER use GLM for "are these two images the same" (hallucination) | `company_standard` | Generalised NewMe AI-usage policy. |

> All ten checklist items have been promoted to `company_standard` (post-mortem policy). The triggering incident remains `project_exception` (Pennaz 2026-06-11); the policies themselves apply NewMe-wide.

```
[ ] PPT底图 MD5 matches customer source — NO template-generic images            [company_standard]
[ ] PPT楼层 — non-existent floor (BF) pages deleted; GF/FF/SF labels consistent  [company_standard]
[ ] Excel页脚 — libreoffice→PDF→pdftotext shows ZERO Chinese                     [company_standard]
[ ] Excel费率 — every section Design 10% + Install 10% + Program 5%              [company_standard]
[ ] Excel Grand Total — Σ(Section Subtotals) == Summary Total                    [company_standard]
[ ] COS凭证 — per-target-bucket credentials, never mixed                         [company_standard]
[ ] 视觉QA — render Excel/PPT to PNG; don't trust data reads                     [company_standard]
[ ] python-pptx删页 — NEVER attempt; only replace images                         [company_standard]
[ ] openpyxl页脚 — HeaderFooterItem(center=_HeaderFooterPart()) three-level nesting [company_standard]
[ ] GLM视觉对比 — NEVER use GLM for "are these two images the same" (hallucination) [company_standard]
```

## 5. New Project Startup Checklist (`company_standard`)
> Generalised NewMe startup policy.

```
[ ] Get PDF drawings (NOT DWG)                                                   [company_standard]
[ ] COS search for "含价" prefix templates                                       [company_standard]
[ ] Confirm floor count + total area                                             [company_standard]
[ ] Confirm curtain single vs double track                                       [company_standard]
[ ] Confirm boundary room handling (员工区 / 封闭式厨房 / 室外 / 桑拿 / 影音室)    [company_standard]
[ ] Confirm temperature panel / sensor brand                                     [company_standard]
[ ] Confirm background audio brand (SONOS / other / TBD)                         [company_standard]
[ ] Read MASTER-INDEX → route by task type                                       [company_standard]
```

## 6. Mohit Villa — Generic Mode Reference Case (`project_exception`)
- Triggers generic pipeline path (`proposal-factory-pipeline` §2.3).
- No dedicated custom scripts.
- Uses `generic_quantity_builder.py` + `generic_quotation_builder.py`.
- Validates that the generic mode can take a new project end-to-end through the fail gate.

## 7. Conflicts Policy (`company_standard`)
Where this file conflicts with `smart-home-room-rules` or `smart-home-design-principles`:
- **Universal rules win** unless this file explicitly records a 森哥 / Tanya ruling for a named project.
- Every exception here must cite the decision source (project + date + decider).

## 8. Relations
- `smart-home-index`
- `smart-home-room-rules` (the standard table these are exceptions to)
- `proposal-factory-quality-gates` (Pennaz V3→V4 checklist)
- `proposal-factory-pipeline` (three modes — generic validated on Mohit)
