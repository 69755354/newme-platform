---
title: proposal-factory-index
type: note
permalink: personal/newme-os/knowledge/smart-home/proposal-factory-index
canonical_status: active
owner: 森哥
last_verified: 2026-07-21
volatility: medium
truth_source: Hermes skill bundle v0.5.1 Patch 3 (2026-06-26)
sources:
  - /home/ubuntu/.hermes/skills/smart-home/proposal-factory/SKILL.md
  - /home/ubuntu/.hermes/skills/smart-home/quotation-workflow-pitfalls/SKILL.md
  - /home/ubuntu/.hermes/skills/smart-home/acceptance-guard/SKILL.md
  - /home/ubuntu/.hermes/projects/PIPELINE_CONFIG.yaml
  - /home/ubuntu/.hermes/projects/VERSION_LOCK
  - /home/ubuntu/.hermes/projects/README-BEFORE-ACT
relations:
  - proposal-factory-business-rules
  - proposal-factory-pipeline
  - proposal-factory-quality-gates
  - proposal-factory-pricing-rules
  - smart-home-index
---

# Proposal Factory — Index

> **Version:** v0.5.1 Patch 3 (2026-06-26)
> **One command, no human steering required.**

The Proposal Factory is the production pipeline for KNX smart home proposals. It takes drawings + requirements as input and emits an audited, deliverable-ready quotation + PPT package.

## Module Map
| # | File | Domain | Volatility |
|---|------|--------|------------|
| 1 | `proposal-factory-index` (this file) | Navigation + status | low |
| 2 | `proposal-factory-business-rules` | Fees, margins, quotation row mapping, financial reconciliation | medium |
| 3 | `proposal-factory-pipeline` | Stages, three modes, guard chain, quality gates | medium |
| 4 | `proposal-factory-quality-gates` | Acceptance guard, cross-validation, regression, pitfalls | high |
| 5 | `proposal-factory-pricing-rules` | KNX distributor pricing (UAE 2026), markup, labor, DEWA compliance | high |

## Component Status (v0.5.1 Patch 3)
| Component | Status | Notes |
|-----------|--------|-------|
| Pipeline Runner + `PIPELINE_CONFIG.yaml` | ✅ active | Three modes: custom / existing_files_only / generic |
| State Recovery Guard (`state_guard.py`) | ✅ active | READ-BEFORE-ACT entry point |
| Drawing Guard (`drawing_guard.py`) | ✅ active | Blocks on HVAC图混淆 / 图纸混淆 |
| PPT Guard (`ppt_guard.py`) | ✅ active | Catches PPT乱图 / 设备出界 |
| Cross Validation (generic + custom) | ✅ active | generic → fail gate; custom → engineering + 9 business rules |
| Final Audit | ✅ active | Emits `audit_report.md`, `run_manifest.json`, `PROJECT_STATE.yaml` |
| Final Mode (`--mode final`) | ✅ active | Forces HANDOFF + all gates; PASS=exit 0, BLOCKED=exit 1 |
| Release Archive (`03-frozen_rules.md`) | ⚠️ required | Missing archive → BLOCKED at cold start |
| Generic Mode MVP | ✅ active | Template-based, no project-specific scripts needed |

## Three Modes at a Glance
| Mode | When | Path |
|------|------|------|
| `custom` | Project has dedicated scripts (e.g. Pennaz) | [1]→[2]→[3]→[5]→[6]→[7] + `custom_post_validate` |
| `existing_files_only` | Source deliverables already in COS (e.g. Ibrahim) | [1]→[COS VERIFY]→[HANDOFF]→[MANIFEST] |
| `generic` | New project, no dedicated scripts | [1]→[2]→[3]→[4]→[5]→[6]→[7]→[8] |

## Cold Start Order (MANDATORY)
Before any production task, in order:
1. Read `~/.hermes/archives/v0.5.1-release/03-frozen_rules.md`
2. Read `~/.hermes/projects/<project>/PROJECT_STATE.yaml` (if exists)
3. Verify release archive exists — else `BLOCKED (release_archive_missing)`
4. New projects always start as DRAFT — never FINAL on first run.

## Read-First References
- **Business rules** → `proposal-factory-business-rules`
- **Pipeline / modes / guards** → `proposal-factory-pipeline`
- **Acceptance criteria / pitfalls** → `proposal-factory-quality-gates`
- **Pricing (devices / labor / DEWA)** → `proposal-factory-pricing-rules`
