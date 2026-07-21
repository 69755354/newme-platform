---
title: crm-core
type: note
permalink: personal/newme-os/knowledge/crm/crm-core
canonical_status: active
owner: 森哥
last_verified: 2026-07-21
volatility: high
truth_source: TASKBOARD.md + production incident log + repo HEAD
sources:
  - newme-platform repo
  - TASKBOARD.md
  - Hermes MEMORY.md (incidents section)
relations:
  - knowledge/company/company-profile
  - knowledge/private-access/supabase
  - TASKBOARD.md
  - knowledge/crm/crm-incident-log
supersedes: MEMORY.md § CRM (credential-bearing version)
---

# CRM Core — NewMe CRM System

> **Scope note:** This file holds **stable architecture + current state + history only**. All credentials live in `knowledge/private-access/`. If you find a key, token, or DSN here, it is a defect — remove it.

## 1. Stable Architecture

### 1.1 Stack
| Layer | Technology |
|-------|-----------|
| Frontend | Next.js (App Router) — see note below on `next.config.ts` |
| Backend | Next.js Route Handlers / Server Actions + Supabase Edge Functions |
| Database | Supabase Postgres (project: vfopmpxlhwzpxqegayew) |
| Auth | Supabase Auth |
| Storage | Supabase Storage + Tencent COS (for drawings / heavy assets) |
| Issue tracking | Linear (newme-crm project) |
| Error monitoring | Sentry |
| Hosting | Ubuntu 22.04 server (systemd: `newme-crm.service`) |

### 1.2 Repository
- Name: `newme-platform`
- Owner: 森哥
- Local path: `/home/ubuntu/newme-platform`

### 1.3 `next.config.ts` — Status
它是仓库中的**生产影响配置文件**。修改必须经过明确的生产风险审核。
（**Not** "不是源码" — this prior wording was incorrect and caused an under-gated
edit. Treat config changes with the same review gravity as source edits.)

### 1.4 Core Domains
| Domain | Description |
|--------|-------------|
| `leads` | Lead capture, qualification, assignment |
| `contracts` | Contract lifecycle: draft → countersign → active |
| `payments` | Payment milestones linked to contracts |
| `quotations` | Quote generation, versioning, approval |

### 1.5 Deploy Gate Design
- Push to `main` → CI must pass → tag → `scripts/deploy.sh` → Step 0 runs `scripts/check-taskboard.sh` → any ❌ aborts.
- Pre-push hook blocks pushes with open ❌ items. `--no-verify` bypass is logged and must be reviewed post-hoc.
- Production deploys require a TASKBOARD line transitioning ❌ → ✅.

## 2. Current Production State

> The fields below must be re-read at start of every task. Do not trust this section from memory — verify against `TASKBOARD.md`, `git log`, and `systemctl status`.

### 2.1 Service Status
| Field | Value | last_verified |
|-------|-------|---------------|
| Service unit | `newme-crm.service` | 2026-07-21 |
| Host | Ubuntu 22.04 server | 2026-07-21 |
| Process state | TBC — run `systemctl status newme-crm.service` | unverified |
| Reverse proxy | TBC | unverified |

### 2.2 Latest Deploy
| Field | Value | last_verified |
|-------|-------|---------------|
| Repo HEAD SHA | TBC — run `git rev-parse HEAD` | unverified |
| Last deploy timestamp | TBC — see `scripts/deploy.sh` log | unverified |
| Deployer | TBC | unverified |

### 2.3 Active Issues
- See `TASKBOARD.md` for authoritative ❌ items.
- See Linear `newme-crm` project for issue-level detail.

## 3. Historical Events

### 3.1 `newme-crm.service` Incident
- Symptom: service crashed / failed to restart cleanly during a deploy.
- Root cause class: unverified — was historically attributed to env / path drift.
- Lesson: after every deploy, `systemctl status` must be explicitly captured into the run log; deploy is not "done" until service is `active (running)`.

### 3.2 SAM-51 Observations
- Tracker: Linear SAM-51.
- Observations: (placeholder — details to be migrated from MEMORY.md incident log when located)
- Status: **unverified** — facts must be re-confirmed before being treated as current.

### 3.3 Deploy Accidents
- Pattern: deploys that proceeded with open ❌ items in TASKBOARD introduced regressions.
- Countermeasure: deploy-gate (§1.5) added; pre-push hook added.
- Residual risk: `--no-verify` bypass remains possible; audit log is the safety net, not prevention.

## 4. Credentials — NOT in this file
All credentials (Supabase keys, PATs, Sentry DSN, Telegram bot token, WeChat bot token, SSH access patterns) live in `knowledge/private-access/`:
- Supabase → `knowledge/private-access/supabase`
- Linear  → `knowledge/private-access/linear`
- Sentry  → `knowledge/private-access/sentry`
- Telegram → `knowledge/private-access/telegram`
- WeChat → `knowledge/private-access/wechat`
- Server / SSH → `knowledge/private-access/server`

**If you added credential content to this section, you have a bug. Delete it and
link to private-access instead.**

## 5. Relations
- `knowledge/company/company-profile` — who runs this system
- `knowledge/private-access/` — all credentials
- `TASKBOARD.md` — current ❌ / ✅ state of work
- `knowledge/crm/crm-incident-log` — chronological incident record (TBC creation)
