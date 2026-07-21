---
title: smart-home-design-principles
type: note
permalink: personal/newme-os/knowledge/smart-home/smart-home-design-principles
canonical_status: active
owner: 森哥
last_verified: 2026-07-21
volatility: low
truth_source: knx-topology-rules.md + knx-basics.md (KNX Association standards)
sources:
  - /home/ubuntu/.hermes/knowledge/01-design-rules/knx-topology-rules.md
  - /home/ubuntu/.hermes/knowledge/01-design-rules/knx-basics.md
  - /home/ubuntu/.hermes/knowledge/01-design-rules/knx-design-rules-consolidated.md
relations:
  - smart-home-index
  - smart-home-device-rules
  - smart-home-scene-rules
---

# Smart Home — Design Principles (Bus, Topology, PSU)

## 1. KNX Bus — TP1 Core Parameters
| Parameter | Specification | Notes |
|-----------|---------------|-------|
| Bus type | TP1 (Twisted Pair 1) | Polarity sensitive (Red+ / Black-) |
| Max devices per line | 64 (practical max: 58 with 10% headroom) | Includes PSU itself |
| Max bus length | 1000m (all branch total) | Beyond → line coupler / repeater |
| PSU standard capacity | 640mA (ABB SV/S 30.640.5) | Standard selection |
| PSU safety margin | 70% load → 448mA → ~44 devices @10mA | Peak 85% (<1hr), NEVER >100% |
| Max length main / branch | 350m (PSU to farthest device) | — |
| Max inter-line distance | ≤1000m | Cumulative bus total |

> KNX does **not** support PL / LP / RF in NewMe deployments. TP1 only.

## 2. GCC Climate Derating (55°C Gulf region)
- PSU output derated to ~90% @55°C → effective 576mA.
- Recommended load @70% = 576 × 0.7 = 403mA → **~40 devices** (not 44).
- ALL devices must support 55°C ambient temperature.
- Approved PSU brand: ABB SV/S 30.640.5 (rated -5°C ~ +55°C).

## 3. Topology Hierarchy
```
Area ──────────── Max 15 areas
  │ (IP backbone / mainline)
Area Coupler
  │
Main Line ────── Max 15 lines / area
  │
Line Coupler ─── Provides electrical isolation
  │
Sub Line ─────── Max 64 devices / line
```

## 4. Typical Dubai Villa Topology (~770 sqm)
```
Area 1 ─── Main Line (IP Router)
  ├── LC1 ─── Sub Line 1: Ground Floor (lights+curtains+panels ≈48 devices)
  │              PSU (640mA × 70% ≈ 448mA)
  ├── LC2 ─── Sub Line 2: 1st Floor (lights+curtains+panels ≈44 devices)
  │              PSU (640mA × 70% ≈ 448mA)
  └── LC3 ─── Sub Line 3: HVAC + Security + DALI gateways + system (≈20 devices)
                 PSU (640mA × 30% ≈ 192mA)
```

**Design rule:** Divide by floor. GF and 1F each get one line. System devices (gateways, controllers) on a 3rd line.

## 5. PSU Capacity Calculation
Formula: `Total current = Σ(device current draw)`

| Device | Draw |
|--------|------|
| Smart panel (4-key) | 15–25mA |
| Touch screen (7") | 80–150mA (may need separate supply) |
| 4ch switch actuator | 8–12mA |
| 4ch dimming actuator | 12–18mA |
| Curtain actuator | 10–15mA |
| PIR sensor | 5–10mA |
| DALI gateway | 20–30mA |
| IP router | 40–60mA (usually on main line) |
| Line coupler | 10–15mA |

## 6. Line Coupler Rules
- Required between main line and each sub line.
- Provides electrical isolation (one line fault won't affect others).
- Physical address format: `Area.Line.Device` (e.g., `1.1.1`).
- Coupler itself occupies device address (sub line position 0).
- Can configure filter tables to reduce cross-line traffic.

## 7. IP Router & Backbone (projects >225 devices or >15 lines)
- Each area needs 1 IP router connecting main line to IP network.
- IP tunnel: used for ETS programming and visualization.
- Multicast: KNX IP uses UDP multicast (`224.0.23.12`, port `3671`).
- Network: Enable IGMP Snooping on switches.

## 8. Line / Area Hierarchy — Hard Limits
| Limit | Value |
|-------|-------|
| Devices per sub line | 64 (practical 58) |
| Sub lines per area (incl. main line) | 15 |
| Areas | 15 |
| Bus length (cumulative) | 1000m |
| Main / branch length (PSU → farthest) | 350m |
| DALI zones per gateway | 4 |
| DALI addresses per zone | 64 |
| Curtain actuator channels per module | 4 |

## 9. Design Discipline
- Divide KNX lines by floor. GF / 1F / SF each their own line.
- System devices (gateways, IP router, controllers) on a dedicated line.
- PSU count = lines; size per GCC derating rules above.
- DALI gateway count = ceil(total DALI addresses / 64 / 4 gateway zones).
- Curtain actuator count = ceil(total curtain motors / 4).

## 10. Relations
- `smart-home-index` — entry point
- `smart-home-device-rules` — per-device math, sensors, actuators
- `smart-home-scene-rules` — scenes riding on this topology
