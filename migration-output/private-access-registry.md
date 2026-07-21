---
title: private-access-registry
type: note
permalink: personal/newme-os/knowledge/private-access/private-access-registry
canonical_status: draft
owner: 森哥
last_verified: 2026-07-21
volatility: high
truth_source: Hermes MEMORY.md (copied verbatim — not yet re-tested)
sources:
  - MEMORY.md § Supabase
  - MEMORY.md § Linear
  - MEMORY.md § Sentry
  - MEMORY.md § Telegram
  - MEMORY.md § WeChat
  - MEMORY.md § Server
relations:
  - knowledge/company/company-profile
  - knowledge/crm/crm-core
warning: ALL entries status=unverified until tested live
---

# Private Access Registry

> **Status: unverified.** All entries below were copied from Hermes local `MEMORY.md`. They have NOT been tested live. Treat every value as a candidate for rotation, not as a known-good credential.

> **Rotation policy:** Before any credential is used in a production flow, mark `verified_at` and decide `rotation_required` (yes/no). If unsure, default `rotation_required = yes`.

## Supabase
| Field | Value |
|-------|-------|
| system | Supabase |
| project_url | vfopmpxlhwzpxqegayew.supabase.co |
| anon_key | sb_publishable_0UiLli4lUNE_pwhZ13bRfw_xH4TduY_ |
| service_role_key | sb_secret_XCMDr7rOiR2XHZEjfQQkqA_cIKG-Doj |
| pat | sbp_bbaf7 |
| source | MEMORY.md § Supabase |
| scope | newme-platform |
| status | unverified |
| verified_at | null |
| rotation_required | unknown |

## Linear
| Field | Value |
|-------|-------|
| system | Linear |
| credential_type | Personal Access Token (PAT) |
| storage_location | Tencent COS `linear.json` |
| value | NOT reproduced here — fetch at runtime from COS `linear.json` |
| source | MEMORY.md § Linear |
| scope | newme-crm project |
| status | unverified |
| verified_at | null |
| rotation_required | unknown |

## Sentry
| Field | Value |
|-------|-------|
| system | Sentry |
| credential_type | DSN (project) + AUTH_TOKEN (CI) |
| dsn | (truncated) — see MEMORY.md § Sentry; treat as sensitive, do not paste into other notes |
| auth_token_storage | GitHub Secrets |
| source | MEMORY.md § Sentry |
| scope | newme-platform CI |
| status | unverified |
| verified_at | null |
| rotation_required | unknown |

## Telegram
| Field | Value |
|-------|-------|
| system | Telegram Bot API |
| bot_handle | @newwme_1_bot |
| credential_type | Bot token |
| value | NOT reproduced here — fetch from MEMORY.md § Telegram at runtime |
| source | MEMORY.md § Telegram |
| scope | Internal dispatch (森哥 / Tanya) |
| status | unverified |
| verified_at | null |
| rotation_required | unknown |

## WeChat
| Field | Value |
|-------|-------|
| system | WeChat (iLink bot integration) |
| credential_type | account_id + token |
| value | NOT reproduced here — fetch from MEMORY.md § WeChat at runtime |
| source | MEMORY.md § WeChat |
| scope | Sync to 森哥 WeChat |
| status | unverified |
| verified_at | null |
| rotation_required | unknown |

## Server
| Field | Value |
|-------|-------|
| system | Production host |
| os | Ubuntu 22.04 |
| ssh_access_pattern | (per MEMORY.md § Server) — key-based; user/host not reproduced here |
| source | MEMORY.md § Server |
| scope | newme-crm.service host |
| status | unverified |
| verified_at | null |
| rotation_required | unknown |

## CRM Accounts
See `knowledge/company/company-profile` → "CRM User Accounts" section.
- All CRM account passwords (`tanya@newme.ae`, `ayana@newme.ae`, etc.) are listed there with status `unverified`.
- Rotation recommended; do **not** copy passwords into this registry.

## Verification Checklist
Before flipping any row's status to `verified`:
- [ ] Used the credential in the target system within the last 7 days
- [ ] Confirmed scope matches (no over-privileged key in a low-trust context)
- [ ] Recorded `verified_at` (ISO date)
- [ ] Decided `rotation_required` (yes / no / unknown)
- [ ] If `rotation_required = yes`, filed Linear ticket and tracked in TASKBOARD

## Relations
- `knowledge/company/company-profile` — CRM user accounts list
- `knowledge/crm/crm-core` — systems consuming these credentials
