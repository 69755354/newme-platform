---
title: smart-home-design-principles
type: note
permalink: personal/newme-os/knowledge/smart-home/smart-home-design-principles
canonical_status: active
owner: 森哥
last_verified: 2026-07-21
volatility: low
truth_source: knx-topology-rules.md + knx-basics.md (KNX Association standards)
source_paths:
  - /home/ubuntu/.hermes/knowledge/01-design-rules/knx-topology-rules.md
  - /home/ubuntu/.hermes/knowledge/01-design-rules/knx-basics.md
  - /home/ubuntu/.hermes/knowledge/01-design-rules/knx-design-rules-consolidated.md
knowledge_class: mixed (industry_standard for KNX spec limits; company_standard for NewMe engineering margins)
verification_status: partial
supersedes: migration-output/smart-home-design-principles.md (pre-classification version)
relations:
  - smart-home-index
  - smart-home-device-rules
  - smart-home-scene-rules
---

# Smart Home — Design Principles (Bus, Topology, PSU)

> **Classification note (2026-07-21):** The previous version asserted "KNX does not support PL/LP/RF" as a factual claim. KNX *does* support PL (Powerline), LP, and RF media per KNX Association specifications; **NewMe chooses TP1 only** as a `company_standard`. Each numeric limit below now distinguishes the KNX-spec value (`industry_standard`) from NewMe's engineering headroom (`working_assumption` / `company_standard`).

## 1. KNX Bus — TP1 Core Parameters
| Parameter | Specification | knowledge_class | source / citation | verification_status |
|-----------|---------------|-----------------|-------------------|---------------------|
| Bus type | TP1 (Twisted Pair 1), polarity sensitive (Red+ / Black-) | `industry_standard` | KNX Association, TP1 physical layer spec | verified |
| Max devices per line | 64 | `industry_standard` | KNX System Specifications (line device address limit 0–63, address 0 reserved for coupler) | verified |
| Practical devices per line | 58 (~10% headroom) | `working_assumption` | NewMe engineering margin; not in KNX spec | unverified |
| Max bus length | 1000m (all branch total) | `industry_standard` | KNX TP1 specification | verified |
| Max length main / branch | 350m (PSU to farthest device) | `working_assumption` | Common industry practice; verify against KNX spec | unverified |
| Max inter-line distance | ≤1000m cumulative | `industry_standard` | KNX TP1 specification | verified |
| PSU standard capacity | 640mA (ABB SV/S 30.640.5) | `product_specific` | ABB SV/S 30.640.5 datasheet | partial |
| PSU safety margin | 70% load → 448mA → ~44 devices @10mA | `company_standard` | NewMe derating policy (peak 85% <1hr, never >100%) | unverified |

> **NewMe media selection (company_standard):** NewMe deploys **TP1 only**. KNX as a standard also defines PL (Powerline), RF, and IP media; NewMe does not deploy these in smart-home projects. This is a NewMe policy decision (owner: 森哥), not a KNX limitation. Previous wording claiming "KNX does not support PL/LP/RF" was incorrect and is superseded.

## 2. GCC Climate Derating (55°C Gulf region)
- PSU output derated to ~90% @55°C → effective 576mA. `⟨working_assumption · vendor derating curve not cited · unverified⟩`
- Recommended load @70% = 576 × 0.7 = 403mA → **~40 devices** (not 44). `⟨company_standard · NewMe derating policy · unverified⟩`
- ALL devices must support 55°C ambient temperature. `⟨company_standard · NewMe GCC climate requirement · partial⟩`
- Approved PSU brand: ABB SV/S 30.640.5 (rated -5°C ~ +55°C). `⟨product_specific · ABB datasheet · partial⟩`

## 3. Topology Hierarchy
```
Area ──────────── Max 15 areas        [industry_standard · KNX System Spec · verified]
  │ (IP backbone / mainline)
Area Coupler
  │
Main Line ────── Max 15 lines / area  [industry_standard · KNX System Spec · verified]
  │
Line Coupler ─── Provides electrical isolation
  │
Sub Line ─────── Max 64 devices / line [industry_standard · KNX System Spec · verified]
```

## 4. Typical Dubai Villa Topology (~770 sqm)
> This topology example is `company_standard` (NewMe design convention). The numerical device loads per sub-line are `working_assumption` (illustrative, not measured).

```
Area 1 ─── Main Line (IP Router)
  ├── LC1 ─── Sub Line 1: Ground Floor (lights+curtains+panels ≈48 devices)
  │              PSU (640mA × 70% ≈ 448mA)
  ├── LC2 ─── Sub Line 2: 1st Floor (lights+curtains+panels ≈44 devices)
  │              PSU (640mA × 70% ≈ 448mA)
  └── LC3 ─── Sub Line 3: HVAC + Security + DALI gateways + system (≈20 devices)
                 PSU (640mA × 30% ≈ 192mA)
```

**Design rule (`company_standard`, owner 森哥):** Divide by floor. GF and 1F each get one line. System devices (gateways, controllers) on a 3rd line.

## 5. PSU Capacity Calculation
> Formula: `Total current = Σ(device current draw)` — `industry_standard` (Ohm's law / bus power budget). The per-device draw values below are `working_assumption` (typical ranges, not cited against a verified device registry).

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
> KNX System Specifications (`industry_standard`):
- Required between main line and each sub line.
- Provides electrical isolation (one line fault won't affect others).
- Physical address format: `Area.Line.Device` (e.g., `1.1.1`).
- Coupler itself occupies device address (sub line position 0).
- Filter tables can be configured to reduce cross-line traffic. `⟨company_standard · NewMe ETS convention · unverified⟩`

## 7. IP Router & Backbone (projects >225 devices or >15 lines)
> Trigger threshold ">225 devices or >15 lines" is `working_assumption` (NewMe rule of thumb, not in KNX spec).
- Each area needs 1 IP router connecting main line to IP network. `⟨industry_standard · KNX IP spec · verified⟩`
- IP tunnel: used for ETS programming and visualization. `⟨industry_standard · KNX IP · verified⟩`
- Multicast: KNX IP uses UDP multicast (`224.0.23.12`, port `3671`). `⟨industry_standard · KNX IP spec · verified⟩`
- Network: Enable IGMP Snooping on switches. `⟨company_standard · NewMe network practice · unverified⟩`

## 8. Line / Area Hierarchy — Hard Limits
| Limit | Value | knowledge_class | source | verification_status |
|-------|-------|-----------------|--------|---------------------|
| Devices per sub line | 64 | `industry_standard` | KNX System Specifications | verified |
| Practical devices per line | 58 (10% headroom) | `working_assumption` | NewMe engineering margin | unverified |
| Sub lines per area (incl. main line) | 15 | `industry_standard` | KNX System Specifications | verified |
| Areas | 15 | `industry_standard` | KNX System Specifications | verified |
| Bus length (cumulative) | 1000m | `industry_standard` | KNX TP1 spec | verified |
| Main / branch length (PSU → farthest) | 350m | `working_assumption` | Common practice | unverified |
| DALI zones per gateway | 4 | `product_specific` | Gateway-model dependent — see `smart-home-device-rules` §1.2 | unverified |
| DALI addresses per zone | 64 | `industry_standard` | IEC 62386 part 102 | verified |
| Curtain actuator channels per module | 4 | `product_specific` | Common 4-ch module; verify per vendor | partial |

## 9. Design Discipline
> The discipline rules below are `company_standard` (NewMe design conventions) unless otherwise marked:
- Divide KNX lines by floor. GF / 1F / SF each their own line.
- System devices (gateways, IP router, controllers) on a dedicated line.
- PSU count = lines; size per GCC derating rules above.
- DALI gateway count = driven by **engineering margin** (`company_standard`, see `smart-home-device-rules` §1.2). The formula `ceil(total DALI addresses / 64 / 4)` describes protocol capacity only and is **not** the NewMe gateway-sizing rule.
- Curtain actuator count = `ceil(total curtain motors / 4)`. `⟨company_standard · NewMe 4-ch packing rule · unverified⟩`

## 10. Relations
- `smart-home-index` — entry point
- `smart-home-device-rules` — per-device math, sensors, actuators (DALI gateway sizing canonical there)
- `smart-home-scene-rules` — scenes riding on this topology
