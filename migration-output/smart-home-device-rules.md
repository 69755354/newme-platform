---
title: smart-home-device-rules
type: note
permalink: personal/newme-os/knowledge/smart-home/smart-home-device-rules
canonical_status: active
owner: 森哥
last_verified: 2026-07-21
volatility: medium
truth_source: device-calculation-d4-d8-rules.md + knx-sensor-placement-theben-mdt.md + knx-group-address-standards.md
sources:
  - /home/ubuntu/.hermes/knowledge/01-design-rules/device-calculation-d4-d8-rules.md
  - /home/ubuntu/.hermes/knowledge/01-design-rules/knx-sensor-placement-theben-mdt.md
  - /home/ubuntu/.hermes/knowledge/01-design-rules/knx-group-address-standards.md
  - /home/ubuntu/.hermes/knowledge/01-design-rules/knx-design-rules-consolidated.md
relations:
  - smart-home-index
  - smart-home-design-principles
  - smart-home-room-rules
---

# Smart Home — Device Rules

> Covers D4–D8 device math, sensor placement (Theben/MDT), actuator selection, and group address standards.
> Counting rule: **PDF text-layer count is truth. Vision/visual count is advisory only.** (Pennaz V3 lesson.)

## 1. Device Calculation — D4 / D8 Rules
> Source: `device-calculation-d4-d8-rules.md`. The D4/D8 framework maps room-level circuit counts (from `smart-home-room-rules`) into BOQ device counts.

### 1.1 D4 — 4-channel module sizing
| Input | Formula |
|-------|---------|
| 4-channel switch actuators | `ceil(total light circuits / 4)` |
| 4-channel curtain actuators | `ceil(total curtain motors / 4)` |
| 4-channel dim actuators (DALI gateways alternative) | per project |

**Example (~770 sqm baseline):**
- 72 light circuits → `ceil(72/4)` = **18 × 4-channel switch actuators**
- 11 curtain motors → `ceil(11/4)` = **3 × 4-channel curtain actuators**

### 1.2 D8 — DALI gateway sizing
| Input | Formula |
|-------|---------|
| DALI addresses needed | = total dimming-capable luminaires |
| DALI zones per gateway | 4 |
| DALI addresses per zone | 64 |
| DALI gateways | `ceil(total DALI addresses / 64 / 4)` |

**Example (72 DALI addresses):**
- `ceil(72 / 64 / 4)` → 1 gateway sufficient for 72 addresses within 4 zones of 64 each, but real-world zoning by room/floor typically requires **2 DALI gateways** for clean segmentation.

### 1.3 PSU count (derived from line count)
- 1 PSU per KNX line (see `smart-home-design-principles` §5).
- Typical ~770 sqm villa: 3 lines → 3 × ABB SV/S 30.640.5.

### 1.4 Touch screen separate supply
- 7" touch panels draw 80–150mA each.
- If a line includes touch screens, sum their draw separately; may need dedicated PSU or higher-capacity PSU.

## 2. Sensor Placement (Theben / MDT official guidelines)
> Source: `knx-sensor-placement-theben-mdt.md`.

| Zone | Sensor | Pattern |
|------|--------|---------|
| Corridor | Theben RAMSES | 5×30m pattern (one RAMSES every ~5m or every 30m² — verify exact spec) |
| Wet zones (bath, spa, outdoor) | IP54-rated sensor | All panels IP65; sensor IP54 minimum |
| Living / bedroom | MDT or Theben PIR | One per primary entry axis; do NOT place directly facing window (false triggers) |
| Outdoor | IP65 PIR | Shaded position; avoid direct sun |

### Sensor selection matrix (Theben vs MDT)
| Brand | Strength | Notes |
|-------|----------|-------|
| Theben | RAMSES corridor pattern; precise timing | Premium default |
| MDT | Cost-effective; reliable presence detection | Mid-tier value engineering |

## 3. Actuator Selection Criteria
| Need | Selected Actuator | Channel Count |
|------|-------------------|---------------|
| On/off lighting | Switch actuator | 4-ch (or 8-ch for high-density floors) |
| Dimmable lighting (DALI) | DALI gateway | 4-zone, 64-addr each |
| Curtains | Curtain actuator | 4-ch |
| HVAC (CoolMaster) | CoolMaster / KNX-IP gateway | count matches HVAC drawing (custom-mode rule 1) |
| Shading / screens | Shading actuator | per motor count |

### Hard rules
- **CoolMaster count must equal HVAC drawing count** (custom-mode engineering rule 1 — see `proposal-factory-business-rules` §7).
- **Double-curtain projects (Pennaz)**: curtain motor count = 2 × window count (custom-mode rule 2).

## 4. Group Address Standards (KNX Association 3-layer scheme)
> Source: `knx-group-address-standards.md`.

### 4.1 Three-layer group address format
`<Main Group>.<Middle Group>.<Sub Group>` — e.g. `1.1.3`

| Main Group | Domain |
|------------|--------|
| 1 | Lighting |
| 2 | Shading / Curtains |
| 3 | HVAC |
| 4 | Scenes |
| 5 | Visualization / Status |
| 6 | DALI |
| 7 | Security / Civil Defence |
| ... | (extend per project) |

### 4.2 Physical address format
`Area.Line.Device` — e.g. `1.1.1`
- Area: 1–15
- Line: 1–15
- Device: 1–64 (0 reserved for line coupler)

### 4.3 ETS project organization
- One ETS project per villa.
- Filter tables on line couplers to suppress cross-line broadcast spam.
- Bus load monitoring enabled; alert if any line approaches 70% load.

## 5. Device Counting — Source of Truth Discipline
| Source | Reliability |
|--------|-------------|
| PDF text layer (`pg.get_text("words")` with coords) | **Truth** — use this |
| Vision (image-based counting) | Advisory only; known to disagree with PDF text layer |
| Manual / chat-context recall | Forbidden — must come from state files |

> Pennaz V3 lesson: Vision counts disagreed with PDF text layer; PDF was correct.

## 6. Relations
- `smart-home-index`
- `smart-home-design-principles` (PSU / line count feeds back here)
- `smart-home-room-rules` (room → circuit count input for D4)
- `proposal-factory-business-rules` (custom-mode rules 1 & 2 enforce CoolMaster and curtain counts)
