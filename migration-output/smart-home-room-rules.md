---
title: smart-home-room-rules
type: note
permalink: personal/newme-os/knowledge/smart-home/smart-home-room-rules
canonical_status: active
owner: 森哥
last_verified: 2026-07-21
volatility: medium
truth_source: room-circuit-rules.md (NewMe design standard, UAE villas)
sources:
  - /home/ubuntu/.hermes/knowledge/01-design-rules/room-circuit-rules.md
  - /home/ubuntu/.hermes/knowledge/01-design-rules/knx-design-rules-consolidated.md
relations:
  - smart-home-index
  - smart-home-design-principles
  - smart-home-project-exceptions
---

# Smart Home — Room / Circuit Mapping Rules

> Drives BOQ row count, actuator selection, and DALI gateway sizing.
> Conflicts with project-specific deviations → see `smart-home-project-exceptions`. Do **not** silently override the table below.

## 1. Quick Reference Table
| Room Type | Light Circuits | Dimming | Curtains | Notes |
|-----------|----------------|---------|----------|-------|
| **Majles** (Arabic Salon) | **3–4** | ✅ **MANDATORY** | ✅ Electric | Main + downlight + deco + ambient |
| **Hall** (Entrance / Lobby) | **2–4** | ✅ **MANDATORY** | ✅ Electric | Chandelier + downlight + wall |
| **Living Room** | **3–4** | ✅ **MANDATORY** | ✅ Electric | Main + TV wall + reading + deco |
| **Master Bedroom** | **3** | ✅ Recommended | ✅ Electric | Main + bedside + dressing |
| **Standard Bedroom** | **2** | ❌ Optional | ✅ Suggested | Main + bedside |
| **Dining Room** | **2–3** | ✅ **MANDATORY** | ◻ Optional | Chandelier + downlight + deco |
| **Kitchen** | **2–3** | ❌ **NO dim** | ◻ Optional | Work + sink + island (no dim) |
| **Bathroom** | **1–2** | ❌ **NO dim** | ❌ N/A | Main + mirror (IP65) |
| **Corridor** | **1–2** | ❌ NO dim | ❌ N/A | Spaced layout; sensor control |
| **Staircase** | **1–2** | ❌ NO dim | ❌ N/A | Civil Defence emergency override mandatory |
| **Study** | **2** | ✅ Optional | ✅ Suggested | Work + ceiling |
| **Laundry** | **1** | ❌ NO dim | ❌ N/A | — |
| **Maids Room** | **1** | ❌ NO dim | ◻ Optional | — |
| **Balcony** | **1** | ❌ NO dim | ❌ N/A | IP65 outdoor |
| **Powder Room** | **1** | ❌ NO dim | ❌ N/A | — |
| **Home Theater** | **2–3** | ✅ **MANDATORY** | ✅ Electric curtain/screen | Dimming + scene linking |
| **Fitness Room** | **1–2** | ❌ Optional | ◻ Optional | — |
| **Spa / Sauna** | **1–2** | ✅ Ambient dim | ❌ N/A | IP65 |

## 2. Mandatory-Dimming Rooms (cannot be downgraded)
- **Majles / Hall / Living Room** — Arabic hospitality requires multi-scene ambient control.
- **Dining Room** — chandelier dimming essential.
- **Home Theater** — scene-linked dimming mandatory.

### Example — Majles (~60 sqm, Palm Villa GF)
```
M1: 水晶主吊灯           → DALI 0–100%
M2: 12× 嵌入式筒灯        → DALI 0–100%
M3: 壁灯 / 氛围灯带       → DALI 0–100%
M4: 装饰射灯             → on/off
Curtains: 2× 落地窗电动开合帘
```

### Scene preset (Majles)
| Scene | M1 | M2 | M3 | M4 | Curtain |
|-------|----|----|----|----|---------|
| 接待 (Reception) | 100% | 80% | 50% | ON | open |
| 社交 (Social) | 60% | 40% | 100% | OFF | half |
| 观影 (Movie) | 10% | 10% | 30% | OFF | closed |
| 离开 (Away) | OFF | OFF | OFF | OFF | closed |

## 3. Standard Room Patterns

### 3.1 Master Bedroom (3 circuits standard)
1. Main ceiling (dim recommended)
2. Bedside (dim recommended; independent or linked)
3. Dressing room (presence-sensor recommended)

Optional add-ons: reading lights, ambient strip, vanity.

Curtain: electric traverse + blackout (double track).

### 3.2 Kitchen (NO dim)
- Why: kitchen needs constant bright light for safety; dimming shifts color temperature (bad for food judgement); heat / grease shortens dimmer life.
- Standard (2–3 circuits):
  - K1 work area (sink + stove) → switch
  - K2 island / ceiling → switch
  - K3 under-cabinet strip → switch (or sensor)
- Client override: if demanded, only K2 (island) dim via DALI driver, with maintenance caveat.

### 3.3 Bathroom (IP65, no dim)
- All panels must be **IP65**.
- 1–2 circuits, no dim.
- Mirror light may use DALI or 0–10V dim — but actuator must live in dry zone.
- Presence sensor recommended (auto on/off).

## 4. Boundary Room Rules (must surface for human ruling)
These room types **cannot be auto-decided**. The pipeline must list them and wait for 森哥 / Tanya ruling:

| Room | Open Decision |
|------|----------------|
| 员工区 (driver / maid / staff kitchen) | Equip or skip? |
| 封闭式厨房 (closed kitchen) | Dim or no-dim? |
| 室外 (terrace / deck — not climate-controlled) | Include? |
| 桑拿 / 蒸汽房 (sauna / steam — not climate-controlled) | Include? |
| 影音室 (home theater) | Dim mandatory; scene set confirmation needed |

> Cross-reference: `proposal-factory-business-rules` §8 Boundary Room Adjudication.

## 5. Special Rooms

| Room | Notes |
|------|-------|
| Home Theater | Dim mandatory; electric curtain/screen; scene linking; speaker parity check (custom-mode rule 5) |
| Pool / Outdoor | IP65+; not climate-controlled; boundary room — surface for ruling |
| Staircase | Civil Defence emergency override mandatory (see `smart-home-scene-rules` §DEWA + Civil Defence) |
| Spa / Sauna | IP65; ambient dim allowed; not climate-controlled → boundary |

## 6. Curtains — Single vs Double Track (project-specific)
| Project | Curtain Pattern | Motor Count |
|---------|-----------------|-------------|
| Pennaz | Double track (fabric + sheer) | 2 × window count |
| Ibrahim | Single track | 1 × window count |
| New project | **ASK** — never assume | — |

> Confirmed per project; recorded in `PROJECT_STATE.yaml.confirmed_decisions`.

## 7. Relations
- `smart-home-index`
- `smart-home-design-principles` (lines derived from these circuit counts)
- `smart-home-project-exceptions` (project deviations from this table)
- `proposal-factory-business-rules` §4 row mapping, §8 boundary rooms
