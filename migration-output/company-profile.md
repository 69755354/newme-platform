---
title: company-profile
type: note
permalink: personal/newme-os/knowledge/company/company-profile
canonical_status: active
owner: 森哥
last_verified: 2026-07-21
volatility: medium
truth_source: 森哥 direct confirmation
sources:
  - MEMORY.md (Hermes local)
  - 森哥 verbal confirmation 2026-07-21
relations:
  - knowledge/user/user-profile
  - knowledge/private-access/
  - knowledge/crm/crm-core
supersedes: MEMORY.md § Team / § CRM Accounts (conflated version)
---

# Company Profile — NewMe Smart Home

## Identity
- Company: NewMe Smart Home FZCO
- Business: 高端智能家居设计 + 施工（KNX/DALI/Matter）
- Market: 迪拜（Dubai, UAE）
- Owner: 森哥

## Current Operating Team (last_verified: 2026-07-21)
| Name | Role | Status |
|------|------|--------|
| 森哥 | Owner | Active |
| Tanya | — | Active |
| Mohamed | — | Active |
| Ayana | — | Active |
| Sai Krishna | — | Active |
| Saif | — | Active |
| 外包团队 | 编程 | Active |

> Roles marked `—` are unverified. Do not infer responsibilities from CRM role labels.

## CRM User Accounts
These are SYSTEM accounts — may not map 1:1 to operating team.
| Email | Password | Role | verified |
|-------|----------|------|----------|
| tanya@newme.ae | [REDACTED — round-4 A0] | Boss | unverified |
| ayana@newme.ae | [REDACTED — round-4 A0] | Operator | unverified |
| mohamed@newme.ae | — | Sales | unverified |
| faheem@newme.ae | — | Sales | unverified |
| assem@newme.ae | — | Sales | unverified |
| dev@newme.ae | — | Admin | unverified |
| sam@newme.ae | — | Admin | unverified |

> Credentials are weak / shared-looking and **must not** be reused as authoritative. Password rotation recommended; see `knowledge/private-access/` for verified credential set.

## Historical / Unverified
Previous MEMORY.md listed 7-person team (Boss/Sales×3/Admin×2/Operator×1).
This may be outdated. Do not treat as current fact without re-verification.

## Production Systems
| System | Purpose | Canonical Status |
|--------|---------|------------------|
| Supabase | Postgres + Auth + Storage for CRM | active (project: vfopmpxlhwzpxqegayew) |
| Linear | Issue tracking (newme-crm project) | active |
| GitHub | Source control (newme-platform) | active |
| Sentry | Error monitoring | active |
| Tencent COS | Asset & artifact storage (drawings, templates, deliverables) | active |
| BM Cloud | Knowledge base / personal notes | active |

> All credentials → `knowledge/private-access/`. This file intentionally contains **no** keys or tokens.

## Communication Channels
| Channel | Handle / Endpoint | Purpose | verified |
|---------|-------------------|---------|----------|
| Telegram | @newwme_1_bot | Internal / 森哥 dispatch | unverified |
| WeChat | iLink bot | Sync to 森哥 WeChat | unverified |
| WhatsApp | — | TBC | unverified |
| Email | tanya@newme.ae (primary CRM user) | Sales inbound | unverified |
| Linear comments | newme-crm project | Engineering async | active |
| GitHub Issues / PRs | newme-platform repo | Engineering review | active |

> Full bot tokens / chat IDs / account_id → `knowledge/private-access/`.

## Business Lines
1. Smart Home — KNX 智能家居设计、报价、施工
2. CRM — 销售管理、合同、付款、报价全流程
3. Industry Intelligence — 竞品追踪、市场研究、AI 动态

## Relations
- `knowledge/user/user-profile`
- `knowledge/private-access/` (for credentials)
- `knowledge/crm/crm-core`
