---
title: smart-home-index
type: note
permalink: personal/newme-os/knowledge/smart-home/smart-home-index
canonical_status: active
owner: 森哥
last_verified: 2026-07-21
volatility: medium
truth_source: Hermes knowledge base 01-design-rules + 02-projects lessons
source_paths:
  - /home/ubuntu/.hermes/knowledge/01-design-rules/00-index.md
  - /home/ubuntu/.hermes/knowledge/01-design-rules/knx-design-rules-consolidated.md
  - /home/ubuntu/.hermes/knowledge/01-design-rules/room-circuit-rules.md
  - /home/ubuntu/.hermes/knowledge/01-design-rules/dubai-compliance.md
  - /home/ubuntu/.hermes/knowledge/01-design-rules/knx-topology-rules.md
  - /home/ubuntu/.hermes/knowledge/01-design-rules/knx-basics.md
  - /home/ubuntu/.hermes/knowledge/01-design-rules/device-calculation-d4-d8-rules.md
  - /home/ubuntu/.hermes/knowledge/02-projects/00-cross-project-lessons.md
knowledge_class: mixed (see per-rule classification in each module)
verification_status: partial
supersedes: migration-output/smart-home-index.md (pre-classification version)
relations:
  - smart-home-design-principles
  - smart-home-room-rules
  - smart-home-device-rules
  - smart-home-scene-rules
  - smart-home-project-exceptions
  - proposal-factory-index
---

# Smart Home Design Rules — Index

> **Core principle:** 安全、合规、可靠、可维护 (Safe / Compliant / Reliable / Maintainable).
> Target market: UAE luxury villas, 300–1000 sqm.

> **Classification note (2026-07-21):** Every rule in this knowledge base now carries a `knowledge_class` tag and a `verification_status`. The previous version asserted many rules as fact without source attribution. The current version distinguishes industry standards (cite KNX/IEC), company policy (cite NewMe decision), product-specific limits (cite datasheet model), regulatory mandates (cite DEWA / Dubai Municipality / Civil Defence), project exceptions, and working assumptions.

## Classification Legend

Every rule/claim in this knowledge base is tagged with one of the following `knowledge_class` values. The tag appears inline as `[KC: <class> | src: <source> | v: <verification_status>]`.

| Class | Meaning | Required Citation |
|-------|---------|-------------------|
| `industry_standard` | KNX Association, IEC, ISO standard | Standard body + chapter/version |
| `company_standard` | NewMe internal policy/decision | Who decided + when |
| `product_specific` | Tied to a specific model/vendor | Model number + datasheet chapter |
| `project_exception` | Deviation for a named project | Project + date + decider |
| `regulatory_requirement` | DEWA, Dubai Municipality, Civil Defence mandate | Regulation document + section + version |
| `working_assumption` | Reasonable default, NOT verified against primary source | None — flagged as unverified |

`verification_status`: `verified` (primary source checked) · `partial` (some sources checked) · `unverified` (no primary source).

> **Iron rules (apply across all modules):**
> 1. NEVER write "mandatory" / "必须" without a regulation citation (`regulatory_requirement`).
> 2. Fire / life-safety: **KNX is NOT the primary life-safety system.** Fire alarm and Civil Defence systems remain independent primary systems. KNX may interface with them but does not assume their responsibility.
> 3. Any rule without a citable primary source MUST be tagged `working_assumption` + `verification_status: unverified`.

## Module Map
| # | File | Domain | Volatility | knowledge_class (dominant) |
|---|------|--------|------------|----------------------------|
| 1 | `smart-home-index` (this file) | Navigation + workflow | low | mixed |
| 2 | `smart-home-design-principles` | Bus topology, capacity, PSU sizing, area/line hierarchy | low | industry_standard + company_standard |
| 3 | `smart-home-room-rules` | Room type → circuit count, dimming, special rooms | medium | company_standard (with project_exception overrides) |
| 4 | `smart-home-device-rules` | D4–D8 device math, sensor placement, actuator selection, group addresses | medium | industry_standard + product_specific + company_standard |
| 5 | `smart-home-scene-rules` | Scene defaults, KNX Secure, DEWA, Dubai Municipal | high | company_standard + regulatory_requirement + working_assumption |
| 6 | `smart-home-project-exceptions` | Pennaz / Ibrahim / Mohit deviations; cross-project lessons | high | project_exception + company_standard |

## Rule Domain Status
| Domain | Source | Canonical Status | knowledge_class |
|--------|--------|------------------|-----------------|
| KNX basics | `knx-basics.md` | ✅ active | industry_standard (cite KNX Association) |
| Topology rules | `knx-topology-rules.md` | ✅ active | industry_standard (KNX spec) |
| Room-circuit mapping | `room-circuit-rules.md` | ✅ active | company_standard (NewMe design baseline) |
| Dubai compliance | `dubai-compliance.md` | ✅ active | regulatory_requirement (cite regulation) or working_assumption |
| Device calc D4-D8 | `device-calculation-d4-d8-rules.md` | ✅ active | company_standard (D4/D8 framework) + industry_standard (KNX device math) |
| Sensor placement (Theben/MDT) | `knx-sensor-placement-theben-mdt.md` | ✅ active | product_specific (cite datasheet) |
| Group address standards | `knx-group-address-standards.md` | ✅ active | industry_standard (KNX Association 3-layer scheme) |
| UAE distributor pricing 2026 | `uae-knx-distributor-pricing-2026.md` | ⚠️ re-verify each quarter | working_assumption (volatile) |
| DEWA 2026 electrical rules | `dewa-2026-electrical-rules.md` | ⚠️ re-verify each quarter | regulatory_requirement (cite DEWA doc) |
| Template standards | `template-standards.md` | ✅ active | company_standard |
| PPT generation rules | `ppt-generation-rules.md` | ✅ active | company_standard |

## Design Workflow
```
CAD 建筑图  →  房间划分 & 回路规划  →  KNX 拓扑设计  →  BOQ 物料清单  →  成本估算  →  PPT 汇报  →  交叉校验 QC  →  交付
```
| Stage | Authoritative File |
|-------|---------------------|
| CAD analysis | `smart-home-device-rules` (PDF text layer > Vision) |
| Room division / circuit planning | `smart-home-room-rules` |
| KNX topology design | `smart-home-design-principles` |
| Compliance review | `smart-home-scene-rules` (DEWA + Dubai Municipal) |
| BOQ + cost | `proposal-factory-pricing-rules` |
| Deliverable generation | `proposal-factory-pipeline` |
| Cross-check QC | `proposal-factory-quality-gates` |

## Core Parameters Quick Reference
> Each row below carries its `knowledge_class`. Values previously stated as fact are now attributed.

| Parameter | Spec | knowledge_class | source / citation | verification_status |
|-----------|------|-----------------|-------------------|---------------------|
| Bus type | TP1 (twisted pair), polarity sensitive | `company_standard` | NewMe standardisation decision (TP1-only) — 森哥 | partial |
| Max devices per line | 64 | `industry_standard` | KNX Association, KNX System Specifications, line device limit | verified |
| Practical devices per line | 58 (≈10% headroom) | `working_assumption` | NewMe engineering headroom, not in KNX spec | unverified |
| Max bus length | 1000m (cumulative branches) | `industry_standard` | KNX TP1 specification | verified |
| PSU capacity | 640mA (ABB SV/S 30.640.5) | `product_specific` | ABB datasheet, SV/S 30.640.5 | partial |
| PSU recommended load | ≤70% (≈448mA) | `company_standard` | NewMe engineering margin (de-rating policy) | unverified |
| Max lines per area | 15 (incl. main line) | `industry_standard` | KNX System Specifications, area/line hierarchy | verified |
| Max areas | 15 (via IP backbone) | `industry_standard` | KNX System Specifications, area/line hierarchy | verified |
| DALI zones per gateway | 4 | `product_specific` | Depends on gateway model — see `smart-home-device-rules` §1.2 | unverified |
| DALI addresses per zone | 64 | `industry_standard` | IEC 62386 (DALI) part 102 | verified |
| Curtain actuator channels | 4 per module | `product_specific` | Common 4-ch module; verify per vendor datasheet | partial |
| Ambient temperature max | 55°C (GCC derating) | `company_standard` | NewMe GCC climate requirement | partial |

## Typical Dubai Villa Baseline (~770 sqm)
| Floor | Light Circuits | Curtain Motors | Area |
|-------|----------------|----------------|------|
| Ground Floor | 37 | 6 | ~400 sqm |
| 1st Floor | 35 | 5 | ~370 sqm |
| **Total** | **72** | **11** | **~770 sqm** |

→ ~18 × 4-channel switch actuators; ~2 DALI gateways (see `smart-home-device-rules` §1.2 — gateway count is driven by engineering margin, not protocol capacity); ~3 × 4-channel curtain actuators.

> The 770 sqm baseline and its circuit counts are `company_standard` (NewMe design baseline for UAE luxury villas, `verification_status: partial`).

## Conflicts Policy
Where source files disagree, this knowledge base **marks conflicts explicitly** rather than silently picking one. See `smart-home-project-exceptions` for known per-project deviations. Conflicting claims are tagged `canonical_status: disputed` at the file/claim level until a primary source resolves them.

## Read-First References
- **Bus / topology / PSU** → `smart-home-design-principles`
- **Per-room circuits** → `smart-home-room-rules`
- **Device math / sensors / actuators / group addresses** → `smart-home-device-rules`
- **Scenes / KNX Secure / DEWA / Dubai Municipal** → `smart-home-scene-rules`
- **Per-project deviations + lessons** → `smart-home-project-exceptions`
