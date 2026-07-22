# NewMe CRM System Stability Audit

**Date:** 2026-07-22  
**Audit base:** `main` at `4905460`  
**Auditor:** ChatGPT  
**Target:** a clean, stable, production-grade CRM before further feature expansion

## Executive decision

**Overall status: NO-GO for unrestricted feature development.**

The core product is recoverable and does not require a rewrite, but several cross-cutting defects remain in security, deployment reproducibility, transaction integrity, authentication/session handling, production acceptance, and engineering gates. P0/P1 remediation must be completed and independently verified before the system is treated as stable.

The 2026-07-22 13:00 production stop remains an open incident. The forensic system can identify the next signal sender or self-exit, but the original trigger has not been proven. This audit does not convert that hypothesis into a root cause.

## Audit methodology and sources

Directly inspected:

- GitHub repository `69755354/newme-platform`, including recent commits and critical source/scripts.
- Current Linear issues related to auth, deployment, security, health, and regression testing.
- Live Supabase project `vfopmpxlhwzpxqegayew` security and performance advisors.

Primary areas reviewed:

- credentials and test artifacts;
- deployment and rollback paths;
- authentication/session boundaries;
- middleware/proxy availability and authorization behavior;
- critical CRM mutations and transaction consistency;
- CI, static gates, lint debt, smoke and regression tests;
- health/readiness/error reporting;
- live database privileges, RLS and function security;
- database performance debt;
- Linear/Git state consistency.

Server-only claims from DeepSeek or Hermes are not treated as confirmed unless independently supported by Git, Supabase, or durable raw evidence. The ongoing 13:00 incident remains open.

---

# P0 — must be resolved first

## P0-1 — Hardcoded real-account credentials in the repository

### Evidence

`e2e/auth.setup.ts` contains hardcoded, real-looking NewMe account emails and passwords. The same file also embeds a project URL and key. `.gitignore` does not explicitly ignore Playwright storage-state and result artifacts such as `e2e/.auth/`, traces, screenshots, or `e2e-results.json`.

### Risk

- Credentials remain compromised even after the file is edited because they exist in Git history.
- Future Playwright storage-state files can leak live session tokens.
- Test code can accidentally authenticate against production.

### Required remediation

1. Rotate every credential present in repository history immediately.
2. Remove all literal credentials from source and load dedicated test credentials from CI/secret storage.
3. Use non-human, least-privileged test accounts and a non-production test environment where possible.
4. Add secret scanning and explicit ignores for Playwright auth state/results/traces.
5. Add a regression gate that rejects credential-like literals and tracked auth-state files.

### Acceptance

- Old credentials no longer authenticate.
- No password/session token is present in current Git or newly generated artifacts.
- CI E2E uses secret-backed dedicated accounts.
- Secret scan is enforced on every PR.

---

## P0-2 — Two conflicting deployment systems and non-reproducible releases

### Evidence

`package.json` maps `npm run deploy` to `scripts/deploy.sh`, while production work uses `scripts/deploy-immutable.sh`.

The legacy `deploy.sh`:

- builds in a worktree with `npm install --ignore-scripts` rather than `npm ci`;
- stops production and copies `.next` in place;
- can use `fuser -k 3001/tcp`;
- validates only `/` status;
- rolls back `.next` without restoring an exactly matching dependency/config set.

The nominal immutable deploy script:

- builds in the source repository;
- links every release to mutable `shared/node_modules`;
- copies `.env.local` into each release;
- repairs broken Turbopack symlinks after build;
- uses a non-atomic check-then-write lock file;
- accepts candidate route responses other than connection failure, meaning HTTP 500/404/401 can pass candidate smoke;
- validates production mainly through health/build identity, not real authenticated business behavior;
- reads `version` during rollback validation although the health response exposes `release`;
- retains broad stale-port cleanup with `fuser -k 3002/tcp`;
- suppresses cleanup errors in the EXIT trap.

### Risk

- Identical Git SHAs can behave differently over time because dependencies are shared and mutable.
- CI and production do not execute against equivalent dependency trees.
- A broken candidate can pass smoke and be switched live.
- Rollback can be reported as failed or can restore a mismatched artifact/dependency combination.
- Operators can accidentally invoke the unsafe legacy path.

### Required remediation

1. Establish one authoritative deploy entry point; remove or hard-disable the legacy path.
2. Build a self-contained release from lockfile-pinned dependencies (`npm ci`) in an isolated workspace/container.
3. Do not share mutable `node_modules` across releases.
4. Do not copy plaintext secrets into every release; inject through a controlled runtime environment.
5. Replace lock-file check/write with atomic `flock` or equivalent.
6. Require expected status/body for each candidate probe; 4xx/5xx must not silently pass.
7. Fix rollback identity field and verify the exact rollback SHA/build.
8. Keep candidate in an isolated process group/transient unit and prove complete cleanup without broad port kills.
9. Add deploy-script self-tests and failure-injection tests.

### Acceptance

- One documented deployment command exists.
- The same release contains immutable application and dependency artifacts.
- Candidate HTTP 500 fails before switch.
- Failed switch automatically restores the exact prior release and validates its SHA/build.
- Repeated deploy/abort/rollback leaves no 3002 listener or orphan process.

---

## P0-3 — Live Supabase privilege and RLS exposure

### Evidence from live Supabase security advisor

- `public.lead_alerts` is a `SECURITY DEFINER` view.
- Numerous functions have mutable `search_path`.
- Many `SECURITY DEFINER` functions are executable by `anon` and/or general `authenticated` roles, including operational, workflow, logging and maintenance functions. Examples include `auto_enable_rls`, `reassign_lead`, stale-lead detection, quote-number generation, stage/milestone functions, trigger functions and auth/logging functions.
- `activity_logs`, `audit_logs`, and `user_session_daily` have authenticated INSERT policies with `WITH CHECK (true)`.
- Leaked-password protection is disabled.

### Risk

- Exposed definer functions may bypass normal RLS and execute with elevated privileges.
- Mutable `search_path` creates object-resolution risk for privileged functions.
- Any authenticated user may forge audit/activity/session rows under permissive INSERT policies unless additional constraints happen to block it.
- Audit evidence cannot be trusted if clients can arbitrarily insert identity/action data.

### Required remediation

1. Inventory every `SECURITY DEFINER` view/function and document intended callers.
2. Revoke default `PUBLIC`, `anon`, and broad `authenticated` EXECUTE; grant only explicitly required functions to explicit roles.
3. Move trigger/internal functions out of exposed API schemas or make them non-callable.
4. Set immutable safe `search_path` on privileged functions and schema-qualify referenced objects.
5. Replace always-true audit/session INSERT policies with server-controlled writes or strict identity checks.
6. Add database tests for anon, sales, designer, finance, operator, admin and boss permissions.
7. Enable leaked-password protection after assessing user impact.
8. Make security advisor errors/warnings a tracked deployment gate with an explicit reviewed allowlist.

### Acceptance

- Anonymous callers cannot execute internal/maintenance/trigger functions.
- Authenticated users cannot forge another user's audit/session records.
- Every definer object has an owner, purpose, caller set, fixed search path and automated authorization test.
- Supabase security advisor has no unreviewed ERROR and no untracked high-risk WARN.

---

## P0-4 — Critical lead mutations are non-transactional client-side workflows

### Evidence

`src/app/(dashboard)/leads/_hooks/useLeadMutations.ts` directly performs critical Supabase writes from the browser.

Examples:

- Lead reassignment creates event/history/activity records and updates the lead in separate calls; some errors are ignored.
- Stage change closes quotations before the optimistic lead-stage update. If the stage update fails, quotation state may already be changed.
- Activity, event and notification writes are separate best-effort operations.
- Delete and other rules rely heavily on UI checks plus distributed RLS behavior.

The existing Supabase boundary allowlist explicitly tolerates a large volume of direct client database access, so the gate prevents only new findings rather than eliminating the class.

### Risk

- Partial failure creates contradictory lead, quotation, history and audit data.
- Client-side business rules are bypassable.
- Retries can duplicate side effects.
- Audit history may claim an operation happened when the primary write failed, or vice versa.

### Required remediation

1. Move critical workflows to server-side transactional RPC/API boundaries.
2. Make stage transition, quotation closure, event creation and task/notification effects atomic or explicitly outboxed/idempotent.
3. Make reassignment atomic with authorization, transfer history and audit identity.
4. Return typed conflict/authorization/infrastructure errors.
5. Reduce the direct-client boundary allowlist toward zero for critical writes.
6. Add failure-injection and concurrency tests.

### Acceptance

- A forced failure at any intermediate step leaves no partial business state.
- Concurrent stale updates return conflict without altering related rows.
- Duplicate request/retry does not duplicate milestones/events/tasks.
- Every critical mutation is covered by role-based integration tests.

---

# P1 — required for stable production operation

## P1-1 — Authentication/session handling remains fragmented

### Evidence

`src/lib/supabase-server.ts` still accepts optional bearer/cookie inputs and retains implicit `cookies()` fallback. Cookie names are hardcoded to a specific Supabase project. Refresh is manually implemented, has no explicit request timeout, attaches state using ad-hoc properties, and requires each caller to propagate refreshed cookies.

`src/lib/lead-auth.ts` creates additional Supabase clients and collapses database errors into null/false. A typical route can authenticate through one client and then perform work through a second client, which is fragile during refresh-token rotation.

`src/app/api/auth/me/route.ts` explicitly writes refreshed cookies, but most routes do not share this response mechanism.

### Required remediation

- Introduce one request-scoped auth context containing user/profile/role/client and refresh-cookie output.
- Make API request input mandatory; remove implicit fallback for route code.
- Centralize bearer parsing, cookie naming and response cookie propagation.
- Add upstream timeouts and typed auth vs DB errors.
- Add tests for expired access token, single-use refresh, duplicate helper calls and response cookie propagation across representative routes.

---

## P1-2 — Proxy/middleware is an availability and authorization choke point

### Evidence

`src/proxy.ts` can perform several Supabase calls for every protected request: user validation, profile fetch, password-change invalidation and activity/audit writes. Bearer fallback uses service-role REST access. No explicit timeout protects profile lookup. Password-change invalidation fails open on query/decode errors. Activity tracking uses a module-local map and fire-and-forget writes without a durable Edge lifetime mechanism. Client IP is accepted from forwarded headers without a documented trusted-proxy contract.

### Required remediation

- Bound every upstream call with timeout and explicit availability behavior.
- Define fail-open/fail-closed rules per route class; privileged mutations must not fail open.
- Remove service-role dependence from edge middleware where possible.
- Move audit/activity writes to a durable asynchronous path.
- Add executable route authorization matrix tests covering all roles and unauthenticated access.

---

## P1-3 — CI and production acceptance do not prove real workflows

### Evidence

The GitHub workflow runs unit/static/build gates but no Playwright E2E. The CI step named CRM regression executes only `crm-regression.py --self-test`, which tests helper logic rather than the application. Live regression uses service-role/database reads and unauthenticated reachability, not real login, RLS or business writes.

`check-smoke.sh` treats 401/403/404 as acceptable and can fetch routes twice. `check-logs.sh` relies on grep and excludes some auth/Sentry errors. Production acceptance has repeatedly allowed health 200 while login or mutations failed.

### Required remediation

- Add authenticated Playwright flows for real login/session/dashboard and core lead workflows.
- Use dedicated role accounts and verify positive and negative permissions.
- Run the same build artifact/dependency set in CI candidate and production.
- Require real write/readback/edit/delete/refresh tests before GO.
- Define exact expected status/body per smoke route.

---

## P1-4 — Engineering gates preserve large known debt instead of enforcing clean state

### Evidence

- The lint baseline permits 501 existing ESLint errors.
- The Supabase boundary allowlist permits a large set of client reads/writes and server-role findings.
- Static database checks validate presence of tokens/text rather than live policy correctness.
- Route naming checks depend on local Git diffs and are weak in clean CI checkouts.
- Runtime versions are not pinned through `engines`/`packageManager`.

### Required remediation

- Burn down lint errors in bounded batches and set a dated zero-error target.
- Replace broad allowlists with narrowly justified, owner-tagged exceptions and expiry dates.
- Add live database advisory/policy tests against a branch database.
- Pin Node/npm and enforce lockfile/runtime parity.
- Make gates test prohibited behavior, not only source strings.

---

## P1-5 — Health/readiness/error reporting leaks internals and fragments observability

### Evidence

Health/readiness endpoints can return raw logger/database error text and perform synchronous disk checks. Readiness performs multiple database checks per probe. Service naming still uses `newme-crm` in places.

The custom monitoring report endpoint accepts user-supplied messages/stacks and writes synchronous fingerprinted files under `/tmp/hermes/errors`, without clear retention, bounded cardinality or PII/secret guarantees. This duplicates Sentry/journald and can lose evidence on reboot.

Logger redaction is shallow and request/release correlation is not uniformly propagated.

### Required remediation

- Public probes return minimal stable status; detailed diagnostics remain internal/authenticated.
- Add bounded timeouts and reduce probe load.
- Consolidate errors into one structured pipeline with request ID, release SHA/build and safe redaction.
- Remove or strictly bound the `/tmp` error-file mechanism.
- Add log retention/rotation and tests that secrets/tokens/nested PII are redacted.

---

## P1-6 — Database performance schema has accumulated broad debt

### Evidence from live Supabase performance advisor

- More than twenty foreign keys lack covering indexes, including operational CRM tables such as leads, follow-ups, payments, projects, quotations and transfer history.
- A large number of RLS policies repeatedly evaluate `auth.*` per row instead of using init-plan-friendly forms.
- Numerous tables have multiple permissive policies for the same role/action.
- Duplicate indexes exist on business events, chat messages, customers, follow-up logs, lead milestones and multiple lead columns.
- Many indexes are currently unused.

### Required remediation

- Prioritize missing FK indexes using query/lock evidence rather than adding all blindly.
- Consolidate equivalent role policies and optimize `auth.*` expressions.
- Remove duplicate indexes after validating constraints/query plans.
- Observe unused indexes over a representative period before dropping.
- Add advisor review after every migration.

---

# P2 — cleanup and long-term maintainability

## P2-1 — Linear and Git status are out of sync

Examples:

- Auth/proxy issue `SAM-51` remains Backlog although partial code changes exist, while its E2E acceptance is not complete.
- Systemd/release issue `SAM-56` is In Progress but the production architecture and current incident evidence have advanced beyond its description.
- Health/security issue `SAM-15` is In Review although current health/cookie behavior still violates parts of the intended acceptance.
- Credentials issue `SAM-13` remains In Progress while hardcoded E2E credentials remain in Git.
- Regression harness tasks overstate the strength of current regression coverage.

Linear should represent verified state, not commit intent or local test success.

## P2-2 — Naming, metadata and duplicated operational code

- Mixed `newme-crm` and `newme-platform` service naming.
- Build/release metadata can be unknown depending runtime injection.
- Legacy deploy and duplicated helper patterns remain discoverable and callable.
- Error formats and bearer parsing vary by route.

Standardize these only after P0/P1 boundaries are fixed.

---

# Remediation order for Codex

## Wave 0 — containment

1. Rotate leaked credentials and lock down E2E artifacts.
2. Create database migration plan to revoke unsafe function grants and protect audit/session writes; do not apply blindly to production.
3. Freeze feature work except incident containment.

## Wave 1 — safety boundaries

1. One deployment pipeline with immutable dependencies, strict smoke and verified rollback.
2. Transactional server-side critical lead mutations.
3. Request-scoped auth/session context and proxy timeout/failure rules.

## Wave 2 — proof

1. Authenticated multi-role Playwright UAT.
2. Failure-injection tests for deploy, refresh and transactional mutations.
3. Live Supabase security-policy integration tests.

## Wave 3 — debt reduction

1. Observability consolidation.
2. Lint/boundary allowlist burn-down.
3. RLS/index performance cleanup.
4. Naming and legacy-code cleanup.

---

# Global acceptance gate

Feature development may resume only when:

- all P0 issues are closed with direct evidence;
- P1-1 through P1-3 are closed;
- production deployment uses the authoritative pipeline;
- real role-based login and core CRM workflows pass against the deployed artifact;
- rollback has been exercised successfully;
- live Supabase security advisor has no unreviewed high-risk findings;
- no credential or session artifact exists in Git;
- the 13:00 incident remains separately OPEN until forensic evidence proves its trigger, but the service has validated automatic recovery and actionable capture.

## Final assessment

**System direction:** repair, not rewrite.  
**Current stability claim:** not acceptable.  
**Current feature-development decision:** NO-GO except bounded remediation.  
**Target after P0/P1:** clean, reproducible and evidence-driven production operation.
