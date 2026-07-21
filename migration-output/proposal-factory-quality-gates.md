---
title: proposal-factory-quality-gates
type: note
permalink: personal/newme-os/knowledge/smart-home/proposal-factory-quality-gates
canonical_status: active
owner: 森哥
last_verified: 2026-07-21
volatility: high
truth_source: acceptance-guard SKILL + quotation-workflow-pitfalls SKILL + Pennaz V3→V4 fix log
sources:
  - /home/ubuntu/.hermes/skills/smart-home/acceptance-guard/SKILL.md
  - /home/ubuntu/.hermes/skills/smart-home/quotation-workflow-pitfalls/SKILL.md
  - /home/ubuntu/.hermes/knowledge/02-projects/00-cross-project-lessons.md (V3→V4 checklist 2026-06-11)
relations:
  - proposal-factory-index
  - proposal-factory-pipeline
  - proposal-factory-business-rules
---

# Proposal Factory — Quality Gates

> This file consolidates the **acceptance criteria** and the **known pitfalls** that have caused real delivery defects. Pitfalls marked with a Pennaz V3→V4 incident reference are post-mortem lessons, not theory.

## 1. Acceptance Guard Criteria

### 1.1 PPT acceptance
| Criterion | Pass Condition |
|-----------|----------------|
| PPT底图 MD5 | Each image's MD5 matches the customer's source file. **No template-generic images.** |
| PPT楼层 | Non-existent floors (e.g. BF if project is GF/FF/SF only) must be deleted. Floor labels consistent (GF/FF/SF). |
| Slide count | >0 slides filled; `0 slides filled` → BLOCKED |
| `ppt_slide_schema.yaml` | Every slide conforms |
| `approved_assets_manifest.json` | All embedded assets registered there |
| `device_quantity.json` | Counts match between PPT and BOQ |

### 1.2 Excel acceptance
| Criterion | Pass Condition |
|-----------|----------------|
| Excel页脚 (zero Chinese) | `libreoffice` → PDF → `pdftotext` check; ANY Chinese in footer area → fail |
| Excel费率 | Design 10% + Install 10% + Program 5% consistent on every section |
| Grand Total reconciliation | Σ(section subtotals) == Summary Total (see `proposal-factory-business-rules` §6) |
| Row fill rate | "报价只填了2行" is the canonical failure → must exceed threshold |

### 1.3 Visual QA (mandatory — not optional)
- Excel and PPT must be **rendered to PNG** and visually verified.
- Do NOT rely on reading cell data alone.
- **GLM vision caveat:** GLM is reliable for single-image description. Do **not** use GLM for "are these two images the same?" comparison — it hallucinates.

### 1.4 COS credentials discipline
- Upload/download must use the key for the **target bucket**.
- Never reuse one bucket's key against another (this was a real Pennaz V3→V4 defect).

## 2. Cross-Validation Rules

### 2.1 Generic mode — `generic_cross_validate.py` (fail gate)
| # | Rule |
|---|------|
| 1 | `device_quantity.json` row count == quotation row count |
| 2 | Section subtotals reconcile to Grand Total |
| 3 | All 10/10/5 fee lines present per section |
| 4 | `ppt_slide_schema.yaml` matches generated PPT |
| 5 | `approved_assets_manifest.json` MD5s match embedded images |
| 6 | No "0 slides filled" / "quotation_fill_report" under threshold |

Fail gate semantics: any single failure → run state BLOCKED, exit 1 on Final Mode.

### 2.2 Custom mode — `custom_post_validate.py`
Engineering gate + 9 business rules. See `proposal-factory-business-rules` §7 for the canonical list (CoolMaster count, curtain motor double-track, 10/10/5, boundary rooms, speaker parity, section total hardcoded, financial reconciliation, post-step validation, COS path drift).

## 3. Regression Test Expectations
Golden baseline + regression test are first-class triggers in the skill.
- **Golden baseline:** the last known-good `runs/FINAL/` output is the reference.
- **Regression test:** re-run pipeline against the same input; every artifact must match golden baseline (byte-equal for Excel/PPT exports modulo timestamp fields).
- **Two-layer validation (两层校验):** (a) engineering gate (cross-stage consistency) + (b) business-rules gate (financial + per-section invariants).

## 4. Known Pitfalls (from `quotation-workflow-pitfalls`)

### 4.1 PPT pitfalls
| Pitfall | Mitigation |
|---------|-----------|
| `python-pptx` cannot delete slides (3 attempts, all failed) | **Never attempt.** Only replace images, never delete pages. |
| PPT乱图 (wrong image on slide) | PPT Guard must MD5-match every embedded image to source |
| 设备出界 (device out of bounds on slide) | Validate slide coordinates against `ppt_slide_schema.yaml` |
| Non-existent floor (BF) pages in template | Strip before generation; verify labels GF/FF/SF |

### 4.2 Excel pitfalls
| Pitfall | Mitigation |
|---------|-----------|
| `openpyxl` footer API | Must use `HeaderFooterItem(center=_HeaderFooterPart())` — three-level nesting; simpler calls silently no-op |
| Section total silently drifting | Hardcode / pin ranges (`section total hardcoded`) — do NOT use raw `SUM(A:A)` |
| Mixed currency (USD slips into AED sheet) | Assert AED everywhere; reject any cell with non-AED currency code |
| Internal cost leaking to client sheet | Trigger `内部成本泄漏`; client sheet must be re-derived from list price × markup, never from internal cost |

### 4.3 DWG / drawing pitfalls
| Pitfall | Mitigation |
|---------|-----------|
| DWG AC1032 format | Dead end. Do not try converters — go straight to PDF |
| Vision vs PDF text-layer device count disagreement | PDF text layer is truth. Vision counts are advisory only |
| HVAC图阻断 | Drawing Guard must detect HVAC layer and proceed accordingly |

### 4.4 COS pitfalls
| Pitfall | Mitigation |
|---------|-----------|
| Path drift between `PIPELINE_CONFIG.yaml` and runtime | Cross-validation rule 9 (COS path drift) |
| Wrong-bucket credential reuse | Per-bucket credentials; assert bucket match before transfer |
| Missing COS files (existing_files_only mode) | `coscmd list verify` step blocks early |

## 5. Pennaz V3→V4 Delivery Checklist (2026-06-11)
> **Incident:** V3 declared delivery-ready; Tanya found 4 problems on inspection.

```
[ ] PPT底图: each image MD5 must match customer source — NO template-generic images
[ ] PPT楼层: non-existent floor (BF) pages deleted; labels consistent (GF/FF/SF)
[ ] Excel页脚: libreoffice→PDF→pdftotext shows ZERO Chinese
[ ] Excel费率: every section Design 10% + Install 10% + Program 5% consistent
[ ] Excel Grand Total: Σ(Section Subtotals) == Summary Total
[ ] COS凭证: per-target-bucket credentials, never mixed
[ ] 视觉QA: render Excel/PPT to PNG and verify visually; do not trust data reads
[ ] python-pptx删页: NEVER — only replace images, never delete pages
[ ] openpyxl页脚: HeaderFooterItem(center=_HeaderFooterPart()) — three-level nesting
[ ] GLM视觉对比: NEVER use GLM for "are these two images the same" (hallucination); single-image description OK
```

## 6. Relations
- `proposal-factory-index`
- `proposal-factory-pipeline` (these gates execute at stages [5], [6], [8])
- `proposal-factory-business-rules` (the 9 custom-mode rules)
