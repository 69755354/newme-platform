---
title: smart-home-device-rules
type: note
permalink: personal/newme-os/knowledge/smart-home/smart-home-device-rules
canonical_status: active
owner: 森哥
last_verified: 2026-07-21
volatility: medium
truth_source: device-calculation-d4-d8-rules.md + knx-sensor-placement-theben-mdt.md + knx-group-address-standards.md
source_paths:
  - /home/ubuntu/.hermes/knowledge/01-design-rules/device-calculation-d4-d8-rules.md
  - /home/ubuntu/.hermes/knowledge/01-design-rules/knx-sensor-placement-theben-mdt.md
  - /home/ubuntu/.hermes/knowledge/01-design-rules/knx-group-address-standards.md
  - /home/ubuntu/.hermes/knowledge/01-design-rules/knx-design-rules-consolidated.md
knowledge_class: mixed (industry_standard for DALI protocol & group addresses; product_specific for vendor models; company_standard for D4/D8 framework & engineering margins)
verification_status: partial
supersedes: migration-output/smart-home-device-rules.md (pre-classification version, contained DALI formula contradiction)
relations:
  - smart-home-index
  - smart-home-design-principles
  - smart-home-room-rules
---

# Smart Home — Device Rules

> Covers D4–D8 device math, sensor placement (Theben/MDT), actuator selection, and group address standards.
> Counting rule (`company_standard`, Pennaz V3 post-mortem 2026-06-11): **PDF text-layer count is truth. Vision/visual count is advisory only.**

> **Critical fix (2026-07-21):** The previous version of §1.2 stated a DALI gateway formula `ceil(total addresses / 64 / 4)` and then claimed "72 addresses typically needs 2 gateways" — a contradiction (the formula would yield 1 gateway). This version separates four distinct concerns that were previously conflated: protocol capacity, gateway capacity, engineering margin, and project selection. See §1.2.

## 1. Device Calculation — D4 / D8 Rules
> Source: `device-calculation-d4-d8-rules.md`. The D4/D8 framework itself is `company_standard` (NewMe internal convention, owner 森哥). It maps room-level circuit counts (from `smart-home-room-rules`) into BOQ device counts.

### 1.1 D4 — 4-channel module sizing (`company_standard`)
> The 4-channel packing rule and channel-count assumption are NewMe conventions; verify each actuator model's actual channel count against its datasheet (`product_specific`).

| Input | Formula | knowledge_class |
|-------|---------|-----------------|
| 4-channel switch actuators | `ceil(total light circuits / 4)` | `company_standard` (4-ch packing) over `product_specific` (module channel count) |
| 4-channel curtain actuators | `ceil(total curtain motors / 4)` | `company_standard` |
| 4-channel dim actuators (DALI gateways alternative) | per project | `project_exception` |

**Example (~770 sqm baseline, `working_assumption`):**
- 72 light circuits → `ceil(72/4)` = **18 × 4-channel switch actuators**
- 11 curtain motors → `ceil(11/4)` = **3 × 4-channel curtain actuators**

### 1.2 D8 — DALI gateway sizing (CONTRADICTION RESOLVED)

> The previous version conflated four different concepts into one formula. They are now separated. **Do not quote `ceil(addresses / 64 / 4)` as the NewMe gateway-sizing rule — that formula describes protocol capacity only.**

#### (a) Protocol capacity — `industry_standard` · `verification_status: verified`
Per **IEC 62386 (DALI) part 102** and part 207 (DT8 control gear):
- A DALI **sub-line (zone)** addresses up to **64 short addresses** (0–63).
- Number of zones per gateway is **NOT defined by the DALI standard** — it is gateway-product dependent. The figure "4 zones per gateway" sometimes quoted is a typical product capability, not protocol capability.
- Theoretical max addresses per gateway = `64 × zones_supported_by_that_gateway_model`.

> The formula `ceil(total_addresses / 64 / 4)` therefore encodes two distinct things: `/64` is `industry_standard` (IEC 62386) and `/4` is `product_specific` (assumes a 4-zone gateway). They must not be presented as one industry-standard formula.

#### (b) Gateway capacity — `product_specific` · `verification_status: unverified`
The actual number of zones, addresses, and total bus power a gateway supports depends on the **specific gateway model**.

| Field | Required value | Status |
|-------|----------------|--------|
| Gateway model | **TBD — NewMe must nominate the standard gateway SKU** | unverified |
| Zones per gateway (per its datasheet) | TBD | unverified |
| Addresses per zone | 64 (per IEC 62386) | verified |
| Max bus power output | TBD | unverified |

> Until a model is nominated and its datasheet cited here, **every claim that depends on "4 zones per gateway" must be tagged `product_specific` + `verification_status: unverified`**.

#### (c) Engineering margin — `company_standard` (owner 森哥) · `verification_status: partial`
NewMe splits DALI zones by **physical topology (floor / room)** to keep cable runs short and to isolate fault domains. This margin is **independent of protocol capacity**. It is the reason a 72-address project typically resolves to **2 gateways** even though a single 4-zone × 64-address gateway could theoretically hold all 72 addresses.

Concrete example (~770 sqm villa, 72 DALI addresses):
- Ground Floor ≈ 37 addresses → 1 gateway (GF zones)
- First Floor ≈ 35 addresses → 1 gateway (FF zones)
- Total = **2 gateways**, driven by floor segmentation, not by `ceil(72/256)`.

> **Do not** describe this as "protocol requires 2 gateways". Describe it as "NewMe engineering topology requires 2 gateways for this villa".

#### (d) Project selection — `working_assumption` · `verification_status: unverified`
For new projects, the **default assumption** is one DALI gateway per floor unless `PROJECT_STATE.yaml.confirmed_decisions` records otherwise. This default is a `working_assumption` until a gateway model and zone plan are confirmed for the specific project.

| DALI concept | Value | knowledge_class | source | verification_status |
|--------------|-------|-----------------|--------|---------------------|
| Addresses per DALI zone | 64 | `industry_standard` | IEC 62386-102 | verified |
| Zones per gateway | "4" often quoted | `product_specific` | Gateway-model dependent (model TBD) | unverified |
| Gateway count for 72 addresses | 2 | `company_standard` | NewMe floor-segmentation engineering margin | partial |
| Default new-project assumption | 1 gateway per floor | `working_assumption` | NewMe default; confirm per project | unverified |

### 1.3 PSU count (derived from line count) (`company_standard`)
- 1 PSU per KNX line (see `smart-home-design-principles` §5).
- Typical ~770 sqm villa: 3 lines → 3 × ABB SV/S 30.640.5 (`product_specific`).

### 1.4 Touch screen separate supply (`company_standard`)
- 7" touch panels draw 80–150mA each. `⟨product_specific · per vendor datasheet · partial⟩`
- If a line includes touch screens, sum their draw separately; may need dedicated PSU or higher-capacity PSU.

## 2. Sensor Placement (Theben / MDT official guidelines)
> Source: `knx-sensor-placement-theben-mdt.md`. Theben and MDT placement patterns below are `product_specific` — each pattern must cite the vendor's installation guide. Where the citation is missing or unverified, the rule is tagged accordingly.

| Zone | Sensor | Pattern | knowledge_class | source / citation | verification_status |
|------|--------|---------|-----------------|-------------------|---------------------|
| Corridor | Theben RAMSES | "5×30m" pattern (one RAMSES every ~5m or every 30m²) | `product_specific` | Theben RAMSES datasheet / installation guide — **chapter not yet cited** | unverified |
| Wet zones (bath, spa, outdoor) | IP54-rated sensor | All panels IP65; sensor IP54 minimum | `working_assumption` | IP-rating convention; regulation cite TBD | unverified |
| Living / bedroom | MDT or Theben PIR | One per primary entry axis; do NOT place facing window (false triggers) | `company_standard` | NewMe placement convention | partial |
| Outdoor | IP65 PIR | Shaded position; avoid direct sun | `company_standard` | NewMe placement convention | partial |

> **Action item (Theben RAMSES):** the "5×30m" pattern must cite the specific Theben RAMSES installation-guide chapter/section. Until cited, treat as `working_assumption`. The previous "verify exact spec" hedge is reclassified from a TODO aside to `verification_status: unverified`.

### Sensor selection matrix (Theben vs MDT)
| Brand | Strength | Notes | knowledge_class |
|-------|----------|-------|-----------------|
| Theben | RAMSES corridor pattern; precise timing | Premium default | `company_standard` (NewMe default), `product_specific` (RAMSES pattern) |
| MDT | Cost-effective; reliable presence detection | Mid-tier value engineering | `company_standard` (value-engineering option) |

## 3. Actuator Selection Criteria
> Selection criteria table is `company_standard` (NewMe selection heuristics). Each "Selected Actuator" cell's channel count is `product_specific` (verify per vendor).

| Need | Selected Actuator | Channel Count | knowledge_class |
|------|-------------------|---------------|-----------------|
| On/off lighting | Switch actuator | 4-ch (or 8-ch for high-density floors) | `company_standard` / `product_specific` |
| Dimmable lighting (DALI) | DALI gateway | 4-zone, 64-addr each | `product_specific` (zones) / `industry_standard` (64 addr) |
| Curtains | Curtain actuator | 4-ch | `company_standard` |
| HVAC (CoolMaster) | CoolMaster / KNX-IP gateway | count matches HVAC drawing | `company_standard` (custom-mode rule 1) |
| Shading / screens | Shading actuator | per motor count | `company_standard` |

### Hard rules
- **CoolMaster count must equal HVAC drawing count** — `company_standard` (custom-mode engineering rule 1, see `proposal-factory-business-rules` §7).
- **Double-curtain projects (Pennaz)**: curtain motor count = 2 × window count — `project_exception` (Pennaz, 2026-06) / `company_standard` (custom-mode rule 2).

## 4. Group Address Standards (KNX Association 3-layer scheme)
> Source: `knx-group-address-standards.md`. The 3-layer scheme is `industry_standard` (KNX Association). The main-group numbering table below is `company_standard` (NewMe project convention).

### 4.1 Three-layer group address format (`industry_standard`)
`<Main Group>.<Middle Group>.<Sub Group>` — e.g. `1.1.3`

| Main Group | Domain | knowledge_class |
|------------|--------|-----------------|
| 1 | Lighting | `company_standard` (NewMe numbering) |
| 2 | Shading / Curtains | `company_standard` |
| 3 | HVAC | `company_standard` |
| 4 | Scenes | `company_standard` |
| 5 | Visualization / Status | `company_standard` |
| 6 | DALI | `company_standard` |
| 7 | Security / Civil Defence | `company_standard` |
| ... | (extend per project) | `project_exception` |

### 4.2 Physical address format (`industry_standard`)
`Area.Line.Device` — e.g. `1.1.1`
- Area: 1–15 `⟨industry_standard · KNX System Spec · verified⟩`
- Line: 1–15 `⟨industry_standard · KNX System Spec · verified⟩`
- Device: 1–64 (0 reserved for line coupler) `⟨industry_standard · KNX System Spec · verified⟩`

### 4.3 ETS project organization (`company_standard`)
- One ETS project per villa. `⟨company_standard · NewMe convention · partial⟩`
- Filter tables on line couplers to suppress cross-line broadcast spam. `⟨company_standard · NewMe ETS practice · unverified⟩`
- Bus load monitoring enabled; alert if any line approaches 70% load. `⟨company_standard · NewMe 70% policy · unverified⟩`

## 5. Device Counting — Source of Truth Discipline (`company_standard`, Pennaz V3 post-mortem 2026-06-11)
| Source | Reliability | knowledge_class |
|--------|-------------|-----------------|
| PDF text layer (`pg.get_text("words")` with coords) | **Truth** — use this | `company_standard` (post-mortem policy) |
| Vision (image-based counting) | Advisory only; known to disagree with PDF text layer | `company_standard` |
| Manual / chat-context recall | Forbidden — must come from state files | `company_standard` |

> Pennaz V3 lesson (2026-06-11): Vision counts disagreed with PDF text layer; PDF was correct. Classification: `company_standard` (post-mortem policy).

## 6. Relations
- `smart-home-index`
- `smart-home-design-principles` (PSU / line count feeds back here)
- `smart-home-room-rules` (room → circuit count input for D4)
- `proposal-factory-business-rules` (custom-mode rules 1 & 2 enforce CoolMaster and curtain counts)
