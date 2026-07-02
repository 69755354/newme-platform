# Audit Report: Commit 2613042 — T3-2 性能监控 + Web Vitals Baseline

**Date:** 2026-07-03
**Auditor:** Hermes Agent
**Commit:** 2613042 [GLM-CP] T3-2: 性能监控 + Web Vitals baseline
**Verdict:** ❌ FAIL (4 issues: 2 significant, 2 documentation)

---

## Issues

### 🔴 ISSUE-1: Double Capture — Web Vitals events sent twice

**Severity: HIGH** | **Files:** `src/lib/posthog-provider.tsx:41`, `src/lib/web-vitals.ts`

`posthog-provider.tsx` enables PostHog's built-in Web Vitals auto-capture via `capture_performance: true`.
Simultaneously, the custom `web-vitals.ts` module manually collects the same 5 metrics
(onCLS/onFCP/onINP/onLCP/onTTFB) and sends them via `posthog.capture("web_vital", ...)`.

**Impact:** Double event volume to PostHog (billing/quota), duplicate counting in analytics,
two different event formats coexisting (`$web_vitals` built-in vs `web_vital` custom).

**Fix:** Choose one:
- Option A: Remove `capture_performance: true`, keep custom `web-vitals.ts`
- Option B (recommended): Keep `capture_performance: true`, delete `web-vitals.ts` + `WebVitalsReporter.tsx`

---

### 🟡 ISSUE-2: Event name & property mismatch between code and docs

**Severity: MEDIUM** | **Files:** `src/lib/web-vitals.ts:13`, `docs/lighthouse-baseline.md:227-261`

| Aspect | Code (web-vitals.ts) | Documentation (lighthouse-baseline.md) |
|--------|---------------------|---------------------------------------|
| Event Name | `web_vital` (singular) | `web_vitals` (plural) |
| Metric name prop | `name` | `metric_name` |
| Value prop | `value` | `metric_value` |
| Rating prop | `rating` | `metric_rating` |
| Delta prop | `delta` | *(not documented)* |
| ID prop | `id` | *(not documented)* |
| Navigation prop | `navigation_type` | *(not documented)* |
| Page path | *(not sent)* | `page_path` |
| Page URL | *(not sent)* | `page_url` |

**Impact:** PostHog dashboards built per documentation will return zero results.

---

### 🟡 ISSUE-3: Documentation still references deprecated FID metric

**Severity: LOW** | **Files:** `docs/lighthouse-baseline.md` lines 35, 40, 60, 85, 111, 137

Doc mentions FID (First Input Delay) in multiple places including:
- Line 35: FID threshold table row
- Line 40: "Our monitoring tracks both for backward compatibility" — contradicts actual code
- Lines 60, 85, 111, 137: "FID: TBD ms" in per-page Core Web Vitals

Code correctly uses only `onINP` (web-vitals v5 removed `onFID`).

**Fix:** Mark FID as "(deprecated, replaced by INP)" or remove.

---

### 🟢 ISSUE-4: All baseline scores are TBD

**Severity: INFO** | **File:** `docs/lighthouse-baseline.md`

All 4 critical pages have "TBD" scores. Understandable pre-deployment, but document
title "Baseline Report" implies data exists. Consider renaming to "Baseline Template".

---

## Passing Checks

| Check | Status | Detail |
|-------|--------|--------|
| web-vitals v5 API usage | ✅ PASS | onCLS/onFCP/onINP/onLCP/onTTFB — no onFID |
| Dependency version | ✅ PASS | `web-vitals: ^5.3.0`, installed v5.3.0 confirmed |
| SSR safety | ✅ PASS | `"use client"` + dynamic `import()` in WebVitalsReporter |
| PHProvider context | ✅ PASS | WebVitalsReporter inside `<PHProvider>` (layout.tsx:25) |
| TypeScript type safety | ✅ PASS | `type Metric` import, no TS compilation errors |
| Component renders null | ✅ PASS | Zero visual overhead |
| useEffect single execution | ✅ PASS | Empty deps `[]`, registers observers once on mount |
| Performance impact | ✅ PASS | Passive PerformanceObserver callbacks, negligible overhead |

---

## Files Reviewed
- `src/lib/web-vitals.ts` — Web Vitals collection logic
- `src/lib/WebVitalsReporter.tsx` — Client component wrapper
- `src/lib/posthog-provider.tsx` — PostHog initialization (has capture_performance: true)
- `src/app/layout.tsx` — Component placement in tree
- `docs/lighthouse-baseline.md` — Baseline documentation
- `package.json` — web-vitals dependency version

## Files Modified
None (audit only)
