# Smart Home Knowledge Classification Rewrite

Rewrite ALL 6 smart-home files already in BM Cloud. Read each from BM Cloud, apply changes, write back.

## Universal Metadata (apply to ALL 6 files)

Replace any existing metadata frontmatter with:
```
canonical_status: active | disputed (if conflicting claims)
owner: 森哥
last_verified: 2026-07-21
volatility: low | medium | high
truth_source: <original source file path>
source_paths: [list of source files]
knowledge_class: see below
verification_status: unverified | partial | verified
supersedes: <previous version if any>
relations: [list of related BM Cloud notes]
```

## Knowledge Class Definitions

Every rule/claim must carry one of:
- `industry_standard` — KNX Association, IEC, ISO standard (cite chapter/version)
- `company_standard` — NewMe internal policy/decision (cite who decided, when)
- `product_specific` — tied to a specific model/vendor (cite model number)
- `project_exception` — deviation for a named project (cite project, date, decider)
- `regulatory_requirement` — DEWA, Dubai Municipality, Civil Defence mandate (cite regulation document, section, version)
- `working_assumption` — reasonable default, NOT verified against primary source

## File-Specific Changes

### 1. smart-home/design-principles
Rules to reclassify:
- "KNX does NOT support PL/LP/RF in NewMe deployments" — change from factual claim to `company_standard` ("NewMe chooses TP1 only")
- "64 devices/line (practical 58)" — change to `industry_standard` (cite KNX spec), note 58 is `working_assumption` headroom
- "Max areas 15" — `industry_standard`

### 2. smart-home/device-rules
CRITICAL: Fix DALI formula contradiction.

Current text says:
- Formula: `ceil(total addresses / 64 / 4)`
- Then: "72 addresses typically needs 2 gateways"

These conflict. Split into:
- **Protocol capacity** (`industry_standard`): DALI standard allows 64 addresses per zone, 4 zones per gateway = 256 addresses per gateway theoretical max
- **Gateway capacity** (`product_specific`): cite actual gateway model and its per-zone limit. If model unknown, mark `verification_status: unverified`
- **Engineering margin** (`company_standard`): NewMe splits by floor/room for cable topology, independent of protocol capacity. This is why 72 addresses = 2 gateways.
- **Project selection** (`working_assumption`): default assumption for new projects

Rules to reclassify:
- "4 zones per DALI gateway" — `product_specific` (depends on gateway model)
- "Theben RAMSES 5×30m" — `product_specific` (cite Theben datasheet chapter)

### 3. smart-home/scene-rules
Rules to reclassify:
- "KNX Secure on all IP backbone" — `company_standard` ("NewMe requires KNX Secure"), NOT `regulatory_requirement` unless DEWA explicitly mandates it
- "KNX Secure compliance audit" — `working_assumption` (not confirmed as DEWA requirement)
- "Smoke detection linkage with KNX mandatory" — `regulatory_requirement` ONLY if Civil Defence regulation cites KNX specifically. Otherwise `working_assumption`. Add note: "KNX does not replace or assume primary life-safety system responsibility. Fire alarm system remains independent primary."
- "Civil Defence emergency override on staircase" — `regulatory_requirement` (cite regulation if found, otherwise mark `verification_status: unverified`)
- "All wet-zone panels IP65" — if from Dubai Municipality regulation → `regulatory_requirement` with cite; if NewMe policy → `company_standard`

### 4. smart-home/room-rules
- "Majles/Hall/Living Room dimming MANDATORY" — `company_standard` (NewMe design policy, not KNX requirement)
- Room circuit counts — `company_standard` (NewMe design baseline)

### 5. smart-home/project-exceptions
- All per-project deviations already have project attribution — keep as `project_exception`
- Pennaz V3→V4 checklist items — mark each as `company_standard` (post-mortem policy) or `project_exception`

### 6. smart-home/index
- Update module map to include knowledge_class column
- Add classification legend

## Rule for ALL claims

For every claim currently stated as fact:
1. Can you cite a primary source (regulation, standard, datasheet, named person + date)?
   - YES → classify appropriately + include citation
   - NO → mark `verification_status: unverified`, knowledge_class: `working_assumption`
2. NEVER write "mandatory" without a regulation citation
3. Fire/life-safety: explicitly state KNX is NOT the primary life-safety system
