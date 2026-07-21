---
title: smart-home-project-exceptions
type: note
permalink: personal/newme-os/knowledge/smart-home/smart-home-project-exceptions
canonical_status: active
owner: 森哥
last_verified: 2026-07-21
volatility: high
truth_source: cross-project lessons (Pennaz 2026-06, Ibrahim 2026-05) + per-project confirmed decisions
sources:
  - /home/ubuntu/.hermes/knowledge/02-projects/00-cross-project-lessons.md
  - Pennaz V3→V4 fix log (2026-06-11)
  - Ibrahim project state
  - Mohit Villa (generic-mode reference)
relations:
  - smart-home-index
  - smart-home-room-rules
  - proposal-factory-quality-gates
  - proposal-factory-pipeline
---

# Smart Home — Project Exceptions & Lessons

> This file captures **deviations from the standard rules** in `smart-home-room-rules` / `smart-home-design-principles`, plus **cross-project lessons**. Universal rules live in their canonical files; **only exceptions live here**.

## 1. Project Parameters Comparison
| Parameter | Pennaz | Ibrahim |
|-----------|--------|---------|
| 面积 | ~1200 sqm | ~770 sqm |
| 楼层 | GF + FF + SF (3 layers) | GF + FF (2 layers) |
| 灯光回路 | ~72 | ~72 |
| 窗帘电机 | 20 (双层 double-track) | 14 (单层 single-track) |
| 温控面板 | 16 | ~12 |
| 传感器 | 24 | ~18 |
| 报价总额 | 163,880 AED | — |
| 含价模板 | ✅ yes | ❌ no (Creatrol 24G) |

## 2. Reusable Patterns (apply across projects)

### 2.1 Device counting — PDF text layer is truth
**Pattern:** Do **not** count devices via Vision. PDF `pg.get_text("words")` with coordinates is authoritative.
**Validation:** Pennaz — Vision counts disagreed with PDF text layer; PDF was correct.

### 2.2 Quotation fill — UNO image-preserving writeback
**Pattern:** LibreOffice UNO macro writes back to the quotation while preserving embedded images.
**Applies to:** all `.xls` format templates that ship with embedded pricing images.
**Script:** `scripts/fill_quotation_preserve_images.py`.

### 2.3 Layout diagrams — template-generic fallback
**Pattern:** When client doesn't supply DWG (or DWG is incompatible), use `NEWME_layout_template.pptx` with corrected page notes.
**Precedent:** Ibrahim — 森哥 ruled "template generic is enough".

### 2.4 Boundary room adjudication
**Pattern:** These rooms cannot be auto-decided — must be surfaced for human ruling:
- 员工区 (driver / maid / staff kitchen)
- 封闭式厨房 (closed kitchen — dim vs no-dim)
- 室外 (terrace / deck — not climate-controlled)
- 桑拿 / 蒸汽房 (sauna / steam — not climate-controlled)
- 影音室 (home theater — dim mandatory)

### 2.5 DWG format fallback
**Pattern:** DWG AC1032 format = dead end. Go straight to PDF; do **not** waste time trying converters.

## 3. Project-Specific Deviations (cannot be cross-applied without re-asking)

| Deviation | Pennaz | Ibrahim | Decision Source |
|-----------|--------|---------|-----------------|
| Curtain layers | 双层 (fabric + sheer) = 20 motors | 单层 = 14 motors | **ASK per project** |
| 员工区 | 全不配 | — | Ask per project |
| Temperature panels | 16 × Citron | ~12 | Derive room-by-room |
| 含价模板 | Yes | No (Creatrol 24G) | Search COS at project start |
| SONOS pricing | Take highest SKU price | TBD | Brand confirm then backfill |

## 4. Pennaz V3→V4 Delivery Checklist (2026-06-11 post-mortem)
> **Incident:** V3 was declared delivery-ready; Tanya found 4 problems on inspection.
> Full checklist mirrored in `proposal-factory-quality-gates` §5.

```
[ ] PPT底图 MD5 matches customer source — NO template-generic images
[ ] PPT楼层 — non-existent floor (BF) pages deleted; GF/FF/SF labels consistent
[ ] Excel页脚 — libreoffice→PDF→pdftotext shows ZERO Chinese
[ ] Excel费率 — every section Design 10% + Install 10% + Program 5%
[ ] Excel Grand Total — Σ(Section Subtotals) == Summary Total
[ ] COS凭证 — per-target-bucket credentials, never mixed
[ ] 视觉QA — render Excel/PPT to PNG; don't trust data reads
[ ] python-pptx删页 — NEVER attempt; only replace images
[ ] openpyxl页脚 — HeaderFooterItem(center=_HeaderFooterPart()) three-level nesting
[ ] GLM视觉对比 — NEVER use GLM for "are these two images the same" (hallucination)
```

## 5. New Project Startup Checklist
```
[ ] Get PDF drawings (NOT DWG)
[ ] COS search for "含价" prefix templates
[ ] Confirm floor count + total area
[ ] Confirm curtain single vs double track
[ ] Confirm boundary room handling (员工区 / 封闭式厨房 / 室外 / 桑拿 / 影音室)
[ ] Confirm temperature panel / sensor brand
[ ] Confirm background audio brand (SONOS / other / TBD)
[ ] Read MASTER-INDEX → route by task type
```

## 6. Mohit Villa — Generic Mode Reference Case
- Triggers generic pipeline path (`proposal-factory-pipeline` §2.3).
- No dedicated custom scripts.
- Uses `generic_quantity_builder.py` + `generic_quotation_builder.py`.
- Validates that the generic mode can take a new project end-to-end through the fail gate.

## 7. Conflicts Policy
Where this file conflicts with `smart-home-room-rules` or `smart-home-design-principles`:
- **Universal rules win** unless this file explicitly records a 森哥 / Tanya ruling for a named project.
- Every exception here must cite the decision source (project + date + decider).

## 8. Relations
- `smart-home-index`
- `smart-home-room-rules` (the standard table these are exceptions to)
- `proposal-factory-quality-gates` (Pennaz V3→V4 checklist)
- `proposal-factory-pipeline` (three modes — generic validated on Mohit)
