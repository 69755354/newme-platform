---
title: smart-home-room-rules
type: note
permalink: personal/newme-os/knowledge/smart-home/smart-home-room-rules
canonical_status: active
owner: 森哥
last_verified: 2026-07-21
volatility: medium
truth_source: room-circuit-rules.md (NewMe design standard, UAE villas)
source_paths:
  - /home/ubuntu/.hermes/knowledge/01-design-rules/room-circuit-rules.md
  - /home/ubuntu/.hermes/knowledge/01-design-rules/knx-design-rules-consolidated.md
knowledge_class: company_standard (NewMe design baseline; not KNX Association requirements)
verification_status: partial
supersedes: migration-output/smart-home-room-rules.md (pre-classification version, dimming rules asserted as "MANDATORY" without policy attribution)
relations:
  - smart-home-index
  - smart-home-design-principles
  - smart-home-project-exceptions
---

# Smart Home — Room / Circuit Mapping Rules

> Drives BOQ row count, actuator selection, and DALI gateway sizing.
> Conflicts with project-specific deviations → see `smart-home-project-exceptions`. Do **not** silently override the table below.

> **Classification note (2026-07-21):** This entire table is the **NewMe design baseline** — `company_standard`, owner 森哥. It is **not** a KNX Association requirement and **not** a regulatory mandate. The word "MANDATORY" in the original version referred to NewMe's internal design policy for UAE luxury villas; per the project rule "NEVER write 'mandatory' without a regulation citation", the dimming column is relabelled as "required by NewMe design policy" and tagged `company_standard`. Where a row also carries a regulatory constraint (e.g. Civil Defence on staircase), it is tagged `regulatory_requirement` separately with citation pending.

## 1. Quick Reference Table
> Cell tags: `co` = `company_standard` (NewMe design policy) · `re` = `regulatory_requirement` (cite pending) · `wa` = `working_assumption` · `pe` = `project_exception`

| Room Type | Light Circuits | Dimming | Curtains | Notes | knowledge_class |
|-----------|----------------|---------|----------|-------|-----------------|
| **Majles** (Arabic Salon) | **3–4** | ✅ **Required by NewMe design** | ✅ Electric | Main + downlight + deco + ambient | `company_standard` |
| **Hall** (Entrance / Lobby) | **2–4** | ✅ **Required by NewMe design** | ✅ Electric | Chandelier + downlight + wall | `company_standard` |
| **Living Room** | **3–4** | ✅ **Required by NewMe design** | ✅ Electric | Main + TV wall + reading + deco | `company_standard` |
| **Master Bedroom** | **3** | ✅ Recommended | ✅ Electric | Main + bedside + dressing | `company_standard` |
| **Standard Bedroom** | **2** | ❌ Optional | ✅ Suggested | Main + bedside | `company_standard` |
| **Dining Room** | **2–3** | ✅ **Required by NewMe design** | ◻ Optional | Chandelier + downlight + deco | `company_standard` |
| **Kitchen** | **2–3** | ❌ **No dim** | ◻ Optional | Work + sink + island (no dim) | `company_standard` |
| **Bathroom** | **1–2** | ❌ **No dim** | ❌ N/A | Main + mirror (IP65) | `company_standard` (IP65 source TBD — see `smart-home-scene-rules` §3.3) |
| **Corridor** | **1–2** | ❌ NO dim | ❌ N/A | Spaced layout; sensor control | `company_standard` |
| **Staircase** | **1–2** | ❌ NO dim | ❌ N/A | **Civil Defence emergency override applies** | `regulatory_requirement` (Civil Defence, cite pending) |
| **Study** | **2** | ✅ Optional | ✅ Suggested | Work + ceiling | `company_standard` |
| **Laundry** | **1** | ❌ NO dim | ❌ N/A | — | `company_standard` |
| **Maids Room** | **1** | ❌ NO dim | ◻ Optional | — | `company_standard` |
| **Balcony** | **1** | ❌ NO dim | ❌ N/A | IP65 outdoor | `company_standard` |
| **Powder Room** | **1** | ❌ NO dim | ❌ N/A | — | `company_standard` |
| **Home Theater** | **2–3** | ✅ **Required by NewMe design** | ✅ Electric curtain/screen | Dimming + scene linking | `company_standard` |
| **Fitness Room** | **1–2** | ❌ Optional | ◻ Optional | — | `company_standard` |
| **Spa / Sauna** | **1–2** | ✅ Ambient dim | ❌ N/A | IP65 | `company_standard` |

> The original "MANDATORY" label on Majles / Hall / Living Room / Dining / Home Theater dimming is `company_standard` (NewMe design policy, owner 森哥). It is not a KNX Association requirement and not a regulation. Downgrading any of these rooms requires a 森哥 / Tanya ruling recorded in `PROJECT_STATE.yaml`.

## 2. Required-Dimming Rooms (NewMe design policy, cannot be downgraded without ruling)
> These rules are `company_standard`, not regulatory. Arabic hospitality UX justification, not code compliance.
- **Majles / Hall / Living Room** — Arabic hospitality requires multi-scene ambient control. `⟨company_standard · NewMe design · partial⟩`
- **Dining Room** — chandelier dimming essential. `⟨company_standard · NewMe design · partial⟩`
- **Home Theater** — scene-linked dimming required by NewMe design. `⟨company_standard · NewMe design · partial⟩`

### Example — Majles (~60 sqm, Palm Villa GF)
> Example is `project_exception` (Pennaz/Palm Villa) for illustration.
```
M1: 水晶主吊灯           → DALI 0–100%
M2: 12× 嵌入式筒灯        → DALI 0–100%
M3: 壁灯 / 氛围灯带       → DALI 0–100%
M4: 装饰射灯             → on/off
Curtains: 2× 落地窗电动开合帘
```

### Scene preset (Majles) (`company_standard`)
| Scene | M1 | M2 | M3 | M4 | Curtain |
|-------|----|----|----|----|---------|
| 接待 (Reception) | 100% | 80% | 50% | ON | open |
| 社交 (Social) | 60% | 40% | 100% | OFF | half |
| 观影 (Movie) | 10% | 10% | 30% | OFF | closed |
| 离开 (Away) | OFF | OFF | OFF | OFF | closed |

## 3. Standard Room Patterns (`company_standard`)

### 3.1 Master Bedroom (3 circuits standard)
1. Main ceiling (dim recommended)
2. Bedside (dim recommended; independent or linked)
3. Dressing room (presence-sensor recommended)

Optional add-ons: reading lights, ambient strip, vanity.

Curtain: electric traverse + blackout (double track).

### 3.2 Kitchen (NO dim)
> "Kitchen NO dim" is `company_standard` (NewMe design policy). Justification given:
- Kitchen needs constant bright light for safety; dimming shifts color temperature (bad for food judgement); heat / grease shortens dimmer life.
- Standard (2–3 circuits):
  - K1 work area (sink + stove) → switch
  - K2 island / ceiling → switch
  - K3 under-cabinet strip → switch (or sensor)
- Client override: if demanded, only K2 (island) dim via DALI driver, with maintenance caveat. `⟨project_exception · requires 森哥 ruling · partial⟩`

### 3.3 Bathroom (IP65, no dim)
- All panels must be **IP65**. `⟨working_assumption · source TBD (Dubai Municipality? NewMe policy?) · unverified⟩` — see `smart-home-scene-rules` §3.3 action item.
- 1–2 circuits, no dim. `⟨company_standard · partial⟩`
- Mirror light may use DALI or 0–10V dim — but actuator must live in dry zone. `⟨company_standard · partial⟩`
- Presence sensor recommended (auto on/off). `⟨company_standard · partial⟩`

## 4. Boundary Room Rules (must surface for human ruling) (`company_standard`)
> These room types **cannot be auto-decided**. The pipeline must list them and wait for 森哥 / Tanya ruling. This is a NewMe policy, not a regulation.

| Room | Open Decision | knowledge_class |
|------|----------------|-----------------|
| 员工区 (driver / maid / staff kitchen) | Equip or skip? | `company_standard` |
| 封闭式厨房 (closed kitchen) | Dim or no-dim? | `company_standard` |
| 室外 (terrace / deck — not climate-controlled) | Include? | `company_standard` |
| 桑拿 / 蒸汽房 (sauna / steam — not climate-controlled) | Include? | `company_standard` |
| 影音室 (home theater) | Dim required by NewMe design; scene set confirmation needed | `company_standard` |

> Cross-reference: `proposal-factory-business-rules` §8 Boundary Room Adjudication.

## 5. Special Rooms

| Room | Notes | knowledge_class |
|------|-------|-----------------|
| Home Theater | Dim required by NewMe design; electric curtain/screen; scene linking; speaker parity check (custom-mode rule 5) | `company_standard` |
| Pool / Outdoor | IP65+; not climate-controlled; boundary room — surface for ruling | `company_standard` |
| Staircase | **Civil Defence emergency override** — see `smart-home-scene-rules` §3.2. **Life-safety: KNX is not the primary life-safety system.** | `regulatory_requirement` (cite pending) |
| Spa / Sauna | IP65; ambient dim allowed; not climate-controlled → boundary | `company_standard` |

## 6. Curtains — Single vs Double Track (`project_exception`)
> Confirmed per project; recorded in `PROJECT_STATE.yaml.confirmed_decisions`.

| Project | Curtain Pattern | Motor Count | knowledge_class |
|---------|-----------------|-------------|-----------------|
| Pennaz | Double track (fabric + sheer) | 2 × window count | `project_exception` (2026-06) |
| Ibrahim | Single track | 1 × window count | `project_exception` (2026-05) |
| New project | **ASK** — never assume | — | `company_standard` (mandatory-ask policy) |

## 7. Relations
- `smart-home-index`
- `smart-home-design-principles` (lines derived from these circuit counts)
- `smart-home-project-exceptions` (project deviations from this table)
- `proposal-factory-business-rules` §4 row mapping, §8 boundary rooms
