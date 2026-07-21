---
title: smart-home-scene-rules
type: note
permalink: personal/newme-os/knowledge/smart-home/smart-home-scene-rules
canonical_status: disputed
owner: 森哥
last_verified: 2026-07-21
volatility: high
truth_source: dubai-compliance.md + knx-design-rules-consolidated.md + DEWA 2026 schedule
source_paths:
  - /home/ubuntu/.hermes/knowledge/01-design-rules/dubai-compliance.md
  - /home/ubuntu/.hermes/knowledge/01-design-rules/dewa-2026-electrical-rules.md
  - /home/ubuntu/.hermes/knowledge/01-design-rules/knx-design-rules-consolidated.md
knowledge_class: mixed (company_standard for KNX Secure policy; regulatory_requirement for Civil Defence override; working_assumption for several "mandatory" claims that lack a cited regulation)
verification_status: partial
supersedes: migration-output/smart-home-scene-rules.md (pre-classification version, contained uncited "mandatory" claims)
relations:
  - smart-home-index
  - smart-home-room-rules
  - proposal-factory-pricing-rules
---

# Smart Home — Scene Logic + Compliance

> **Volatility = high.** DEWA 2026 schedule and Dubai Municipality regulations update quarterly. Re-verify before any client deliverable.
> This file indexes the compliance surface; **do not reproduce full DEWA fee tables** here — see source file.

> **Classification note (2026-07-21):** The previous version asserted several rules as "mandatory" without citing a regulation. Per the project rule "NEVER write 'mandatory' without a regulation citation", those rules are reclassified:
> - "KNX Secure on all IP backbone" → `company_standard` (NewMe policy), NOT regulatory.
> - "KNX Secure compliance audit" → `working_assumption` (not confirmed as DEWA requirement).
> - "Smoke detection linkage with KNX mandatory" → `working_assumption` pending Civil Defence citation.
>
> `canonical_status: disputed` because the regulatory basis for several "mandatory" claims could not be confirmed.

> **⚠️ Life-safety boundary (applies to this entire file):**
> **KNX is NOT the primary life-safety system.** KNX does not replace or assume the responsibility of the building's primary fire-alarm / life-safety system. The fire-alarm system remains the independent primary life-safety system. Civil Defence emergency override is implemented at the fire-alarm / building-management level; KNX may *interface* with it (e.g. release staircase lighting to emergency command) but does not assume detection or actuation responsibility. Any scene rule below involving smoke, fire, or emergency override must be read with this boundary in mind.

## 1. Scene Logic Defaults

> Scene defaults are `company_standard` (NewMe UX baseline) unless tagged otherwise.

### 1.1 Per-room scene templates (`company_standard`)
| Room | Mandatory Scenes | knowledge_class |
|------|------------------|-----------------|
| Majles | 接待 / 社交 / 观影 / 离开 | `company_standard` |
| Living Room | 全亮 / 观影 / 阅读 / 离开 | `company_standard` |
| Master Bedroom | 全亮 / 阅读 / 夜起 / 睡眠 | `company_standard` |
| Home Theater | 观影 / 暂停 / 散场 (curtain + screen + projector link) | `company_standard` |
| Dining | 用餐 / 烛光 / 离开 | `company_standard` |
| Bathroom | 全亮 / 夜起 (dim mirror only) | `company_standard` |

> The word "Mandatory" in the column header is the NewMe design baseline, not a regulation. `company_standard` · owner 森哥.

### 1.2 Global scenes (`company_standard`)
| Scene | Behavior | knowledge_class |
|-------|----------|-----------------|
| 离家 (Away) | All lights off, curtains closed, HVAC eco, security armed | `company_standard` |
| 回家 (Welcome) | Entry hall + living on, HVAC comfort, curtains per preset | `company_standard` |
| 睡眠 (Sleep) | All bedrooms to night mode, other floors off, security armed | `company_standard` |
| 全开 (All On) | Diagnostics / cleaning; rarely used | `company_standard` |
| 紧急 (Emergency) | Civil Defence override — see §3.2 | `regulatory_requirement` (if cited) / `working_assumption` (pending cite) |

### 1.3 Scene-linking hard rules
- Home Theater scene **must** link curtain + screen + projector + dimming. `⟨company_standard · custom-mode rule 5 · partial⟩`
- **Staircase scenes must defer to Civil Defence emergency override** (cannot lock out). `⟨regulatory_requirement · Civil Defence (cite pending) · unverified⟩` — see §3.2.
- Majles scenes must be dimmable on at least 3 independent circuits. `⟨company_standard · NewMe design · partial⟩`

## 2. KNX Secure Requirements
> **Reclassification (2026-07-21):** KNX Secure is `company_standard` (NewMe policy), NOT a regulatory requirement. No DEWA / Dubai Municipality regulation has been cited that mandates KNX Secure specifically. If a regulation is later cited, this rule can be upgraded to `regulatory_requirement`.

| Rule | knowledge_class | source / citation | verification_status |
|------|-----------------|-------------------|---------------------|
| KNX Secure on ALL IP-backbone traffic | `company_standard` | NewMe policy ("NewMe requires KNX Secure") — owner 森哥 | partial |
| Device pairing keys recorded in `PROJECT_STATE.yaml` (encrypted) | `company_standard` | NewMe key-management policy | partial |
| ETS project files backed up with passphrase; passphrase → `knowledge/private-access/` | `company_standard` | NewMe backup policy | partial |
| ETS `.knxproj` per delivery, version-controlled in COS | `company_standard` | NewMe delivery policy | partial |

## 3. Dubai Compliance Checklist

### 3.1 DEWA (Dubai Electricity & Water Authority)
| # | Check | knowledge_class | source / citation | verification_status |
|---|-------|-----------------|-------------------|---------------------|
| 1 | Official load calculation submitted | `regulatory_requirement` | DEWA — **cite regulation doc + section** | unverified |
| 2 | TN-S grounding (TN-C rejected) | `regulatory_requirement` | DEWA — **cite regulation doc + section** | unverified |
| 3 | Smart meter / IoT distribution panel | `regulatory_requirement` | DEWA 2026 spec — **cite exact doc** | unverified |
| 4 | Energy efficiency report at handover | `regulatory_requirement` | DEWA — **cite doc** | unverified |
| 5 | MCB + RCD per DEWA spec | `regulatory_requirement` | DEWA — **cite doc** | unverified |
| 6 | KNX Secure compliance audit | `working_assumption` | **NOT confirmed as a DEWA requirement.** Audit cost line in quotation is `company_standard` (NewMe includes it). | unverified |

> Action: each DEWA row above needs an exact regulation document, section, and version. Until cited, treat as `working_assumption` even though the underlying requirement is widely observed in UAE practice. Exact fees → `~/.hermes/knowledge/01-design-rules/dewa-2026-electrical-rules.md`. Do not quote fees from this file.

### 3.2 Civil Defence (民防总局) — emergency override
> **Life-safety boundary:** Civil Defence emergency override is implemented on the **primary fire-alarm / life-safety system**, which is independent of KNX. KNX's role is to release relevant lighting scenes (e.g. staircase) to Civil Defence command when present. KNX does not perform detection and does not replace the primary system.

| Rule | knowledge_class | source / citation | verification_status |
|------|-----------------|-------------------|---------------------|
| Staircase lighting accepts Civil Defence emergency override | `regulatory_requirement` | Civil Defence regulation — **cite exact doc + section** | unverified |
| Smoke detection linkage with KNX | `working_assumption` | Civil Defence does not appear to mandate KNX specifically; linkage is a NewMe integration choice. **KNX does not replace the primary fire-alarm system.** | unverified |
| Emergency scene cannot be locked out by user scenes | `regulatory_requirement` (life-safety principle) | General life-safety principle; cite Civil Defence doc | unverified |
| Tests + sign-off before handover | `regulatory_requirement` | Civil Defence acceptance test requirement — cite doc | unverified |

> **Action:** "Smoke detection linkage with KNX mandatory" is **downgraded to `working_assumption`** until a Civil Defence regulation explicitly citing KNX is produced. KNX is *not* the primary smoke-detection system and must not be described as such in any deliverable.

### 3.3 Dubai Municipality
| Rule | knowledge_class | source / citation | verification_status |
|------|-----------------|-------------------|---------------------|
| Building permit alignment for smart-home install | `regulatory_requirement` | Dubai Municipality — **cite regulation** | unverified |
| IP rating enforcement in wet zones (IP65 min — bathrooms, spa, outdoor) | `working_assumption` | **Source unclear.** If cite is Dubai Municipality regulation → `regulatory_requirement`; if NewMe policy → `company_standard`. Currently no regulation cited. | unverified |
| Cable routing and containment compliance | `regulatory_requirement` | Dubai Municipality — cite regulation | unverified |

> **Action on "wet-zone IP65":** trace to either (a) Dubai Municipality regulation [cite doc, section, version] → upgrade to `regulatory_requirement`, or (b) NewMe internal policy [cite decision maker + date] → mark `company_standard`. Until traced, this rule is `working_assumption` / `verification_status: unverified` and must NOT be called "mandatory".

### 3.4 KNX GCC Climate Certification
- All devices rated ≥55°C ambient. `⟨company_standard · NewMe GCC requirement · partial⟩`
- PSU derated per `smart-home-design-principles` §2. `⟨company_standard · NewMe derating · unverified⟩`
- UV-resistant device enclosures for outdoor placement. `⟨company_standard · NewMe outdoor policy · unverified⟩`

### 3.5 KNX Secure (security compliance)
- KNX Secure on all IP backbone links. `⟨company_standard · NewMe policy · partial⟩` (see §2)
- Project key management per §2 above. `⟨company_standard · partial⟩`

## 4. Scene Engineering Notes (`company_standard`)

### 4.1 Scene controller selection
- Per-floor scene controller if scene count per floor > 8. `⟨company_standard · NewMe heuristic · unverified⟩`
- DALI scene sequencing via DALI gateway (no separate hardware). `⟨product_specific · depends on gateway model · unverified⟩`

### 4.2 Timing
- Scene transitions: 200–500ms typical (smooth but not slow). `⟨company_standard · NewMe UX target · unverified⟩`
- Home Theater: longer (1.5–2s) to allow curtain + projector sync. `⟨company_standard · partial⟩`

### 4.3 Fail-safe
- Any scene involving security must fail-safe to "armed" on bus error. `⟨company_standard · NewMe fail-safe policy · partial⟩`
- HVAC scenes fail to "eco" on loss of CoolMaster link. `⟨company_standard · partial⟩`

> **Fire / life-safety reminder:** fail-safe behaviour described above applies to KNX scenes only. The **primary fire-alarm system has its own independent fail-safe and is not affected by KNX bus state.**

## 5. Compliance Verification Checklist (pre-delivery)
> Each item is tagged. Items marked `unverified` must be confirmed against a cited regulation/policy before client delivery.

- [ ] DEWA submission queued; fee line in quote `⟨regulatory_requirement · unverified⟩`
- [ ] TN-S grounding spec in electrical design `⟨regulatory_requirement · unverified⟩`
- [ ] Smart meter / IoT panel spec confirmed `⟨regulatory_requirement · unverified⟩`
- [ ] Civil Defence override tested on staircase `⟨regulatory_requirement · unverified⟩`
- [ ] All wet-zone panels IP65 verified `⟨working_assumption (source TBD) · unverified⟩`
- [ ] All devices rated ≥55°C `⟨company_standard · partial⟩`
- [ ] KNX Secure enabled on backbone `⟨company_standard · partial⟩`
- [ ] ETS project backed up to COS with passphrase `⟨company_standard · partial⟩`
- [ ] **Primary fire-alarm system tested and signed off independently of KNX** `⟨regulatory_requirement · unverified⟩`

## 6. Relations
- `smart-home-index`
- `smart-home-room-rules` (scene logic per room)
- `proposal-factory-pricing-rules` (DEWA fee lines)
- Source of truth: `~/.hermes/knowledge/01-design-rules/dubai-compliance.md`
- Source of truth: `~/.hermes/knowledge/01-design-rules/dewa-2026-electrical-rules.md`
