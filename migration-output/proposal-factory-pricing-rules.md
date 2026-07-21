---
title: proposal-factory-pricing-rules
type: note
permalink: personal/newme-os/knowledge/smart-home/proposal-factory-pricing-rules
canonical_status: draft
owner: 森哥
last_verified: 2026-07-21
volatility: high
truth_source: UAE KNX distributor pricing 2026 (Infinitex, Cache.ae) + DEWA 2026 rules
sources:
  - /home/ubuntu/.hermes/knowledge/01-design-rules/uae-knx-distributor-pricing-2026.md
  - /home/ubuntu/.hermes/knowledge/01-design-rules/dewa-2026-electrical-rules.md
  - /home/ubuntu/.hermes/knowledge/01-design-rules/knx-design-rules-consolidated.md
relations:
  - proposal-factory-index
  - proposal-factory-business-rules
  - smart-home-design-principles
---

# Proposal Factory — Pricing Rules (UAE 2026)

> **Volatility = high.** Distributor pricing and DEWA fee structure change quarterly. Before any client-facing quote, verify current distributor list price against Infinitex / Cache.ae live data.
> **All values below are AED.** Internal cost never appears on the client sheet.

## 1. Distributors (UAE 2026)
| Distributor | Brands | Notes |
|-------------|--------|-------|
| **Infinitex** | Optimus (KNX) | Primary KNX distributor |
| **Cache.ae** | 1Home, CoolAuto, PolarBear | Multi-brand aggregator; pricing varies by SKU tier |

> Exact per-SKU AED pricing → `~/.hermes/knowledge/01-design-rules/uae-knx-distributor-pricing-2026.md`. This file references; it does **not** reproduce the price table (volatility).

## 2. Device Markup Rules
| Tier | Brands | Client-Facing Markup |
|------|--------|----------------------|
| A (premium) | ABB, Gira, Theben, SONOS top SKU | (per distributor list × project markup; confirmed by 森哥 per project) |
| B (mid) | MDT, Citron, 1Home, CoolAuto | (per project — value-engineering scenarios) |
| C (budget) | PolarBear, Creatrol 24G | (only when client opts in) |

**Hard rules:**
- Client-facing price = distributor list price × markup.
- Internal cost (cost-to-NewMe) NEVER appears on the client sheet (`内部成本泄漏` trigger).
- Markup is project-decided — record the chosen multiplier in `PROJECT_STATE.yaml.confirmed_decisions`.

## 3. Installation / Labor Estimates
| Labor Component | Basis |
|-----------------|-------|
| Installation (Install 10%) | Flat 10% of (equipment + base installation) — see `proposal-factory-business-rules` §1 |
| Programming (Program 5%) | Flat 5% of (equipment + base installation) |
| Design (Design 10%) | Flat 10% of (equipment + base installation) |

The 10/10/5 fee structure is the canonical UAE labor estimate. Deviations are project-specific exceptions; record them as a confirmed decision.

## 4. DEWA Compliance Cost Factors
DEWA (Dubai Electricity & Water Authority) drives several hard cost lines. Reference: `~/.hermes/knowledge/01-design-rules/dewa-2026-electrical-rules.md`.
| Factor | Cost Impact | Notes |
|--------|-------------|-------|
| Official load calculation submission | Fixed fee per submission | Required before energization |
| TN-S grounding upgrade | Material + labor | Mandatory; do not quote TN-C |
| Smart meter / IoT distribution panel | Per-panel equipment cost | Required for new builds ≥ threshold |
| Energy efficiency reporting | Reporting cost | Required at handover |
| MCB + RCD per DEWA spec | Per-circuit component cost | Affects BOQ row count |
| KNX Secure compliance audit | Audit cost | See `smart-home-scene-rules` |

> **Do NOT estimate DEWA fees from this table.** Verify against current DEWA 2026 schedule before any client quote.

## 5. Brand Selection Defaults (per project tier)
| Project Profile | Default Brand Stack |
|-----------------|---------------------|
| Tier-A villa (Palm, Pennaz-class ~1000+ sqm) | ABB KNX + Theben sensors + SONOS top SKU + ABB SV/S 30.640.5 PSU |
| Tier-B villa (Ibrahim-class ~770 sqm) | MDT + Theben/MDT sensors + SONOS mid + ABB PSU |
| Tier-C / value engineering | PolarBear/Creatrol only on client opt-in; structure remains KNX |

## 6. PSU Sizing (impacts equipment cost)
| PSU | Capacity | Use Case |
|-----|----------|----------|
| ABB SV/S 30.640.5 | 640mA | Standard — one per KNX line |
| Derating (GCC 55°C) | ~576mA effective | Recommended load 70% → 403mA → ~40 devices |

See `smart-home-design-principles` for full PSU sizing rules.

## 7. Pricing Verification Checklist (pre-quote)
Before a quotation leaves DRAFT:
- [ ] Distributor list prices re-checked against Infinitex / Cache.ae within the last 30 days
- [ ] DEWA fee schedule re-checked within the last 90 days
- [ ] 10/10/5 fee structure applied uniformly across all sections
- [ ] No internal cost value on client sheet
- [ ] Markup multiplier recorded in `PROJECT_STATE.yaml.confirmed_decisions`
- [ ] Currency = AED throughout

## 8. Relations
- `proposal-factory-index`
- `proposal-factory-business-rules` (10/10/5 enforcement)
- `smart-home-design-principles` (PSU sizing / topology)
- Source of truth: `~/.hermes/knowledge/01-design-rules/uae-knx-distributor-pricing-2026.md`
- Source of truth: `~/.hermes/knowledge/01-design-rules/dewa-2026-electrical-rules.md`
