1|# P0-1 Fixes + P0-2 Migration — Content Generation Task
2|
3|## Your Job
4|Generate corrected markdown files for P0-1 fixes and P0-2 new knowledge files.
5|Write ALL output to `/tmp/migration-batch/` directory.
6|
7|Do NOT write to BM Cloud — Hermes will do that after verification.
8|
9|---
10|
11|## PART A: P0-1 Fixes
12|
13|### A1. company-profile — Rewrite with structure split
14|
15|Current version is at `knowledge/company/company-profile` in BM Cloud. The old version mixed team with CRM accounts.
16|Rewrite to `/tmp/migration-batch/company-profile.md` with this structure:
17|
18|```markdown
19|---
20|title: company-profile
21|type: note
22|permalink: personal/newme-os/knowledge/company/company-profile
23|canonical_status: active
24|owner: 森哥
25|last_verified: 2026-07-21
26|volatility: medium
27|truth_source: 森哥 direct confirmation
28|---
29|
30|# Company Profile — NewMe Smart Home
31|
32|## Identity
33|- Company: NewMe Smart Home FZCO
34|- Business: 高端智能家居设计 + 施工（KNX/DALI/Matter）
35|- Market: 迪拜（Dubai, UAE）
36|- Owner: 森哥
37|
38|## Current Operating Team (last_verified: 2026-07-21)
39|| Name | Role | Status |
40||------|------|--------|
41|| 森哥 | Owner | Active |
42|| Tanya | — | Active |
43|| Mohamed | — | Active |
44|| Ayana | — | Active |
45|| Sai Krishna | — | Active |
46|| Saif | — | Active |
47|| 外包团队 | 编程 | Active |
48|
49|## CRM User Accounts
50|These are SYSTEM accounts — may not map 1:1 to operating team.
51|| Email | Password | Role | verified |
52||-------|----------|------|----------|
53|| tanya@newme.ae | 654321 | Boss | unverified |
54|| ayana@newme.ae | 123456 | Operator | unverified |
55|| mohamed@newme.ae | — | Sales | unverified |
56|| faheem@newme.ae | — | Sales | unverified |
57|| assem@newme.ae | — | Sales | unverified |
58|| dev@newme.ae | — | Admin | unverified |
59|| sam@newme.ae | — | Admin | unverified |
60|
61|## Historical / Unverified
62|Previous MEMORY.md listed 7-person team (Boss/Sales×3/Admin×2/Operator×1). 
63|This may be outdated. Do not treat as current fact without re-verification.
64|
65|## Production Systems
66|(keep from original — Supabase, Linear, GitHub, Sentry, COS, BM Cloud)
67|
68|## Communication Channels
69|(keep the 6-channel table from original)
70|
71|## Business Lines
72|1. Smart Home — KNX 智能家居设计、报价、施工
73|2. CRM — 销售管理、合同、付款、报价全流程
74|3. Industry Intelligence — 竞品追踪、市场研究、AI 动态
75|
76|## Relations
77|- `knowledge/user/user-profile`
78|- `knowledge/private-access/` (for credentials)
79|```
80|
81|Key rules:
82|- Split Operating Team from CRM Accounts
83|- All accounts from old MEMORY.md marked as unverified unless confirmed
84|- New team members (Sai Krishna, Saif, 外包) added as user specified
85|- Add last_verified metadata
86|
87|### A2. crm-core — Split into stable/facts/history
88|
89|Rewrite to `/tmp/migration-batch/crm-core.md`:
90|
91|Split into:
92|1. **Stable Architecture** — Stack, repo, domains (leads/contracts/payments/quotations), deploy gate design
93|2. **Current Production State** — Service status, latest deploy SHA, active issues
94|3. **Historical Events** — newme-crm.service incident, SAM-51 observations, deploy accidents
95|4. **Relations** — links to private-access, company-profile, TASKBOARD
96|
97|Key rules:
98|- Move ALL credentials (Supabase keys, PAT, DSN) OUT of this file → into private-access
99|- Replace credential tables with references: "Credentials → `knowledge/private-access/supabase`"
100|- `next.config.ts` language: "它是仓库中的生产影响配置文件。修改必须经过明确的生产风险审核。" NOT "不是源码"
101|- Add canonical metadata (owner, last_verified, volatility, truth_source)
102|
103|### A3. Private Access Registry — New directory
104|
105|Create `/tmp/migration-batch/private-access-registry.md`:
106|
107|```markdown
108|# Private Access Registry
109|All credentials extracted from Hermes MEMORY.md.
110|Status: unverified (copied from local memory, not tested live)
111|
112|## Supabase
113|| Field | Value |
114||-------|-------|
115|| system | Supabase |
116|| project_url | vfopmpxlhwzpxqegayew.supabase.co |
117|| anon_key | sb_publishable_0UiLli4lUNE_pwhZ13bRfw_xH4TduY_ |
118|| service_role_key | sb_secret_XCMDr7rOiR2XHZEjfQQkqA_cIKG-Doj |
119|| pat | sbp_bbaf7 |
120|| source | MEMORY.md § Supabase |
121|| scope | newme-platform |
122|| status | unverified |
123|| verified_at | null |
124|| rotation_required | unknown |
125|
126|## Linear
127|... (PAT in COS linear.json)
128|
129|## Sentry
130|... (DSN truncated, AUTH_TOKEN in GitHub Secrets)
131|
132|## Telegram
133|... (bot token: @newwme_1_bot)
134|
135|## WeChat
136|... (iLink bot, account_id, token)
137|
138|## Server
139|... (Ubuntu 22.04, IP, SSH access pattern)
140|
141|## CRM Accounts
142|(link to company-profile CRM User Accounts section)
143|```
144|
145|Key rules:
146|- Every entry has: system, value, source, scope, status, verified_at, rotation_required
147|- ALL status = unverified (copied from MEMORY.md, not tested live)
148|- Source field traces back to original location
149|
150|---
151|
152|## PART B: P0-2 — Proposal Factory
153|
154|Read source materials from:
155|- `/home/ubuntu/.hermes/skills/smart-home/proposal-factory/SKILL.md`
156|- `/home/ubuntu/.hermes/skills/smart-home/quotation-workflow-pitfalls/SKILL.md`
157|- `/home/ubuntu/.hermes/skills/smart-home/acceptance-guard/SKILL.md`
158|- `/home/ubuntu/.hermes/knowledge/01-design-rules/` (template-standards, ppt-generation-rules)
159|- `/home/ubuntu/.hermes/projects/` (PIPELINE_CONFIG.yaml, VERSION_LOCK, README-BEFORE-ACT)
160|
161|Create 5 files:
162|
163|### B1. `/tmp/migration-batch/proposal-factory-index.md`
164|Overview + navigation + status of each component.
165|
166|### B2. `/tmp/migration-batch/proposal-factory-business-rules.md`
167|- Fee structure, margin rules, pricing tiers
168|- Quotation row mapping rules
169|- Section total rules
170|- Financial reconciliation rules
171|
172|### B3. `/tmp/migration-batch/proposal-factory-pipeline.md`
173|- Pipeline stages (input → guard chain → output)
174|- Three modes: custom, existing_files_only, generic
175|- Guard chain: State Guard → Drawing Guard → PPT Guard → Cross Validation → Fail Gate
176|- Quality gates and their criteria
177|
178|### B4. `/tmp/migration-batch/proposal-factory-quality-gates.md`
179|- Acceptance guard criteria
180|- Cross-validation rules
181|- Regression test expectations
182|- Known pitfalls (from quotation-workflow-pitfalls)
183|
184|### B5. `/tmp/migration-batch/proposal-factory-pricing-rules.md`
185|- KNX distributor pricing (UAE 2026)
186|- Device markup rules
187|- Installation/labor estimates
188|- DEWA compliance cost factors
189|
190|All files must include canonical metadata:
191|```yaml
192|canonical_status: active | draft | deprecated
193|owner: 森哥
194|last_verified: 2026-07-21
195|volatility: low | medium | high
196|truth_source: <origin file path or person>
197|sources: [list of source files]
198|relations: [links to related BM Cloud notes]
199|supersedes: [previous versions]
200|```
201|
202|---
203|
204|## PART C: P0-2 — Smart Home Design Rules
205|
206|Read source materials from:
207|- `/home/ubuntu/.hermes/knowledge/01-design-rules/00-index.md`
208|- `/home/ubuntu/.hermes/knowledge/01-design-rules/knx-design-rules-consolidated.md`
209|- `/home/ubuntu/.hermes/knowledge/01-design-rules/room-circuit-rules.md`
210|- `/home/ubuntu/.hermes/knowledge/01-design-rules/dubai-compliance.md`
211|- `/home/ubuntu/.hermes/knowledge/01-design-rules/knx-topology-rules.md`
212|- `/home/ubuntu/.hermes/knowledge/01-design-rules/knx-basics.md`
213|- `/home/ubuntu/.hermes/knowledge/01-design-rules/device-calculation-d4-d8-rules.md`
214|- `/home/ubuntu/.hermes/knowledge/02-projects/00-cross-project-lessons.md`
215|
216|Create 6 files:
217|
218|### C1. `/tmp/migration-batch/smart-home-index.md`
219|Overview + navigation to all sub-files. Status of each rule domain.
220|
221|### C2. `/tmp/migration-batch/smart-home-design-principles.md`
222|- KNX bus topology rules
223|- Device capacity limits (GCC climate derating)
224|- PSU sizing rules
225|- Line/area hierarchy
226|
227|### C3. `/tmp/migration-batch/smart-home-room-rules.md`
228|- Room type → circuit count mapping
229|- Dimming vs non-dimming zones
230|- Special rooms (home theater, pool, outdoor)
231|- Boundary room rules
232|
233|### C4. `/tmp/migration-batch/smart-home-device-rules.md`
234|- Device calculation formulas (D4-D8 rules)
235|- Sensor placement (Theben/MDT guidelines)
236|- Actuator selection criteria
237|- Group address standards
238|
239|### C5. `/tmp/migration-batch/smart-home-scene-rules.md`
240|- Scene logic defaults
241|- KNX Secure requirements
242|- DEWA compliance checklist
243|- Dubai Municipal regulations
244|
245|### C6. `/tmp/migration-batch/smart-home-project-exceptions.md`
246|- Known deviations from standard rules per project
247|- Pennaz exceptions
248|- Ibrahim villa exceptions
249|- Mohit villa exceptions
250|- Cross-project lessons learned
251|
252|All files: same canonical metadata format as Proposal Factory files.
253|- Mark conflicts explicitly — do not silently choose
254|- Mark sources
255|- Distinguish universal rules from project-specific exceptions
256|- Do not copy entire source files — index and reference them
257|
258|---
259|
260|## Output Rules
261|- Write ALL files to `/tmp/migration-batch/`
262|- Do NOT write to BM Cloud
263|- Each file is standalone, self-contained markdown
264|- Use `##` for sections, `###` for subsections
265|- Tables preferred over prose for structured data
266|- All credentials marked `unverified`
267|- All team info has `last_verified` date
268|

---

# APPENDIX: Source Materials (OC can't access ~/.hermes/)


## pf_skill
```
1|---
2|name: proposal-factory
3|title: NewMe Proposal Factory — Guarded Pipeline Framework
4|description: |
5|  Production pipeline for KNX smart home proposals.
6|  v0.5 = Generic Mode MVP with fail gate.
7|    Pipeline Runner → PIPELINE_CONFIG → Guard Chain (State/Drawing/PPT/Cross-Val/Fail) → Output.
8|    Three modes: custom (Pennaz), existing_files_only (Ibrahim), generic (template-based new projects).
9|    One command, no human steering required.
10|version: 0.5.1
11|author: Hermes
12|triggers:
13|  - 重新跑一遍
14|  - rerun pipeline
15|  - proposal factory
16|  - 试生产
17|  - golden baseline
18|  - regression test
19|  - blocked_reason
20|  - 长任务断点恢复
21|  - 图纸混淆
22|  - HVAC 图阻断
23|  - PPT 乱图
24|  - 设备出界
25|  - 内部成本泄漏
26|  - READ-BEFORE-ACT
27|  - state recovery guard
28|  - drawing guard
29|  - ppt guard
30|  - cross validation
31|  - generic mode
32|  - fail gate
33|  - quotation row mapping
34|  - update append mode
35|  - Kit sheet
36|  - Smart Home System Kit
37|  - 报价只填了2行
38|  - quotation_fill_report
39|  - final audit
40|  - final mode
41|  - --mode final
42|  - FINAL BLOCKED
43|  - FINAL Ready
44|  - custom post validate
45|  - custom_post_validate
46|  - business rules gate
47|  - 两层校验
48|  - 工程闸门
49|  - 业务规则闸门
50|  - CoolMaster count
51|  - curtain motor double track
52|  - fee percentage 10/10/5
53|  - boundary rooms
54|  - speaker parity
55|  - post-step validation
56|  - financial reconciliation
57|  - section total hardcoded
58|  - 财务联动
59|  - existing_files_only gate
60|  - COS path drift
61|  - COS文件存在性
62|  - release gate
63|  - 冻结
64|  - release archive
65|  - 智能家居报价
66|  - 智能家居方案
67|  - 智能家居PPT
68|  - Excel报价
69|  - PPT提案
70|  - CAD图纸
71|  - DWG
72|  - DXF
73|  - PDF图纸
74|  - 电路图
75|  - 建筑图
76|  - 暖通图
77|  - 户型图
78|  - 平面图
79|  - 客户需求
80|  - Word需求
81|  - Tanya出方案
82|  - 销售方案
83|  - 新项目报价
84|  - 看图纸配设备
85|  - new project setup
86|  - new project prerequisites
87|  - template path resolution
88|  - Missing templates
89|  - ppt_slide_schema.yaml
90|  - approved_assets_manifest.json
91|  - device_quantity.json
92|  - slide_data generation failed
93|  - 0 slides filled
94|  - generic quantity estimate
95|  - drawing analysis data
96|  - Mohit Villa
97|---
98|
99|# Proposal Factory — Guarded Pipeline Framework
100|
101|## Architecture (v0.5.1 Patch 3 — 2026-06-26)
102|
103|\\`\\`\\`
104|User: "跑一个generic项目" or "Pennaz重新跑一遍"
105|  │
106|  ▼
107|[0] PIPELINE CONFIG CHECK → project_pipeline_adapter.py → PIPELINE_CONFIG.yaml
108|  │   mode: custom | generic | existing_files_only
109|  │   blocked → missing_config → STOP
110|  │
111|  ├── custom (Pennaz) → [1]→[2]→[3]→[5]→[6]→[7] + custom_post_validate
112|  ├── existing_files_only (Ibrahim) → [1]→[COS VERIFY]→[HANDOFF]→[MANIFEST]
113|  │   read-only path: coscmd list verify → 00-HANDOFF.md → run_manifest.json
114|  │   BLOCKED if COS files missing or HANDOFF fails to generate
115|  └── generic (dummy, real projects) → [1]→[2]→[3]→[4]→[5]→[6]→[7]→[8]
116|  │
117|  ▼
118|[1] STATE RECOVERY GUARD → state_guard.py → READ-BEFORE-ACT
119|  ▼
120|[2] DRAWING GUARD → drawing_guard.py
121|  ▼
122|[3] QUANTITY + QUOTATION
123|  │   3a. generic_quantity_builder.py (generic only)
124|  │   3b. generic_quotation_builder.py (generic) or custom pipeline (Pennaz)
125|  ▼
126|[4] PPT GENERATION (generic or custom)
127|  ▼
128|[5] PPT GUARD → ppt_guard.py
129|  ▼
130|[6] CROSS VALIDATION
131|  │   generic → generic_cross_validate.py (fail gate)
132|  │   custom  → custom_post_validate.py (engineering + 9 business rules)
133|  ▼
134|[7] FINAL AUDIT → audit_report.md + run_manifest.json + PROJECT_STATE.yaml
135|  │
136|  ▼
137|[8] FINAL MODE (--mode final)
138|  │   forces HANDOFF, forces all gates, delivery_ready in manifest
139|  │   BLOCKED → exit 1, PASS → exit 0
140|  │
141|Output: ~/.hermes/projects/<project>/runs/FINAL/ or V_NEXT/ or DRAFT_001/
142|\\`\\`\\`
143|
144|## 🔴 COLD START — Read Before ANY Production Task
145|
146|**This is the FIRST instruction executed when proposal-factory skill loads.**
147|
148|Before analyzing drawings, counting devices, generating quotations, or rendering PPTs, you MUST:
149|
150|1. **Read the frozen rules file:**
151|   ```
152|   .hermes/archives/v0.5.1-release/03-frozen_rules.md
153|   ```
154|
155|2. **Read the project state file (if project already exists):**
156|   ```
157|   .hermes/projects/<project>/PROJECT_STATE.yaml
158|   ```
159|
160|3. **Verify the release archive exists.** If `03-frozen_rules.md` is missing or unreadable:
161|   ```
162|   → BLOCKED (release_archive_missing)
163|   → Do NOT generate quotation
164|   → Do NOT generate PPT
165|   → Do NOT mark any file as FINAL or delivery_ready
166|   → Report: "v0.5.1 release archive not found. Cannot start production task."
167|   ```
168|
169|4. **New projects always start as DRAFT.** Never jump directly to FINAL mode on a first run.
170|   - `can_start_final` is always `false` for new projects
171|   - Only existing projects with prior DRAFT + user explici
```

[truncated: 6052 total chars]

## knx_consolidated
```
1|# KNX Design Rules — Consolidated Reference
2|# Target: UAE Luxury Villas (300-1000sqm)
3|# Sources: room-circuit-rules.md, knx-topology-rules.md, knx-design-rules-by-case.md,
4|#          knx-rules.yaml, dubai-compliance.md, knx-basics.md, uae-knx-pricing-benchmark.md
5|# Generated: 2026-05-30
6|
7|---
8|
9|## 1. KNX BUS TOPOLOGY RULES (from knx-topology-rules.md + knx-basics.md)
10|
11|### 1.1 Core TP1 Bus Parameters
12|| Parameter | Specification | Notes |
13||-----------|--------------|-------|
14|| Bus type | TP1 (Twisted Pair 1) | Polarity sensitive (Red+/Black-) |
15|| Max devices per line | 64 (practical max: 58 with 10% headroom) | Includes PSU itself |
16|| Max bus length | 1000m (all branch total) | Beyond this → line coupler/repeater |
17|| PSU standard capacity | 640mA (ABB SV/S 30.640.5) | Standard selection |
18|| PSU safety margin | 70% load → 448mA → ~44 devices @10mA | Peak 85% (<1hr), NEVER >100% |
19|| Max length main/branch | 350m (PSU to farthest device) | |
20|| Max inter-line distance | ≤1000m | Cumulative bus total |
21|
22|### 1.2 GCC Climate Derating (55°C Gulf region)
23|- PSU output derated to ~90% @55°C → effective 576mA
24|- Recommended load @70% = 576×0.7 = 403mA → ~40 devices (not 44)
25|- ALL devices must support 55°C ambient temperature
26|- PSU brand: ABB SV/S 30.640.5 (rated -5°C ~ +55°C) ✅
27|
28|### 1.3 Topology Hierarchy
29|```
30|Area ──────────── Max 15 areas
31|  │ (IP backbone / mainline)
32|Area Coupler
33|  │
34|Main Line ────── Max 15 lines/area
35|  │
36|Line Coupler ─── Provides electrical isolation
37|  │
38|Sub Line ─────── Max 64 devices/line
39|```
40|
41|### 1.4 Typical Dubai Villa Topology (770sqm example)
42|```
43|Area 1 ─── Main Line (IP Router)
44|  ├── LC1 ─── Sub Line 1: Ground Floor (lights+curtains+panels ≈48 devices)
45|  │              PSU (640mA × 70% ≈ 448mA)
46|  ├── LC2 ─── Sub Line 2: 1st Floor (lights+curtains+panels ≈44 devices)
47|  │              PSU (640mA × 70% ≈ 448mA)
48|  └── LC3 ─── Sub Line 3: HVAC + Security + DALI gateways + system (≈20 devices)
49|                 PSU (640mA × 30% ≈ 192mA)
50|```
51|
52|**Design rule**: Divide by floor. GF and 1F each get one line. System devices (gateways, controllers) on a 3rd line.
53|
54|### 1.5 PSU Capacity Calculation
55|Formula: `Total current = Σ(device current draw)`
56|- Smart panel (4-key): 15-25mA
57|- Touch screen (7"): 80-150mA (may need separate supply)
58|- 4ch switch actuator: 8-12mA
59|- 4ch dimming actuator: 12-18mA
60|- Curtain actuator: 10-15mA
61|- PIR sensor: 5-10mA
62|- DALI gateway: 20-30mA
63|- IP router: 40-60mA (usually on main line)
64|- Line coupler: 10-15mA
65|
66|### 1.6 Line Coupler Rules
67|- Required between main line and each sub line
68|- Provides electrical isolation (one line fault won't affect others)
69|- Physical address format: Area.Line.Device (e.g., 1.1.1)
70|- Coupler itself occupies device address (sub line position 0)
71|- Can configure filter tables to reduce cross-line traffic
72|
73|### 1.7 IP Router & Backbone (for projects >225 devices or >15 lines)
74|- Each area needs 1 IP router connecting main line to IP network
75|- IP tunnel: used for ETS programming and visualization
76|- Multicast: KNX IP uses UDP multicast (224.0.23.12, port 3671)
77|- Network: Enable IGMP Snooping on switches
78|
79|---
80|
81|## 2. ROOM-CIRCUIT MAPPING RULES (from room-circuit-rules.md)
82|
83|### 2.1 Quick Reference Table
84|| Room Type | Light Circuits | Dimming | Curtains | Notes |
85||-----------|---------------|---------|----------|-------|
86|| **Majles** (Arabic Salon) | **3-4** | ✅ **MANDATORY** | ✅ Electric | Main+downlight+deco+ambient |
87|| **Hall** (Entrance/Lobby) | **2-4** | ✅ **MANDATORY** | ✅ Electric | Chandelier+downlight+wall |
88|| **Living Room** | **3-4** | ✅ **MANDATORY** | ✅ Electric | Main+TV wall+reading+deco |
89|| **Master Bedroom** | **3** | ✅ Recommended | ✅ Electric | Main+bedside+dressing |
90|| **Standard Bedroom** | **2** | ❌ Optional | ✅ Suggested | Main+bedside |
91|| **Dining Room** | **2-3** | ✅ **MANDATORY** | ◻ Optional | Chandelier+downlight+deco |
92|| **Kitchen** | **2-3** | ❌ **NO dim** | ◻ Optional | Work+sink+island (no dim) |
93|| **Bathroom** | **1-2** | ❌ **NO dim** | ❌ N/A | Main+mirror (IP65) |
94|| **Corridor** | **1-2** | ❌ NO dim | ❌ N/A | Spaced layout, sensor control |
95|| **Staircase** | **1-2** | ❌ NO dim | ❌ N/A | Civil Defence emergency override mandatory |
96|| **Study** | **2** | ✅ Optional | ✅ Suggested | Work+ceiling |
97|| **Laundry** | **1** | ❌ NO dim | ❌ N/A | |
98|| **Maids Room** | **1** | ❌ NO dim | ◻ Optional | |
99|| **Balcony** | **1** | ❌ NO dim | ❌ N/A | IP65 outdoor |
100|| **Powder Room** | **1** | ❌ NO dim | ❌ N/A | |
101|| **Home Theater** | **2-3** | ✅ **MANDATORY** | ✅ Electric curtain/screen | Dimming+scene linking |
102|| **Fitness Room** | **1-2** | ❌ Optional | ◻ Optional | |
103|| **Spa/Sauna** | **1-2** | ✅ Ambient dim | ❌ N/A | IP65 |
104|
105|### 2.2 Key Rules
106|
107|
```

[truncated: 16900 total chars]

## design_index
```
1|# 📋 设计规则总览
2|
3|> **核心设计原则**：安全、合规、可靠、可维护
4|> 本章节包含 NewMe SMART HOME 在迪拜进行 KNX 智能家居设计时遵循的所有技术规范与规则。
5|
6|---
7|
8|## 🎯 本模块内容
9|
10|| 序号 | 笔记 | 内容概要 |
11||------|------|----------|
12|| 1 | [[knx-basics.md\|KNX 基础]] | KNX 协议原理、总线设备类型（传感器、执行器、系统设备）、TP1 总线通信机制 |
13|| 2 | [[knx-topology-rules.md\|KNX 拓扑规则]] | 总线长度限制、每线设备数量上限、PSU 容量计算（640mA/70%裕量）、线耦合器与路由器配置 |
14|| 3 | [[dubai-compliance.md\|迪拜合规检查清单]] | DEWA 供电局、迪拜市政府、民防总局、KNX GCC 气候认证、KNX Secure 安全合规 |
15|| 4 | [[room-circuit-rules.md\|房间类型-电路映射规则]] | 各房间类型的回路数量标准、调光/非调光区分、特殊房间要求 |
16|| 5 | [[template-standards.md\|交付模板标准]] | 设计交付物命名规范、Excel/WPS 格式标准、PPT 模板结构、CAD 图层标准 |
17||
18||--- |--- |--- |
19|| **📦 新增** | | |
20|| 6 | [[uae-knx-distributor-pricing-2026.md\|UAE KNX 分销商实时定价 2026]] | Infinitex (Optimus) + Cache.ae (1Home/CoolAuto/PolarBear) — 分设备 AED 单价、品牌对比、采购策略 |
21|| 7 | [[dewa-2026-electrical-rules.md\|DEWA 2026 电气规则]] | 官方负载计算、TN-S 接地、智能电表/IoT 配电箱、能效报告 — 补充审批流程指南的技术细节 |
22|| 8 | [[knx-sensor-placement-theben-mdt.md\|传感器放置 — Theben/MDT 官方指南]] | Theben RAMSES 走廊 5×30m 模式、IP54 湿区方案、MDT 规格、选型决策矩阵 |
23|| 9 | [[knx-group-address-standards.md\|KNX 组地址与拓扑标准 (KNX Assn.)]] | 三层组地址分配、物理地址规范、ETS 项目组织、总线负载控制 |
24|
25|---
26|
27|## 🔄 设计工作流程
28|
29|```mermaid
30|flowchart LR
31|    A[📐 CAD 建筑图] --> B[📋 房间划分 & 回路规划]
32|    B --> C[🔌 KNX 拓扑设计]
33|    C --> D[📊 BOQ 物料清单]
34|    D --> E[💰 成本估算]
35|    E --> F[📝 PPT 汇报]
36|    F --> G[✅ 交叉校验 QC]
37|    G --> H[📦 交付]
38|```
39|
40|### 阶段说明
41|
42|**1. CAD 分析阶段**
43|- 接收建筑 DXF 图纸，分析楼层布局
44|- 识别所有房间类型、面积、门窗位置
45|- 标记灯位、开关位、窗帘位 → 参考 [[knx-basics.md#KNX 设备类型]]
46|
47|**2. 回路规划阶段**
48|- 根据 [[room-circuit-rules.md]] 为每个房间分配回路
49|- 确定调光区域（Hall/Majles/Living 必须调光）
50|- 统计总灯光回路数、窗帘电机数、空调设备数
51|
52|**3. 拓扑设计阶段**
53|- 参照 [[knx-topology-rules.md]] 计算所需线数
54|- 计算 PSU 数量（640mA × 线数，70%裕量）
55|- 设计主干网（IP 路由器 + 线耦合器）
56|- 确认 DALI 网关数量（4分区/网关）
57|
58|**4. 合规审查阶段**
59|- 逐项检查 [[dubai-compliance.md]] 中的 15 项合规清单
60|- 特别关注 DEWA 的 MCB+RCD 要求和民防的烟感联动
61|
62|**5. 交付物生成**
63|- 按照 [[template-standards.md]] 生成标准化交付物
64|- Excel 报价表（WPS 单元格图片格式）
65|- PPT 57 页标准汇报
66|
67|---
68|
69|## 📏 核心参数速查表
70|
71|| 参数 | 规格 | 备注 |
72||------|------|------|
73|| KNX 总线类型 | TP1 (双绞线) | 不支持 PL/LP/RF |
74|| 单线最大设备 | 64 台 | 含 PSU 本身 |
75|| 总线最大长度 | 1000m | 含支线总长 |
76|| PSU 容量 | 640mA | 建议负载 ≤ 70% (≈448mA) |
77|| 每线 PSU 数量 | 1 台 | 视负载可增加 |
78|| 线数/区域 | 最多 15 条 | 含主线 |
79|| 区域数 | 最多 15 个 | 通过 IP 骨干网互联 |
80|| DALI 分区 | 4 分区/网关 | 每分区 64 地址 |
81|| 窗帘执行器 | 4 通道/模块 | |
82|| 环境温度 | 最高 55°C | GCC 气候降额要求 |
83|
84|---
85|
86|## 🏢 典型项目参数
87|
88|以棕榈岛 770sqm 豪华别墅为例：
89|
90|| 楼层 | 灯光回路 | 窗帘电机 | 面积 (sqm) |
91||------|----------|----------|-------------|
92|| Ground Floor | 37 | 6 | ~400 |
93|| 1st Floor | 35 | 5 | ~370 |
94|| **合计** | **72** | **11** | **~770** |
95|
96|> 💡 **基于此估算**：72 灯光回路 → 需 72 个开关执行器通道 → 约 18 个 4 通道执行器；72 DALI 地址 → 约 2 个 DALI 网关（每网关 4 分区，每分区 64 地址）；11 窗帘电机 → 约 3 个 4 通道窗帘执行器。
97|
98|---
99|
100|## 📑 相关笔记
101|
102|- 回到主索引：[[../00-index.md|知识库首页]]
103|- 完整导航：[[../00-MASTER-INDEX.md|MASTER INDEX - 任务路由入口]]
104|- 跨项目经验：[[../02-projects/00-cross-project-lessons.md]]
105|- PPT 生成规则：[[ppt-generation-rules.md]]
106|- Vision/DWG 解析：[[vision-dwg-workflow.md]]
107|- 查看 [[../quality-check.md|质量检查流程]]
108|
```

## cross_project
```
1|# 跨项目经验 — Pennaz vs Ibrahim vs 通用模式
2|
3|> **来源**: Pennaz Villa (2026-06), Ibrahim Villa (2026-05), 3D Experience Simulator
4|> **目的**: 提取可复用的设计模式，加速后续项目
5|
6|---
7|
8|## 1. 项目参数对比
9|
10|| 参数 | Pennaz | Ibrahim |
11||------|--------|---------|
12|| 面积 | ~1200 sqm | ~770 sqm |
13|| 楼层 | GF+FF+SF (3层) | GF+FF (2层) |
14|| 灯光回路 | ~72 | ~72 |
15|| 窗帘电机 | 20 (双层) | 14 (单层) |
16|| 温控面板 | 16 | ~12 |
17|| 传感器 | 24 | ~18 |
18|| 报价总额 | 163,880 AED | — |
19|| 含价模板 | ✅ 有 | ❌ 无 (Creatrol 24G) |
20|
21|---
22|
23|## 2. 可复用模式
24|
25|### 2.1 器件统计 — PDF 文字层优先
26|
27|**模式**: 不要用 Vision 数器件。PDF `pg.get_text("words")` 带坐标才是真理。
28|
29|**适用**: 所有有 PDF 图纸的项目。
30|
31|**Pennaz 验证**: Vision 数的器件数和 PDF 文字层不一致，PDF 更准。
32|
33|### 2.2 报价填写 — UNO 保图路径
34|
35|**模式**: LibreOffice UNO 宏回填报价，保留嵌入图片。
36|
37|**适用**: 所有 .xls 格式的含价模板。
38|
39|**通用脚本**: `scripts/fill_quotation_preserve_images.py`
40|
41|### 2.3 点位图 — 模板通用版
42|
43|**模式**: 用 NEWME_layout_template.pptx 的通用点位图 + 修正页注。
44|
45|**适用**: 当客户没提供 DWG 或 DWG 格式不兼容时。
46|
47|**Ibrahim 先例**: 用户裁定"模板通用版就够了"。
48|
49|### 2.4 边界房间裁定
50|
51|**模式**: 以下房间类型不能自动决策，必须列出来等用户裁定：
52|- 员工区（司机/保姆/员工厨房）
53|- 封闭式厨房（调光 vs 不调光）
54|- 室外（露台/平台 — 不控温）
55|- 桑拿/蒸汽房（不控温）
56|- 影音室（要调光）
57|
58|### 2.5 DWG 格式兜底
59|
60|**模式**: DWG AC1032 格式 = 死路。直接走 PDF 替代，不浪费时间试转换器。
61|
62|---
63|
64|## 3. 项目差异 — 不能直接套用的
65|
66|| 差异点 | Pennaz | Ibrahim | 判据 |
67||-------|--------|---------|------|
68|| 窗帘层数 | 双层(布+纱)=20电机 | 单层=14电机 | 问用户 |
69|| 员工区 | 全不配 | — | 问用户 |
70|| 温度面板 | 16个 Citron | ~12 | 逐房推导 |
71|| 含价模板 | 有 | 无 | 搜索 COS |
72|| SONOS | 取最高价 | TBD | 品牌确认后回填 |
73|
74|---
75|
76|## 4. 交付验证 checklist (Pennaz V3→V4修复 2026-06-11)
77|
78|**事故**: V3声称交付完成，但Tanya检查发现4个问题。
79|
80|```
81|□ PPT底图: 每张图MD5必须match客户源文件，不接受模板通用图
82|□ PPT楼层: 不存在的楼层(BF)页必须删，标签必须一致(GF/FF/SF)
83|□ Excel页脚: libreoffice转PDF → pdftotext检查零中文
84|□ Excel费率: 所有板块Design 10% + Install 10% + Program 5%一致
85|□ Excel Grand Total: 各Section Subtotal之和 = Summary Total
86|□ COS凭证: 上传下载用目标桶专用密钥，不混用
87|□ 视觉QA: Excel/PPT必须渲染为PNG/GLM验证，不能只读数据
88|□ python-pptx删页: 不可能，别尝试(3次全败)——只替换图片不删页
89|□ openpyxl页脚: HeaderFooterItem(center=_HeaderFooterPart())三层嵌套
90|□ GLM视觉对比: 不用GLM做"这两图一样吗"(幻觉)，单图描述OK
91|```
92|
93|---
94|
95|## 5. 新项目启动 checklist
96|
97|```
98|□ 获取 PDF 图纸（不是 DWG）
99|□ COS 搜索"含价"前缀模板
100|□ 确认楼层数 + 面积
101|□ 确认窗帘单层/双层
102|□ 确认员工区/特殊房间处理
103|□ 确认温度面板/传感器品牌
104|□ 确认背景音乐品牌 (SONOS/其他/TBD)
105|□ 读 MASTER-INDEX → 按任务类型跳转
106|```
107|
```

## room_circuits
```
1|# 🛋️ 房间类型-电路映射规则
2|
3|> **不同房间类型对应不同的智能电路标准。** 本文规定了 NewMe SMART HOME 在迪拜别墅项目中各房间类型的灯光回路数量、调光要求、窗帘配置及其他特殊规则。
4|>
5|> 结合 [[knx-topology-rules.md|拓扑规则]] 进行系统规划，参考 [[dubai-compliance.md|迪拜合规检查清单]] 满足当地要求。
6|
7|---
8|
9|## 📊 快速参考表
10|
11|| 房间类型 | 灯光回路 | 调光 | 窗帘 | 备注 |
12||----------|----------|------|------|------|
13|| **Majles/ مجلس** (阿拉伯会客厅) | **3-4** | ✅ **必须** | ✅ 电动窗帘 | 主灯+筒灯+装饰灯+氛围灯 |
14|| **Hall** (大厅/玄关) | **2-4** | ✅ **必须** | ✅ 电动窗帘 | 水晶吊灯+筒灯+壁灯+廊灯 |
15|| **Living Room** (客厅) | **3-4** | ✅ **必须** | ✅ 电动窗帘 | 主灯+电视墙+阅读灯+装饰 |
16|| **Master Bedroom** (主卧) | **3** | ✅ **建议** | ✅ 电动窗帘 | 主灯+床头+衣帽间+阅读灯 |
17|| **Standard Bedroom** (次卧) | **2** | ❌ 可选 | ✅ 建议 | 主灯+床头灯 |
18|| **Dining Room** (餐厅) | **2-3** | ✅ **必须** | ⬜ 可选 | 吊灯+筒灯+装饰灯 |
19|| **Kitchen** (厨房) | **2-3** | ❌ **不调光** | ⬜ 可选 | 工作灯+水槽灯+中岛灯 |
20|| **Bathroom** (浴室) | **1-2** | ❌ **不调光** | ❌ 不适用 | 主灯+镜前灯（IP65） |
21|| **Corridor** (走廊) | **1-2** | ❌ **不调光** | ❌ 不适用 | 间隔布置，感应控制 |
22|| **Staircase** (楼梯) | **1-2** | ❌ **不调光** | ❌ 不适用 | 民防应急超控强制 |
23|| **Study** (书房) | **2** | ✅ 可选 | ✅ 建议 | 工作灯+顶灯 |
24|| **Laundry** (洗衣房) | **1** | ❌ 不调光 | ❌ 不适用 | |
25|| **Maids Room** (佣人房) | **1** | ❌ 不调光 | ⬜ 可选 | |
26|| **Balcony** (阳台) | **1** | ❌ 不调光 | ❌ 不适用 | IP65 户外标准 |
27|| **Powder Room** (客卫) | **1** | ❌ 不调光 | ❌ 不适用 | |
28|| **Home Theater** (影音室) | **2-3** | ✅ **必须** | ✅ 电动窗帘/幕布 | 调光 + 场景联动 |
29|| **Fitness Room** (健身房) | **1-2** | ❌ 可选 | ⬜ 可选 | |
30|| **Spa/Sauna** (水疗/桑拿) | **1-2** | ✅ 氛围调光 | ❌ 不适用 | IP65 |
31|
32|---
33|
34|## 🎯 关键规则详解
35|
36|### 规则 1：Hall / Majles / Living 必须有调光
37|
38|**为什么？**
39|- 阿拉伯文化中 Majles（会客厅）和 Hall（大厅）是接待客人的核心区域
40|- 需要灵活的场景切换：接待模式（明亮）→ 社交模式（柔和）→ 小憩模式（微光）
41|- 水晶吊灯、筒灯、氛围灯需独立调光
42|
43|**迪拜项目示例**（棕榈岛别墅 Ground Floor）：
44|```
45|Majles (60sqm):
46|  └── 回路 M1: 水晶主吊灯 (DALI 调光 0-100%)
47|  └── 回路 M2: 12盏嵌入式筒灯 (DALI 调光 0-100%)  
48|  └── 回路 M3: 壁灯/氛围灯带 (DALI 调光 0-100%)
49|  └── 回路 M4: 装饰射灯 (开/关)
50|  └── 窗帘: 2路电动开合帘（落地窗）
51|```
52|
53|**场景配置**：
54|| 场景 | M1 吊灯 | M2 筒灯 | M3 氛围灯 | M4 射灯 | 窗帘 |
55||------|---------|---------|-----------|---------|------|
56|| 接待 | 100% | 80% | 50% | ON | 开启 |
57|| 社交 | 60% | 40% | 100% | OFF | 半开 |
58|| 观影 | 10% | 10% | 30% | OFF | 关闭 |
59|| 离开 | OFF | OFF | OFF | OFF | 关闭 |
60|
61|### 规则 2：Master Bedroom 标准回路
62|
63|**主卧 3 回路标准配置：**
64|
65|1. **主灯回路**（建议调光）：吸顶灯或吊灯，满足整体照明
66|2. **床头回路**（建议调光）：两侧床头灯/壁灯，独立控制或联动
67|3. **衣帽间回路**（建议感应）：步入式衣帽间自动感应灯
68|
69|**可选附加回路**：
70|- 阅读灯（床头两侧独立控制）
71|- 装饰灯带（床底/电视墙氛围）
72|- 梳妆台灯
73|
74|**窗帘控制**：主卧配电动开合帘 + 遮光帘（双层导轨）
75|
76|### 规则 3：厨房不调光
77|
78|**为什么厨房不调光？**
79|- 厨房需要**恒定明亮**的照明保证操作安全
80|- 调光可能造成色温偏移，影响食材辨色
81|- 厨房环境温度高、油烟多，调光器故障率更高
82|
83|**厨房标准配置**（2-3 回路）：
84|```
85|Kitchen (30sqm):
86|  └── 回路 K1: 工作区灯（水槽上方+灶台）→ 开关
87|  └── 回路 K2: 中岛吊灯/吸顶灯 → 开关
88|  └── 回路 K3: 橱柜下方灯带 → 开关 (可选感应)
89|```
90|
91|**注意**：如果客户强烈要求调光，可对 K2（中岛灯）提供调光，但需使用 DALI 调光驱动器，并说明维护注意事项。
92|
93|### 规则 4：Bathroom IP65 + 不调光
94|
95|**浴室设计规范**：
96|- 所有面板必须 **IP65**（见 [[dubai-compliance.md#检查项 6：潮湿区域 IP65 防护]]）
97|- 灯光回路：1-2 回路，**不调光**
98|- 镜前灯建议使用 DALI 或 0-10V 调光（如果客户要求，但执行器需在干燥区域）
99|- 建议配置存在感应器实现人来灯亮、人走灯灭
100|
101|
```

## pf_pipeline_config
```
1|# Pennaz Project Pipeline Config
2|# mode: custom = 有项目专用脚本
3|
4|project_name: pennaz
5|mode: custom
6|
7|custom_scripts:
8|  quotation: /home/ubuntu/pennaz-project/pennaz_v6_pipeline.py
9|  ppt: /home/ubuntu/pennaz-project/fix_ppt_v4.py
10|
11|templates:
12|  quotation_template: "~/.hermes/data/智能家居设计模板/Newme-SHQ-客户姓名-20260508-amyxls.xls"
13|  ppt_template: "~/.hermes/data/智能家居设计模板/NEWME AS 客户姓名-日期-LXV3.1.pptx"
14|
15|inputs:
16|  drawings:
17|    - "/home/ubuntu/pennaz-project/HVAC LAYOUT, 03.01.2026, Ground Floor VILLA, HVAC LAYOUT.pdf"
18|    - "/home/ubuntu/pennaz-project/HVAC LAYOUT, 03.01.2026, First Floor VILLA, HVAC LAYOUT.pdf"
19|    - "/home/ubuntu/pennaz-project/HVAC LAYOUT, 03.01.2025, Second Floor VILLA, HVAC LAYOUT.pdf"
20|  requirements: "派工单 (KNX 01 PS DESIGN REQUEST FORM.docx)"
21|  old_quotation: "tanya-1420640156/Pennaz Project/deliverables/Newme-SHQ-Pennaz-20260609-V3.xls"
22|  old_ppt: "tanya-1420640156/Pennaz Project/deliverables/NEWME AS Pennaz-20260609-LXV3.1.pptx"
23|
24|outputs:
25|  quotation: "/home/ubuntu/.hermes/projects/pennaz/runs/V_NEXT/quotation.xls"
26|  proposal: "/home/ubuntu/.hermes/projects/pennaz/runs/V_NEXT/proposal.pptx"
27|  audit_report: "/home/ubuntu/.hermes/projects/pennaz/runs/V_NEXT/audit_report.md"
28|
29|capabilities:
30|  can_generate_new_quotation: true
31|  can_generate_new_ppt: true
32|  can_use_existing_files: true
33|
34|blocked_rules: []
35|
```

## pf_readme
```
1|# READ-BEFORE-ACT — 接入说明
2|
3|## 规则
4|
5|任何智能家居设计任务的入口，**必须先执行 READ-BEFORE-ACT**，然后才能做任何其他事。
6|
7|## 接入方式
8|
9|从 `state_guard.py` 调用 `read_before_act()`：
10|
11|```python
12|from state_guard import StateGuard
13|
14|# 在任何动作之前
15|guard = StateGuard(project_name="pennaz")
16|result = guard.read_before_act(user_message="Pennaz重新跑一遍，别问细节，自己搞定。")
17|
18|# result 包含:
19|# - action: "continue" | "restart" | "blocked" | "new_project"
20|# - next_stage: 下一步应该执行的阶段
21|# - confirmed_decisions: 已确认决策列表（禁止重新问）
22|# - open_questions: 真正阻塞的问题
23|# - recovery_context_path: 恢复上下文文件路径
24|```
25|
26|## CLI 方式
27|
28|```bash
29|python3 ~/.hermes/scripts/state_guard.py read_before_act pennaz "Pennaz重新跑一遍，别问细节，自己搞定。"
30|python3 ~/.hermes/scripts/state_guard.py create pennaz '{"project_name":"NewProject","drawing_files":["..."]}'
31|```
32|
33|## 流程
34|
35|```
36|收到用户消息
37|  ↓
38|1. 调用 StateGuard(project).read_before_act(user_message)
39|  ↓
40|2. 读取 PROJECT_STATE.yaml (如果存在)
41|   读取 TASK_STATE.md (如果存在)
42|   读取 00-HANDOFF.md (如果存在)
43|  ↓
44|3. 对比 state 与用户最新指令
45|   用户最新指令优先
46|  ↓
47|4. 生成 recovery_context.md
48|  ↓
49|5. 根据 result.action:
50|   - "restart"    → 从现有状态重新执行
51|   - "continue"   → 从当前 stage 继续
52|   - "blocked"    → 输出 blocked_reason，不做任何执行
53|   - "new_project" → 创建新 PROJECT_STATE.yaml 然后执行
54|```
55|
56|## 项目中创建状态
57|
58|```python
59|guard = StateGuard("project-name")
60|guard.create_project({
61|    "project_name": "Project Name",
62|    "drawing_files": ["G.F.pdf", "F.F.pdf", "S.F.pdf"],
63|})
64|guard.add_decision("Cinema dimming", "DALI调光", "Tanya", "裁定影院做调光")
65|guard.stage_complete("INTAKE")  # 自动推进到下一阶段
66|guard.record_artifact("INTAKE", "tanya-bucket/path/to/source")
67|```
68|
69|## 位置
70|
71|| 文件 | 路径 |
72||------|------|
73|| 核心类 | `~/.hermes/scripts/state_guard.py` |
74|| 恢复模拟 | `~/.hermes/scripts/simulate_recovery.py` |
75|| 项目状态 | `~/.hermes/projects/{project}/PROJECT_STATE.yaml` |
76|| 恢复上下文 | `~/.hermes/projects/{project}/recovery_context.md` |
77|| HANDOFF | `~/.hermes/projects/{project}/00-HANDOFF.md` |
78|
79|## 禁止行为（硬约束）
80|
81|完成 READ-BEFORE-ACT 后，以下所有操作禁止：
82|1. 问"继续什么"
83|2. 问已经确认过的决策
84|3. 问凭证/Key/Token/Bucket/Chat ID
85|4. 问价格（除非真的缺且不是已决价格）
86|5. 问模板路径（先全局搜索）
87|6. 让用户转DWG/截图/找文件
88|7. 发现只报告不修复
89|8. 根据聊天上下文直接继续
90|
```
