---
title: proposal-factory-business-rules
type: note
permalink: personal/newme-os/knowledge/smart-home/proposal-factory-business-rules
canonical_status: active
owner: 森哥
last_verified: 2026-07-21
volatility: medium
truth_source: Hermes skill bundle v0.5.1 + cross-project lessons (Pennaz V3→V4 fix 2026-06-11)
sources:
  - /home/ubuntu/.hermes/skills/smart-home/proposal-factory/SKILL.md (triggers: fee percentage 10/10/5, section total hardcoded, financial reconciliation, 财务联动, quotation row mapping)
  - /home/ubuntu/.hermes/knowledge/02-projects/00-cross-project-lessons.md (V3→V4 checklist)
relations:
  - proposal-factory-index
  - proposal-factory-pipeline
  - proposal-factory-quality-gates
---

# Proposal Factory — Business Rules

> These are the **engineering + business gates** that quotations must pass. Custom mode runs all of these via `custom_post_validate`. Generic mode runs the equivalent via `generic_cross_validate`.

## 1. Fee Structure (MANDATORY: 10 / 10 / 5)
Every delivered Excel quotation must apply three fee percentages consistently across **all** sections:
| Fee | % | Applies to |
|-----|---|-----------|
| Design | 10% | Section subtotal (equipment + installation base) |
| Install | 10% | Section subtotal (equipment + installation base) |
| Program | 5% | Section subtotal (equipment + installation base) |

**Hard rule:** the same 10/10/5 split appears on every section. If even one section shows a different percentage (e.g. someone hardcoded 8% install), the run is BLOCKED.

## 2. Margin Rules
- Internal cost must NEVER leak into the client-facing sheet (trigger: `内部成本泄漏`).
- Client-facing rows = distributor list price × markup. Internal cost stays in `audit_report.md` only.
- Markup tiers and exact percentages → see `proposal-factory-pricing-rules`.

## 3. Pricing Tiers
Tiered by equipment class; details in `proposal-factory-pricing-rules`:
| Tier | Examples | Notes |
|------|----------|-------|
| Tier A (premium) | ABB, Gira, Theben, SONOS top SKU | Default for Tier-A villas |
| Tier B (mid) | MDT, Citron, 1Home, CoolAuto | Value engineering option |
| Tier C (budget) | PolarBear, Creatrol 24G | Only on client opt-in |

## 4. Quotation Row Mapping Rules
- Each physical device on the BOQ maps to exactly **one** quotation row.
- No "miscellaneous" or "various" roll-up rows permitted on the client sheet.
- Source: `device_quantity.json` (output of [3]) → drives each row.
- Quotation fill report (`quotation_fill_report`) is generated; if "报价只填了2行" → BLOCKED (`fill_rate` below threshold).

## 5. Section Total Rules
- Section subtotals are **hardcoded formulas** — not derived from cell ranges that can silently shift.
- Trigger keyword: `section total hardcoded`. If a section total is a `SUM()` over a range and rows are added/removed upstream, the formula drifts. Hardcode or pin ranges explicitly.
- **Every section's subtotal** must include Design 10% + Install 10% + Program 5% lines.

## 6. Financial Reconciliation (财务联动)
Final reconciliation requires:
| Check | Pass Criterion |
|-------|----------------|
| Σ(Section Subtotals) | == Grand Total on Summary sheet |
| Grand Total | == Σ(Design) + Σ(Install) + Σ(Program) + Σ(Equipment) |
| Per-section fees | All three fee lines (D / I / P) present and at 10/10/5 |
| No blank fee cells | All fee rows populated |
| Currency | AED throughout; no mixed-currency drift |

## 7. Custom-Mode Engineering Gates (`custom_post_validate`)
The 9 business rules below run as a chain. ANY failure → BLOCKED.

| # | Rule | Notes |
|---|------|-------|
| 1 | CoolMaster count | Count of CoolMaster/HVAC gateway entries matches HVAC drawing count |
| 2 | Curtain motor double-track | If project is double-curtain (e.g. Pennaz), motor count = 2 × window count |
| 3 | Fee percentage 10/10/5 | See §1 |
| 4 | Boundary rooms | 员工区 / 封闭式厨房 / 露台 / 桑拿 / 影音室 flagged for human ruling, not auto-decided |
| 5 | Speaker parity | SONOS / multi-room speaker count matches room coverage expectation |
| 6 | Section total hardcoded | See §5 |
| 7 | Financial reconciliation | See §6 |
| 8 | Post-step validation | Each pipeline step's outputs exist + non-empty |
| 9 | COS path drift | Output paths match `PIPELINE_CONFIG.yaml` declared paths |

## 8. Boundary Room Adjudication
The following room types **cannot be auto-decided** by the pipeline. They must be surfaced for human (森哥 / Tanya) ruling before the row leaves DRAFT:

| Room | Decision Pending |
|------|------------------|
| 员工区 (司机 / 保姆 / 员工厨房) | Equip or skip? |
| 封闭式厨房 | Dim or no-dim? |
| 室外 (露台 / 平台) | Not climate-controlled — include? |
| 桑拿 / 蒸汽房 | Not climate-controlled — include? |
| 影音室 | Dim mandatory; confirm scene set |

## 9. Relations
- `proposal-factory-index` — entry point
- `proposal-factory-pipeline` — where these rules execute (step [6] cross validation)
- `proposal-factory-quality-gates` — acceptance guard + cross-validation details
