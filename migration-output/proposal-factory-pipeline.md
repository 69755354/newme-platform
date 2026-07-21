---
title: proposal-factory-pipeline
type: note
permalink: personal/newme-os/knowledge/smart-home/proposal-factory-pipeline
canonical_status: active
owner: 森哥
last_verified: 2026-07-21
volatility: medium
truth_source: Hermes skill bundle v0.5.1 Patch 3 + PIPELINE_CONFIG.yaml
sources:
  - /home/ubuntu/.hermes/skills/smart-home/proposal-factory/SKILL.md
  - /home/ubuntu/.hermes/projects/pennaz/PIPELINE_CONFIG.yaml
  - /home/ubuntu/.hermes/projects/README-BEFORE-ACT
relations:
  - proposal-factory-index
  - proposal-factory-business-rules
  - proposal-factory-quality-gates
---

# Proposal Factory — Pipeline

> **Entry trigger examples:** "跑一个generic项目", "Pennaz重新跑一遍", "重新跑一遍", "rerun pipeline", "golden baseline", "regression test".
> **v0.5.1 Patch 3 — 2026-06-26.**

## 1. Top-Level Flow
```
User intent
  │
  ▼
[0] PIPELINE CONFIG CHECK → project_pipeline_adapter.py → PIPELINE_CONFIG.yaml
  │   mode: custom | generic | existing_files_only
  │   missing_config → STOP (BLOCKED)
  │
  ├── custom              → [1]→[2]→[3]→[5]→[6]→[7] + custom_post_validate
  ├── existing_files_only → [1]→[COS VERIFY]→[HANDOFF]→[MANIFEST]
  └── generic             → [1]→[2]→[3]→[4]→[5]→[6]→[7]→[8]
  │
  ▼
Output: ~/.hermes/projects/<project>/runs/{FINAL | V_NEXT | DRAFT_001}/
```

## 2. Modes in Detail

### 2.1 `custom`
- **Used by:** Pennaz (and any project with dedicated scripts).
- **`PIPELINE_CONFIG.yaml` example (Pennaz):**
  ```yaml
  project_name: pennaz
  mode: custom
  custom_scripts:
    quotation: /home/ubuntu/pennaz-project/pennaz_v6_pipeline.py
    ppt:        /home/ubuntu/pennaz-project/fix_ppt_v4.py
  templates:
    quotation_template: "~/.hermes/data/智能家居设计模板/Newme-SHQ-客户姓名-20260508-amyxls.xls"
    ppt_template:        "~/.hermes/data/智能家居设计模板/NEWME AS 客户姓名-日期-LXV3.1.pptx"
  inputs:
    drawings:     [...HVAC LAYOUT PDFs for GF/FF/SF...]
    requirements: "派工单 (KNX 01 PS DESIGN REQUEST FORM.docx)"
    old_quotation: "tanya-1420640156/Pennaz Project/deliverables/Newme-SHQ-Pennaz-20260609-V3.xls"
    old_ppt:       "tanya-1420640156/Pennaz Project/deliverables/NEWME AS Pennaz-20260609-LXV3.1.pptx"
  capabilities:
    can_generate_new_quotation: true
    can_generate_new_ppt: true
    can_use_existing_files: true
  blocked_rules: []
  ```

### 2.2 `existing_files_only`
- **Used by:** Ibrahim (source deliverables already in COS; no regeneration).
- **Path:** `[1] → [COS VERIFY] → [HANDOFF] → [MANIFEST]`
- **Read-only discipline:** `coscmd list verify` → `00-HANDOFF.md` → `run_manifest.json`.
- **BLOCKED if:** COS files missing OR HANDOFF fails to generate (trigger: `COS文件存在性`, `COS path drift`).

### 2.3 `generic`
- **Used by:** new projects without dedicated scripts (Mohit Villa is the reference case).
- **Full path:** `[1]→[2]→[3]→[4]→[5]→[6]→[7]→[8]`.
- Step [3a] `generic_quantity_builder.py` + [3b] `generic_quotation_builder.py` substitute for custom scripts.

## 3. Stage Detail

| # | Stage | Module | Catches / Trigger |
|---|-------|--------|-------------------|
| 0 | Pipeline Config Check | `project_pipeline_adapter.py` + `PIPELINE_CONFIG.yaml` | missing_config |
| 1 | State Recovery Guard | `state_guard.py` (READ-BEFORE-ACT) | 长任务断点恢复 / state recovery guard |
| 2 | Drawing Guard | `drawing_guard.py` | 图纸混淆 / HVAC 图阻断 |
| 3 | Quantity + Quotation | 3a `generic_quantity_builder.py`, 3b `generic_quotation_builder.py` (generic) or custom (Pennaz) | 报价只填了2行 / quotation_fill_report |
| 4 | PPT Generation | generic or custom | slide_data generation failed / 0 slides filled / ppt_slide_schema.yaml / approved_assets_manifest.json |
| 5 | PPT Guard | `ppt_guard.py` | PPT 乱图 / 设备出界 |
| 6 | Cross Validation | generic: `generic_cross_validate.py` (fail gate); custom: `custom_post_validate.py` (engineering + 9 business rules) | 两层校验 / 工程闸门 / 业务规则闸门 |
| 7 | Final Audit | emits `audit_report.md` + `run_manifest.json` + `PROJECT_STATE.yaml` | final audit |
| 8 | Final Mode | `--mode final` forces HANDOFF + all gates; PASS=exit 0, BLOCKED=exit 1 | FINAL Ready / FINAL BLOCKED |

## 4. Guard Chain (Sequence, Non-Skippable)
```
State Guard  →  Drawing Guard  →  PPT Guard  →  Cross Validation  →  Fail Gate
   [1]              [2]              [5]              [6]                [8]
```
- Each guard emits a structured `blocked_reason` on failure.
- Failure of any guard → run state goes BLOCKED; no later stage runs.
- `Fail Gate` (Final Mode) is the terminal gate — if reached, all prior gates already passed.

## 5. Quality Gates (per-stage criteria)
> Detail in `proposal-factory-quality-gates`; summary below.

| Stage | Gate Criterion |
|-------|----------------|
| [0] Config | `PIPELINE_CONFIG.yaml` parseable; mode valid; required paths exist |
| [1] State | `PROJECT_STATE.yaml` consistent with user's latest instruction; no `confirmed_decisions` re-asked |
| [2] Drawing | Drawing files parseable; HVAC layer detected; no figure confusion |
| [3] Quantity | `device_quantity.json` produced and non-empty |
| [3] Quotation | `quotation_fill_report` fill rate ≥ threshold; 10/10/5 fees present |
| [4] PPT | `slide_data` generated; >0 slides filled; manifest entries match schema |
| [5] PPT Guard | No image confusion; no device out-of-bounds; footer rules satisfied |
| [6] Cross-Val | Generic: fail gate passes. Custom: all 9 business rules pass (see `proposal-factory-business-rules` §7) |
| [7] Audit | `audit_report.md` complete; `run_manifest.json` and `PROJECT_STATE.yaml` written |
| [8] Final | `delivery_ready=true` in manifest; exit 0 |

## 6. State Recovery Guard Contract
Called from anywhere via `StateGuard(project).read_before_act(user_message)`:
| `action` returned | Meaning |
|--------------------|---------|
| `continue` | Resume from current stage |
| `restart` | Re-execute from existing state |
| `blocked` | Output `blocked_reason`; do nothing else |
| `new_project` | Create `PROJECT_STATE.yaml` then run |

Output fields: `action`, `next_stage`, `confirmed_decisions`, `open_questions`, `recovery_context_path`.

## 7. Hard Constraints (禁止行为)
After READ-BEFORE-ACT completes, the following are FORBIDDEN:
1. Asking "继续什么"
2. Re-asking any decision in `confirmed_decisions`
3. Asking for credentials / Key / Token / Bucket / Chat ID
4. Asking for prices already decided
5. Asking for template paths before a global search
6. Asking the user to convert DWG / take screenshots / find files
7. Reporting a defect without attempting a fix
8. Continuing directly from chat context (must use state files)

## 8. Cold-Start Pre-flight (mandatory)
1. Read `~/.hermes/archives/v0.5.1-release/03-frozen_rules.md`.
2. Read `~/.hermes/projects/<project>/PROJECT_STATE.yaml` if it exists.
3. Verify the release archive is present; else `BLOCKED (release_archive_missing)`.
4. New projects start as DRAFT — `can_start_final` is always `false` on a first run.

## 9. Relations
- `proposal-factory-index`
- `proposal-factory-business-rules` (the rules that [6] enforces)
- `proposal-factory-quality-gates` (acceptance criteria detail)
