---
title: smart-home-scene-rules
type: note
permalink: personal/newme-os/knowledge/smart-home/smart-home-scene-rules
canonical_status: active
owner: 森哥
last_verified: 2026-07-21
volatility: high
truth_source: dubai-compliance.md + knx-design-rules-consolidated.md + DEWA 2026 schedule
sources:
  - /home/ubuntu/.hermes/knowledge/01-design-rules/dubai-compliance.md
  - /home/ubuntu/.hermes/knowledge/01-design-rules/dewa-2026-electrical-rules.md
  - /home/ubuntu/.hermes/knowledge/01-design-rules/knx-design-rules-consolidated.md
relations:
  - smart-home-index
  - smart-home-room-rules
  - proposal-factory-pricing-rules
---

# Smart Home — Scene Logic + Compliance

> **Volatility = high.** DEWA 2026 schedule and Dubai Municipal regulations update quarterly. Re-verify before any client deliverable.
> This file indexes the compliance surface; **do not reproduce full DEWA fee tables** here — see source file.

## 1. Scene Logic Defaults

### 1.1 Per-room scene templates
| Room | Mandatory Scenes |
|------|------------------|
| Majles | 接待 / 社交 / 观影 / 离开 |
| Living Room | 全亮 / 观影 / 阅读 / 离开 |
| Master Bedroom | 全亮 / 阅读 / 夜起 / 睡眠 |
| Home Theater | 观影 / 暂停 / 散场 (curtain + screen + projector link) |
| Dining | 用餐 / 烛光 / 离开 |
| Bathroom | 全亮 / 夜起 (dim mirror only) |

### 1.2 Global scenes
| Scene | Behavior |
|-------|----------|
| 离家 (Away) | All lights off, curtains closed, HVAC eco, security armed |
| 回家 (Welcome) | Entry hall + living on, HVAC comfort, curtains per preset |
| 睡眠 (Sleep) | All bedrooms to night mode, other floors off, security armed |
| 全开 (All On) | Diagnostics / cleaning; rarely used |
| 紧急 (Emergency) | Civil Defence override — see §3.2 |

### 1.3 Scene-linking hard rules
- Home Theater scene **must** link curtain + screen + projector + dimming (custom-mode rule 5: speaker parity check).
- Staircase scenes **must** defer to Civil Defence emergency override (cannot lock out).
- Majles scenes must be dimmable on at least 3 independent circuits (主吊灯 / 筒灯 / 氛围灯).

## 2. KNX Secure Requirements
- All KNX IP traffic on the backbone must use KNX Secure.
- Device pairing keys recorded in `PROJECT_STATE.yaml` (encrypted field, NOT in this note).
- Project files (ETS) backed up with passphrase; passphrase → `knowledge/private-access/`.
- Backups: ETS project `.knxproj` per delivery, version-controlled in COS.

## 3. Dubai Compliance Checklist

### 3.1 DEWA (Dubai Electricity & Water Authority)
| # | Check | Notes |
|---|-------|-------|
| 1 | Official load calculation submitted | Fee per submission; required before energization |
| 2 | TN-S grounding | Mandatory; TN-C rejected |
| 3 | Smart meter / IoT distribution panel | Per DEWA 2026 spec; required for new builds ≥ threshold |
| 4 | Energy efficiency report at handover | Required deliverable |
| 5 | MCB + RCD per DEWA spec | Per-circuit; affects BOQ |
| 6 | KNX Secure compliance audit | Audit cost line in quotation |

> Exact fees → `~/.hermes/knowledge/01-design-rules/dewa-2026-electrical-rules.md`. Do not quote from this file.

### 3.2 Civil Defence (民防总局) — emergency override
- **Staircase** lighting must accept Civil Defence emergency override.
- Smoke detection linkage with KNX mandatory.
- Emergency scene cannot be locked out by user scenes.
- Tests + sign-off required before handover.

### 3.3 Dubai Municipality
- Building permit alignment for smart home install.
- IP rating enforcement in wet zones (IP65 min — bathrooms, spa, outdoor).
- Cable routing and containment compliance.

### 3.4 KNX GCC Climate Certification
- All devices rated ≥55°C ambient.
- PSU derated per `smart-home-design-principles` §2.
- UV-resistant device enclosures for outdoor placement.

### 3.5 KNX Secure (security compliance)
- KNX Secure on all IP backbone links.
- Project key management per §2 above.

## 4. Scene Engineering Notes

### 4.1 Scene controller selection
- Per-floor scene controller if scene count per floor > 8.
- DALI scene sequencing via DALI gateway (no separate hardware).

### 4.2 Timing
- Scene transitions: 200–500ms typical (smooth but not slow).
- Home Theater: longer (1.5–2s) to allow curtain + projector sync.

### 4.3 Fail-safe
- Any scene involving security must fail-safe to "armed" on bus error.
- HVAC scenes fail to "eco" on loss of CoolMaster link.

## 5. Compliance Verification Checklist (pre-delivery)
- [ ] DEWA submission queued; fee line in quote
- [ ] TN-S grounding spec in electrical design
- [ ] Smart meter / IoT panel spec confirmed
- [ ] Civil Defence override tested on staircase
- [ ] All wet-zone panels IP65 verified
- [ ] All devices rated ≥55°C
- [ ] KNX Secure enabled on backbone
- [ ] ETS project backed up to COS with passphrase

## 6. Relations
- `smart-home-index`
- `smart-home-room-rules` (scene logic per room)
- `proposal-factory-pricing-rules` (DEWA fee lines)
- Source of truth: `~/.hermes/knowledge/01-design-rules/dubai-compliance.md`
- Source of truth: `~/.hermes/knowledge/01-design-rules/dewa-2026-electrical-rules.md`
