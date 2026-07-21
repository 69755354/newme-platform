---
title: smart-home-index
type: note
permalink: personal/newme-os/knowledge/smart-home/smart-home-index
canonical_status: active
owner: 森哥
last_verified: 2026-07-21
volatility: medium
truth_source: Hermes knowledge base 01-design-rules + 02-projects lessons
sources:
  - /home/ubuntu/.hermes/knowledge/01-design-rules/00-index.md
  - /home/ubuntu/.hermes/knowledge/01-design-rules/knx-design-rules-consolidated.md
  - /home/ubuntu/.hermes/knowledge/01-design-rules/room-circuit-rules.md
  - /home/ubuntu/.hermes/knowledge/01-design-rules/dubai-compliance.md
  - /home/ubuntu/.hermes/knowledge/01-design-rules/knx-topology-rules.md
  - /home/ubuntu/.hermes/knowledge/01-design-rules/knx-basics.md
  - /home/ubuntu/.hermes/knowledge/01-design-rules/device-calculation-d4-d8-rules.md
  - /home/ubuntu/.hermes/knowledge/02-projects/00-cross-project-lessons.md
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

## Module Map
| # | File | Domain | Volatility |
|---|------|--------|------------|
| 1 | `smart-home-index` (this file) | Navigation + workflow | low |
| 2 | `smart-home-design-principles` | Bus topology, capacity, PSU sizing, area/line hierarchy | low |
| 3 | `smart-home-room-rules` | Room type → circuit count, dimming, special rooms | medium |
| 4 | `smart-home-device-rules` | D4–D8 device math, sensor placement, actuator selection, group addresses | medium |
| 5 | `smart-home-scene-rules` | Scene defaults, KNX Secure, DEWA, Dubai Municipal | high |
| 6 | `smart-home-project-exceptions` | Pennaz / Ibrahim / Mohit deviations; cross-project lessons | high |

## Rule Domain Status
| Domain | Source | Canonical Status |
|--------|--------|------------------|
| KNX basics | `knx-basics.md` | ✅ active |
| Topology rules | `knx-topology-rules.md` | ✅ active |
| Room-circuit mapping | `room-circuit-rules.md` | ✅ active |
| Dubai compliance | `dubai-compliance.md` | ✅ active |
| Device calc D4-D8 | `device-calculation-d4-d8-rules.md` | ✅ active |
| Sensor placement (Theben/MDT) | `knx-sensor-placement-theben-mdt.md` | ✅ active |
| Group address standards | `knx-group-address-standards.md` | ✅ active |
| UAE distributor pricing 2026 | `uae-knx-distributor-pricing-2026.md` | ⚠️ re-verify each quarter |
| DEWA 2026 electrical rules | `dewa-2026-electrical-rules.md` | ⚠️ re-verify each quarter |
| Template standards | `template-standards.md` | ✅ active |
| PPT generation rules | `ppt-generation-rules.md` | ✅ active |

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
| Parameter | Spec | Notes |
|-----------|------|-------|
| Bus type | TP1 (twisted pair) | Polarity sensitive (Red+ / Black-) |
| Max devices per line | 64 (practical 58) | Includes PSU |
| Max bus length | 1000m | Cumulative branches |
| PSU capacity | 640mA | ≤70% load recommended (≈448mA) |
| Max lines per area | 15 | incl. main line |
| Max areas | 15 | via IP backbone |
| DALI zones per gateway | 4 | 64 addresses per zone |
| Curtain actuator channels | 4 per module | — |
| Ambient temperature max | 55°C | GCC derating |

## Typical Dubai Villa Baseline (~770 sqm)
| Floor | Light Circuits | Curtain Motors | Area |
|-------|----------------|----------------|------|
| Ground Floor | 37 | 6 | ~400 sqm |
| 1st Floor | 35 | 5 | ~370 sqm |
| **Total** | **72** | **11** | **~770 sqm** |

→ ~18 × 4-channel switch actuators; ~2 DALI gateways; ~3 × 4-channel curtain actuators.

## Conflicts Policy
Where source files disagree, this knowledge base **marks conflicts explicitly** rather than silently picking one. See `smart-home-project-exceptions` for known per-project deviations.

## Read-First References
- **Bus / topology / PSU** → `smart-home-design-principles`
- **Per-room circuits** → `smart-home-room-rules`
- **Device math / sensors / actuators / group addresses** → `smart-home-device-rules`
- **Scenes / KNX Secure / DEWA / Dubai Municipal** → `smart-home-scene-rules`
- **Per-project deviations + lessons** → `smart-home-project-exceptions`
