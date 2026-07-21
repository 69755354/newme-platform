# P0 Infrastructure + Business Rules — Content Generation

Generate ALL markdown files to `/tmp/migration-batch-p0-next/`. Do NOT write to any database or API.

## Universal Metadata (EVERY file)

```yaml
canonical_status: active | draft | disputed
owner: 森哥
last_verified: 2026-07-21
volatility: low | medium | high
truth_source: <origin>
source_paths: [list]
knowledge_class: company_standard | working_assumption | regulatory_requirement
verification_status: unverified | partial | verified
supersedes: <previous>
relations: [list]
```

Rule: If a claim has no primary source → working_assumption + unverified. Never write "mandatory" without regulation cite.

---

## PART A: Infrastructure (7 files)

Create `knowledge/infrastructure/` files:

### A1. index.md — Infrastructure overview + navigation to all 6 sub-files

### A2. production-server.md
From MEMORY.md + server inspection:
- Ubuntu 22.04, kernel 6.8.0-101-generic
- Hermes Gateway (systemd services)
- newme-platform.service (port 3001)
- hermes-bridge.service, hermes-dashboard.service, hermes-worker.service
- SSH access pattern, user: ubuntu
- Disk/memory: what's known from server
- All values: verification_status = partial unless confirmed by live inspection

### A3. deployment-architecture.md
From MEMORY.md + newme-rules skill:
- Deploy: `sudo -E scripts/deploy.sh` (NOPASSWD)
- Deploy Gate v3: SHA-bound preflight
- Release chain: SAM-6 → SAM-28 → SAM-12
- `next.config.ts` = production-impacting config
- TASKBOARD.md gate enforcement
- Git workflow: branch, push, CI, deploy
- Rollback mechanism (36 memory rollback snapshots)
- Separate current policies from historical incidents (link to incidents/crm-incidents)

### A4. observability.md
From MEMORY.md + SAM-51 context:
- Pino → stdout → journald (Phase 1 done)
- Sentry Cron + Release Tracking active
- instrumentation.ts disabled (Turbopack, do not retry)
- Scripts at /opt/hermes-scripts/observability/ (7 scripts)
- Cron intervals: 5min/10min
- llm-cost-ledger.jsonl (33MB, unbounded growth)
- Log rotation (7 generations)
- State.db 1.2GB (unknown content)
- Mark what's production vs what's experimental

### A5. external-services.md
From MEMORY.md + private-access:
- Supabase: project URL, connection pattern
- Linear: API via PAT in COS
- Sentry: DSN pattern, AUTH_TOKEN in GitHub Secrets
- Tencent COS: qcloud CLI, backup pattern
- Telegram Bot API: @newwme_1_bot
- WeChat iLink Bot API: ilinkai.weixin.qq.com
- Basic Memory Cloud: personal/newme-os
- For each: purpose, access method, credential location → private-access/registry
- Do NOT copy credential values — link to registry

### A6. backup-and-recovery.md
From MEMORY.md + scripts:
- COS backup (auto-backup-to-cos.sh)
- Rollback snapshots (36 for memory operations)
- Session backups (state.db, sessions/)
- Config backups (config.yaml.bak-*)
- Recovery procedures if known
- What's automated vs manual
- All procedural claims: company_standard (NewMe practice)

### A7. security-boundaries.md
From SOUL.md + CORE_RULES:
- Coding gate: OC/GLM-5.2 writes, v4-pro only plans
- Deploy gate chain
- next.config.ts protection
- TASKBOARD gate
- Credential scope: BM Cloud only, never GitHub
- Multi-channel isolation (Source Channel rule)
- Agent authority boundaries (L3)
- Separate current policies from historical incidents

---

## PART B: Business Rules (7 files)

Create `knowledge/commercial/` files:

### B1. index.md — Commercial overview + navigation

### B2. contracts.md
From MEMORY.md + CRM domain knowledge:
- Contract creation flow
- Approval chain (admin_review step)
- Contract number format (NEW-YYYYMMDD-NNN)
- Status lifecycle (draft → pending → approved → archived)
- Duplicate prevention (one active contract per lead)
- Installment plans structure
- Distinguish company_policy from CRM implementation detail

### B3. payment-terms.md
From MEMORY.md + CRM:
- First payment due date handling
- Payment status: unpaid/partial/paid
- Installment plan structure
- Payment allocation (allocate endpoint)
- Payment confirmation flow
- Distinguish policy from CRM mechanics

### B4. quotation-policy.md
From proposal-factory business-rules + MEMORY.md:
- 10/10/5 fee structure (note: calculation base disputed)
- Currency: AED only
- Tier-based pricing (A/B/C)
- Internal cost never on client sheet
- Boundary room adjudication policy
- Link to proposal-factory for detailed rules
- ⚠️ Mark disputed values explicitly

### B5. delivery-conditions.md
From proposal-factory + MEMORY.md:
- What constitutes "delivery-ready"
- Pennaz V3→V4 checklist as canonical pre-delivery standard
- PPT/Excel acceptance criteria
- Visual QA requirement
- COS deliverable storage
- Client handoff process (if documented)
- Mark what's company_policy vs single-project precedent

### B6. app-commercial-model.md
From knowledge base + projects:
- NewMe app/service pricing (if any)
- SaaS model (if applicable)
- Free/paid tiering
- This may be mostly working_assumption — mark accordingly

### B7. staffing-and-operations.md
From company-profile + MEMORY.md:
- Current team structure (7 confirmed)
- Roles and responsibilities
- CRM account mapping (note: may not be 1:1)
- Contractor vs employee distinction (外包)
- Decision authority: 森哥 = final, Tanya = operations
- All team info: last_verified date
- Mark historical team structures as superseded

---

## Key Rules

1. Distinguish: current_policy vs project_exception vs historical_case vs regulatory vs working_assumption
2. Every file: unified 10-field metadata
3. No credential values in knowledge files → link to private-access/registry
4. No copying large tables from other BM Cloud notes → cross-reference with relations
5. Mark all unverifiable claims as working_assumption + unverified
6. Produce clean, structured markdown (tables for data, ## for sections)
