# Lighthouse Baseline Report

**Project:** NewMe CRM  
**Date:** 2026-07-03  
**Auditor:** T3-2 Performance Monitoring Task  
**Environment:** Production (pending deployment)

---

## Executive Summary

This document establishes the performance baseline for NewMe CRM's critical user journeys. Baseline scores were captured using Lighthouse CI in production mode with mobile device emulation (Moto G Power).

**Note:** This baseline was created as part of T3-2 (Performance Monitoring + Web Vitals). Actual scores should be captured after deployment using the methodology below.

---

## Methodology

### Test Configuration
- **Tool:** Lighthouse CI v0.14.0 / Chrome DevTools Lighthouse
- **Device:** Moto G Power (mobile emulation)
- **Network:** Fast 3G (4Mbps down, 1.5Mbps up, 150ms RTT)
- **CPU:** 4x slowdown
- **Mode:** Production build (`next build` + `next start`)
- **Cache:** Disabled
- **Runs:** 3 per page, median score reported

### Target Thresholds (Google Core Web Vitals)

| Metric | Good | Needs Improvement | Poor |
|--------|------|-------------------|------|
| **LCP** (Largest Contentful Paint) | < 2500ms | 2500-4000ms | > 4000ms |
| **CLS** (Cumulative Layout Shift) | < 0.1 | 0.1-0.25 | > 0.25 |
| **INP** (Interaction to Next Paint) | < 200ms | 200-500ms | > 500ms |
| **FCP** (First Contentful Paint) | < 1800ms | 1800-3000ms | > 3000ms |
| **TTFB** (Time to First Byte) | < 800ms | 800-1800ms | > 1800ms |

**Note:** FID was deprecated in web-vitals v4 and replaced by INP, so the five metrics reviewed here are LCP, CLS, INP, FCP and TTFB.

---

## Critical Pages Baseline

### 1. Login Page (`/login`)

**User Journey:** First-time user authentication entry point.

| Category | Score | Target | Status |
|----------|-------|--------|--------|
| **Performance** | TBD | ≥ 90 | 🔄 Pending |
| **Accessibility** | TBD | ≥ 90 | 🔄 Pending |
| **Best Practices** | TBD | ≥ 90 | 🔄 Pending |
| **SEO** | TBD | ≥ 90 | 🔄 Pending |

**Core Web Vitals:**
- LCP: TBD ms
- CLS: TBD
- INP: TBD ms
- FCP: TBD ms
- TTFB: TBD ms

**Notes:**
- Static page, should be extremely fast
- No client-side data fetching on load
- Form validation happens client-side

---

### 2. Leads List (`/leads`)

**User Journey:** Primary CRM workspace - users spend 70%+ of time here.

| Category | Score | Target | Status |
|----------|-------|--------|--------|
| **Performance** | TBD | ≥ 85 | 🔄 Pending |
| **Accessibility** | TBD | ≥ 90 | 🔄 Pending |
| **Best Practices** | TBD | ≥ 90 | 🔄 Pending |
| **SEO** | TBD | ≥ 80 | 🔄 Pending |

**Core Web Vitals:**
- LCP: TBD ms
- CLS: TBD
- INP: TBD ms
- FCP: TBD ms
- TTFB: TBD ms

**Notes:**
- Heavy data table with filtering/sorting
- Uses `useSupabaseQuery` with 8s timeout + retry
- Kanban view with drag-and-drop (`usePipelineDragDrop`)
- Stage transition validation (`useStageGuard`)
- **Expected bottleneck:** Initial data fetch (50-100 leads)

---

### 3. Lead Detail (`/leads/[id]`)

**User Journey:** Deep dive into individual lead - high-value interaction.

| Category | Score | Target | Status |
|----------|-------|--------|--------|
| **Performance** | TBD | ≥ 80 | 🔄 Pending |
| **Accessibility** | TBD | ≥ 90 | 🔄 Pending |
| **Best Practices** | TBD | ≥ 90 | 🔄 Pending |
| **SEO** | TBD | ≥ 80 | 🔄 Pending |

**Core Web Vitals:**
- LCP: TBD ms
- CLS: TBD
- INP: TBD ms
- FCP: TBD ms
- TTFB: TBD ms

**Notes:**
- **P0-1 Fix Applied:** Parallel data fetching (was 2.1 min / 431 requests, now < 5s / < 50 requests)
- 8 parallel Supabase queries via `Promise.all`
- Skeleton loading states for all sections
- Activity feed with infinite scroll
- **Expected bottleneck:** Contact info + activity history

---

### 4. Pipeline Board (`/pipeline`)

**User Journey:** Visual sales pipeline - drag-and-drop stage management.

| Category | Score | Target | Status |
|----------|-------|--------|--------|
| **Performance** | TBD | ≥ 85 | 🔄 Pending |
| **Accessibility** | TBD | ≥ 90 | 🔄 Pending |
| **Best Practices** | TBD | ≥ 90 | 🔄 Pending |
| **SEO** | TBD | ≥ 80 | 🔄 Pending |

**Core Web Vitals:**
- LCP: TBD ms
- CLS: TBD
- INP: TBD ms
- FCP: TBD ms
- TTFB: TBD ms

**Notes:**
- Kanban board with 6 stages
- Drag-and-drop via `usePipelineDragDrop` hook
- Stage guard validation via `useStageGuard`
- Progress bar + stats visualization
- **Expected bottleneck:** Initial render (6 columns × 20-30 cards)

---

## How to Update This Baseline

### Option 1: Manual Lighthouse (Chrome DevTools)

1. Start production server:
   ```bash
   cd /home/ubuntu/newme-platform
   npm run build
   npm run start
   ```

2. Open Chrome DevTools (F12) → Lighthouse tab

3. Select options:
   - Device: Mobile
   - Categories: All (Performance, Accessibility, Best Practices, SEO)
   - Simulated throttling: Checked
   - Clear storage: Checked

4. Click "Analyze page load"

5. Copy scores and metrics to the tables above

6. Repeat for each critical page

### Option 2: Lighthouse CI (Automated)

1. Install Lighthouse CI:
   ```bash
   npm install -g @lhci/cli
   ```

2. Create `.lighthouserc.json`:
   ```json
   {
     "ci": {
       "collect": {
         "url": [
           "http://localhost:3000/login",
           "http://localhost:3000/leads",
           "http://localhost:3000/leads/1",
           "http://localhost:3000/pipeline"
         ],
         "numberOfRuns": 3,
         "startServerCommand": "npm run start",
         "startServerReadyPattern": "Ready in"
       },
       "assert": {
         "preset": "lighthouse:recommended",
         "assertions": {
           "largest-contentful-paint": ["warn", { "maxNumericValue": 2500 }],
           "cumulative-layout-shift": ["warn", { "maxNumericValue": 0.1 }],
           "interaction-to-next-paint": ["warn", { "maxNumericValue": 200 }],
           "first-contentful-paint": ["warn", { "maxNumericValue": 1800 }]
         }
       }
     }
   }
   ```

3. Run Lighthouse CI:
   ```bash
   lhci autorun
   ```

4. Results will be in `.lighthouseci/` directory

---

## Monitoring & Alerting

**No real-user metrics are collected.** Client-side Web Vitals collection and the
PostHog integration that received it were removed on 2026-08-20: the project key was
dead at the provider, so every authenticated page load spent two failed requests on
remote config, and the same integration had session replay configured with
`maskAllInputs: false` and an empty `maskTextSelector` on a CRM whose forms carry
customer names, phone numbers and payment amounts. It produced no data and would have
exfiltrated PII the day it started to.

So the thresholds in this document are a **review baseline, measured on demand** with
the Lighthouse commands above, not a live dashboard.

**Sentry is the only other browser-side sink, and it is inert rather than absent.**
`sentry.client.config.ts` initialises the browser SDK, and `browserTracingIntegration`
is a *default* integration of `@sentry/nextjs`, so with a DSN present it would collect
real-user transactions and their performance measurements at `tracesSampleRate: 0.1`.
That is real-user monitoring whatever it is called. It sends nothing today because
`NEXT_PUBLIC_SENTRY_DSN` is unset: it is absent from the production runtime
environment, and because `NEXT_PUBLIC_*` values are inlined at build time the deployed
client bundle was checked too — no DSN-shaped string appears anywhere under
`.next/static` (measured 2026-08-20). Setting that one variable turns real-user
monitoring back on, so the paragraph below applies to it as much as to any new sink.
Server-side error and trace reporting is separate and unaffected.

Session replay was never enabled here despite two `replays*SampleRate` settings: replay
is not a default integration and nothing added it. That dead configuration was removed
on 2026-08-20 rather than left to read as "replay is on at 10%".

Re-introducing real-user monitoring is a decision with a privacy review attached, not
a dependency install. Whatever the sink, three things have to hold: masking on by
default, an origin added to the CSP in `next.config.ts` (the browser quality gate
counts every CSP violation as a console error and refuses the release), and the origin
allow-listed in `scripts/run-postdeploy-browser-uat.mjs`, which blocks every origin it
does not know. Allow-listed, not stubbed: an edge-injected tag arrives with an
`integrity` attribute, and an empty stub body fails that digest, which Chromium reports
as a console error just the same.

---

## Performance Improvement Roadmap

### Immediate (Next Sprint)
- [ ] Capture actual baseline scores after deployment
- [ ] Decide whether real-user monitoring returns, and under which privacy review
- [ ] Configure alerts for threshold violations

### Short-term (1-2 Months)
- [ ] Optimize images (WebP/AVIF, responsive sizing)
- [ ] Implement route-level code splitting
- [ ] Add `next/image` with priority loading for LCP elements
- [ ] Preload critical fonts

### Long-term (3-6 Months)
- [ ] Implement edge caching for static assets
- [ ] Move to ISR (Incremental Static Regeneration) for public pages
- [ ] Add service worker for offline-first experience
- [ ] Implement predictive prefetching for common user flows

---

## Appendix: Test Scripts

### Quick Local Test

```bash
# Build production
npm run build

# Start server
npm run start &

# Run Lighthouse on all critical pages
for url in "http://localhost:3000/login" "http://localhost:3000/leads" "http://localhost:3000/leads/1" "http://localhost:3000/pipeline"; do
  echo "Testing $url..."
  lighthouse $url --output=json --output-path="./lighthouse-$(basename $url).json"
done

# Kill server
pkill -f "next start"
```

### Continuous Integration

Add to `.github/workflows/lighthouse.yml`:

```yaml
name: Lighthouse CI
on: [push]
jobs:
  lighthouse:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run build
      - run: npm install -g @lhci/cli
      - run: lhci autorun
      - uses: actions/upload-artifact@v4
        with:
          name: lighthouse-results
          path: .lighthouseci/
```

---

**Document Version:** 1.0  
**Last Updated:** 2026-07-03  
**Next Review:** After production deployment + 1 week of data collection
