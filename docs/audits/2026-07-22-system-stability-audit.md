# NewMe CRM System Stability Audit

**Date:** 2026-07-22  
**Audit base:** `main` at `4905460`  
**Audit branch:** `audit/system-stability-2026-07-22`  
**Auditor:** ChatGPT  
**Target:** a clean, stable, secure and production-grade CRM before unrestricted feature expansion

## Audit status

**Comprehensive audit: COMPLETE.**  
**Overall decision: NO-GO for unrestricted feature development.**

The product is repairable and does not require a rewrite. However, confirmed cross-cutting defects remain in credentials, deployment reproducibility, process supervision, database privileges, critical transaction integrity, authentication/session handling, production acceptance, observability and engineering gates.

Feature development should remain frozen except for bounded incident containment and the P0/P1 remediation defined in Linear parent `SAM-58`.

The 2026-07-22 13:00 service-stop incident remains separately **OPEN**. The installed bpftrace and ExecStopPost evidence path can identify a future signal sender or self-exit, but the original trigger has not been proven. No systemd/kernel/root-cause hypothesis is treated as fact without raw provenance.

---

# 1. Methodology, sources and limitations

## Directly inspected

- GitHub repository `69755354/newme-platform` at `4905460`.
- Recent auth, deploy and process-cleanup commits.
- Critical source and operational files, including:
  - `package.json`;
  - `.github/workflows/ci.yml`;
  - `scripts/deploy.sh`;
  - `scripts/deploy-immutable.sh`;
  - `scripts/check-smoke.sh`;
  - `scripts/check-logs.sh`;
  - `scripts/crm-regression.py`;
  - `scripts/check-supabase-boundaries.mjs`;
  - `scripts/supabase-boundary-allowlist.json`;
  - `scripts/check-db-static.mjs`;
  - `src/lib/supabase-server.ts`;
  - `src/lib/lead-auth.ts`;
  - `src/proxy.ts`;
  - health/readiness/monitoring routes;
  - critical lead mutation code;
  - Playwright configuration and auth setup.
- Current Linear issues related to auth, deployment, systemd, security, health, dependencies and regression testing.
- Live Supabase project `vfopmpxlhwzpxqegayew` security and performance advisors.

## Trust rules

- GitHub is the code source of truth.
- Supabase is the database source of truth.
- Linear represents work state only when acceptance evidence matches reality.
- Server/runtime claims from Hermes or DeepSeek are treated as reported, not independently confirmed, unless backed by durable raw evidence.
- Health `200`, build success, unit tests or merged code alone do not prove production acceptance.

## Limitation

This audit did not modify production, apply migrations, rotate credentials or run destructive tests. Production systemd/journald state was not directly available through a trusted server connector. Those items are encoded as explicit verification work rather than guessed conclusions.

---

# 2. Mandatory remediation principle

Every confirmed defect must be handled at two levels:

1. fix the immediate incident or local failure;
2. identify and eliminate the broader class of equivalent failures.

Every class-level fix must add at least one durable prevention mechanism, such as:

- automated integration/regression testing;
- static analysis;
- CI/deploy gates;
- shared typed interfaces;
- runtime assertions;
- idempotency/transaction boundaries;
- operational safeguards and evidence capture.

A one-off patch without class-level containment does not satisfy acceptance.

---

# 3. P0 findings — resolve first

## P0-1 — Hardcoded real-account credentials and unsafe E2E artifacts

**Linear:** `SAM-59`

### Evidence

`e2e/auth.setup.ts` contains literal NewMe account emails/passwords and a Supabase project key. Playwright storage-state, traces, screenshots and result artifacts are not comprehensively blocked from Git. Editing the current file does not remove secrets from history.

### Risk

- exposed credentials remain valid after source cleanup unless rotated;
- Git history retains secret material;
- storage-state files can expose live sessions;
- tests default to the production URL and can mutate real data.

### Required remediation

- rotate every exposed credential and prove old values fail;
- replace literals with secret-backed dedicated, least-privileged test identities;
- use a non-production target by default;
- clean Git history through an approved plan where required;
- ignore and CI-block auth states, traces, screenshots and result files;
- enforce secret scanning with negative fixtures.

### Acceptance

- old credentials cannot authenticate;
- no password/session token remains in current Git or generated artifacts;
- CI receives credentials only through secret storage;
- credential-like literals or tracked auth-state files fail CI;
- production is never the implicit E2E target.

---

## P0-2 — Conflicting deployment systems and non-reproducible releases

**Linear:** `SAM-60`  
**Related:** `SAM-56`

### Evidence

`package.json` maps `npm run deploy` to legacy `scripts/deploy.sh`, while operational work also uses `scripts/deploy-immutable.sh`.

The legacy path:

- installs dependencies using `npm install --ignore-scripts` in a worktree;
- stops production and replaces `.next` in place;
- uses broad port killing on 3001;
- validates mainly the root HTTP status;
- rolls back `.next` without guaranteeing matching dependencies/config.

The nominal immutable path:

- builds in the source repository;
- links releases to mutable shared `node_modules`;
- copies plaintext `.env.local` into every release;
- repairs generated dependency symlinks after build;
- uses non-atomic check/write lock-file handling;
- allows candidate 4xx/5xx statuses unless connection fails;
- validates production mainly through health/build identity;
- uses an inconsistent rollback identity field (`version` vs health `release`);
- retains broad stale-port cleanup;
- suppresses EXIT cleanup errors.

The 3002 process-group cleanup merged in `4905460` addresses one failure class but does not make the full release pipeline reproducible.

### Risk

- the same SHA can behave differently as shared dependencies change;
- CI and production can use different dependency trees;
- a broken candidate can pass and switch live;
- rollback can restore a mismatched or incorrectly identified state;
- operators can invoke the wrong pipeline.

### Required remediation

- select one authoritative deployment command and hard-disable/remove alternatives;
- pin Node/npm and build from lockfile-pinned immutable dependencies;
- package application and dependencies into one self-contained release;
- inject secrets through controlled runtime configuration;
- replace lock files with atomic `flock` or equivalent;
- require exact candidate status/body; all unexpected 4xx/5xx fail;
- verify exact release SHA/build on switch and rollback;
- preserve isolated candidate process-group/transient-unit cleanup;
- add failure injection for build, smoke, cleanup, switch, rollback and concurrent deploy.

### Acceptance

- one documented deployment entry point exists;
- identical SHA/lockfile/runtime produce one immutable artifact;
- candidate 500 never switches current;
- failed switch restores and proves the exact prior SHA/build;
- repeated deploy/abort/rollback leaves no listener/orphan;
- CI and production install equivalent dependency trees.

---

## P0-3 — Live Supabase privilege, definer-object and audit RLS exposure

**Linear:** `SAM-61`

### Confirmed live advisor findings

- `public.lead_alerts` is a `SECURITY DEFINER` view;
- numerous privileged functions have mutable `search_path`;
- many `SECURITY DEFINER` functions are executable by `anon` and/or broad `authenticated` roles, including maintenance, transfer, quote, stale-lead, milestone, trigger, auth and logging functions;
- `activity_logs`, `audit_logs` and `user_session_daily` have authenticated INSERT policies with `WITH CHECK (true)`;
- leaked-password protection is disabled.

### Risk

- exposed definer functions can bypass normal RLS;
- mutable object resolution is unsafe in privileged functions;
- clients can forge audit/session/activity evidence;
- security logs cannot be trusted as evidence if arbitrary actors can insert rows.

### Required remediation

- inventory every definer object: owner, purpose, intended caller and privilege;
- revoke default PUBLIC/anon/broad-authenticated execution except explicitly approved RPCs;
- make trigger/internal/maintenance functions non-callable from exposed schemas;
- fix `search_path` and schema-qualify privileged references;
- replace always-true audit/session policies with strict actor checks or server-only writes;
- review/replace the definer view;
- add a full role authorization matrix against a branch/staging database;
- evaluate and enable leaked-password protection;
- track advisor output as a reviewed release gate.

### Acceptance

- anon cannot execute internal, maintenance or trigger functions;
- authenticated users cannot forge another actor's audit/session rows;
- every privileged object has explicit grants, fixed search path and tests;
- no unreviewed security advisor ERROR/high-risk WARN remains;
- migrations and rollback are validated outside production before application.

---

## P0-4 — Critical lead workflows are non-transactional browser mutations

**Linear:** `SAM-62`

### Evidence

`src/app/(dashboard)/leads/_hooks/useLeadMutations.ts` directly performs critical multi-table writes from the browser.

Examples:

- reassignment writes event/history/activity and lead state in separate calls;
- stage change can close quotations before the optimistic lead update succeeds;
- event/activity/notification failures are often best-effort or ignored;
- retries can duplicate side effects;
- important rules depend on client checks and distributed RLS behavior.

The boundary allowlist explicitly tolerates a large number of direct client reads/writes, preventing only new debt rather than containing the current class.

### Risk

- partial state across leads, quotations, history, milestones and audit;
- bypassable business rules;
- duplicate events/tasks/notifications;
- audit history can disagree with primary state.

### Required remediation

- move critical workflows to server-side API/RPC transaction boundaries;
- make stage transition, quote closure, reassignment and audit atomic;
- use an outbox/idempotent worker where notifications cannot be in the transaction;
- add idempotency keys and typed conflict/authorization/infrastructure errors;
- preserve optimistic concurrency without pre-conflict side effects;
- reduce direct-client critical mutation allowlist toward zero;
- add role, retry, concurrency and failure-injection tests.

### Acceptance

- every forced intermediate failure leaves no partial state;
- concurrent requests yield one valid result plus a typed conflict;
- duplicate retries create no duplicate event, milestone, task or notification;
- ownership/role rules are proven through executable tests;
- browser no longer orchestrates critical multi-table writes.

---

## P0-5 — Process supervision, recovery and stop provenance are not production-grade

**Linear:** `SAM-63`  
**Related:** `SAM-56`

### Evidence

Reported production process ownership is systemd → npm → shell → next-server. Prior deployments left child processes and port listeners. `Restart=always` is a containment measure. The direct trigger for the 13:00 service stop is unknown; bpftrace and ExecStopPost capture remain required.

### Risk

- npm/wrapper signal propagation can leave children or ambiguous exit semantics;
- intentional and abnormal stops are difficult to distinguish;
- restart policy can mask rather than explain faults;
- broad port kills can terminate unrelated processes;
- an outage can recur without sender/exit provenance.

### Required remediation

- make systemd supervise the real Node/Next process or an `exec`-replacing wrapper;
- ensure correct TERM/KILL propagation and complete child cleanup;
- define intentional-stop, abnormal-exit, StartLimit and recovery behavior;
- version the unit and verification tests in Git;
- test clean stop, abnormal exit, signal handling, child spawning, restart exhaustion and reboot;
- retain durable signal/exit provenance until the incident is proven.

### Acceptance

- MainPID is the real application process or exec-equivalent owner;
- `systemctl stop` releases 3001 and leaves no child/orphan;
- abnormal exit recovers inside the defined SLO and records sender/signal/exit/release;
- intentional stop does not create an uncontrolled restart loop;
- unit behavior is reproducibly tested;
- the 13:00 incident is not closed without forensic evidence.

---

# 4. P1 findings — required for stable operation

## P1-1 — Authentication/session handling is fragmented

**Linear:** `SAM-64`  
**Related:** `SAM-51`

### Evidence

- `supabase-server.ts` accepts optional bearer/cookie inputs and retains implicit `cookies()` fallback;
- cookie names are hardcoded to one project;
- refresh is manually implemented without an explicit upstream timeout;
- refresh state is attached via ad-hoc client properties;
- callers must individually propagate refreshed cookies;
- `lead-auth.ts` can create additional clients and collapse DB errors into null/false;
- representative routes authenticate and perform work through different clients.

### Required remediation

- introduce one request-scoped auth context containing user, active profile, role, client, request ID and response-cookie mutations;
- require explicit Request/context in API routes;
- centralize bearer parsing, cookie discovery and refresh response propagation;
- add timeouts and typed errors;
- enforce one refresh operation per session/request burst;
- add static and executable regression gates against legacy route behavior.

### Acceptance

- refresh succeeds once and response cookies propagate consistently;
- concurrent refresh requests do not intermittently 401/500;
- auth, inactive-profile and DB failures produce correct typed status/logging;
- API routes cannot call implicit `cookies()` through helpers;
- representative bearer/cookie/refresh tests pass.

---

## P1-2 — Proxy/middleware is an availability and authorization choke point

**Linear:** `SAM-65`  
**Related:** `SAM-50`, `SAM-51`

### Evidence

`src/proxy.ts` performs user validation, profile lookup, password-change invalidation and activity/audit work on protected requests. Bearer fallback uses service-role REST. Profile calls have no explicit timeout. Password invalidation fails open on errors. Activity tracking uses a module-local throttle and fire-and-forget writes. Forwarded IP headers lack a documented trust boundary.

### Required remediation

- define fail-open/fail-closed behavior for each route class;
- privileged mutations must fail closed;
- add bounded upstream timeouts and typed availability behavior;
- remove service-role dependence from Edge middleware where feasible;
- move audit/activity side effects off the synchronous authorization path;
- document trusted proxy/IP handling;
- add executable route/role authorization matrix tests.

### Acceptance

- upstream timeout has bounded latency and documented behavior;
- inactive/password-invalidated sessions are consistently rejected;
- infrastructure failure never grants a privileged action;
- activity/audit failure does not break auth or silently lose required evidence;
- tests execute proxy behavior, not only source regex.

---

## P1-3 — CI and production acceptance do not prove real workflows

**Linear:** `SAM-66`  
**Related:** `SAM-9`, `SAM-28`, `SAM-39`

### Evidence

- CI runs static/unit/build gates but not Playwright E2E;
- the CI CRM regression step uses only `crm-regression.py --self-test`;
- live regression uses service-role reads and unauthenticated reachability;
- smoke accepts unexpected 4xx statuses and fetches routes multiple times;
- production has previously passed health while login or mutations failed;
- current E2E setup contains unsafe credentials and production defaults.

### Required remediation

- create dedicated role test identities;
- add authenticated Playwright flows for login, refresh, dashboard and core lead workflows;
- test positive and negative authorization;
- bind fixtures and cleanup to exact IDs;
- require expected route status/body;
- block GO on console errors, 500s, readback mismatch or cleanup failure;
- bind evidence to SHA/build.

### Acceptance

- CI executes representative authenticated multi-role flows;
- candidate/production UAT proves login plus save/edit/delete/refresh for boss and sales;
- unauthorized cross-owner actions are denied;
- fixtures are precisely cleaned;
- evidence is versioned and release-bound.

---

## P1-4 — Engineering gates preserve debt instead of enforcing a clean state

**Linear:** `SAM-67`

### Evidence

- ESLint baseline permits 501 current errors;
- boundary allowlist permits extensive client access and service-role findings;
- DB static checks rely on source tokens rather than live behavior;
- route-file check relies on local diffs and is weak in clean CI;
- Node/npm are not pinned through `engines`/`packageManager`.

### Required remediation

- burn lint debt down in bounded batches with critical folders first and a dated zero target;
- replace broad baselines with owner-tagged, justified, expiring exceptions;
- pin runtime/package manager and enforce lockfile parity;
- add negative fixtures proving every gate can fail;
- run database policy/advisor tests against isolated DB state;
- compare correct PR base/head in CI route gates.

### Acceptance

- no new lint/boundary debt;
- every exception has owner, reason, expiry and linked issue;
- unsupported runtime fails before install/build;
- prohibited behavior is detected by executable negative tests;
- critical folders reach zero-error/zero-unreviewed-boundary state.

---

## P1-5 — Health, readiness, logging and monitoring are fragmented

**Linear:** `SAM-68`  
**Related:** `SAM-15`

### Evidence

- public probes can return logger/database error text;
- probes perform synchronous disk and multiple DB/API checks;
- mixed `newme-crm` and `newme-platform` service identity;
- custom monitoring accepts user-provided message/stack and writes fingerprint files under `/tmp/hermes/errors`;
- retention, cardinality, PII and reboot persistence are unclear;
- the custom path duplicates Sentry/journald;
- redaction and request/release propagation are not uniform.

### Required remediation

- separate minimal public liveness from internal authenticated diagnostics;
- add strict timeouts and reduce probe load;
- choose one structured server error pipeline;
- retire or strictly bound duplicate `/tmp` reporting;
- persist required evidence with retention, rotation and disk caps;
- strengthen recursive secret/PII redaction;
- use structured severity/fields rather than broad grep exclusions.

### Acceptance

- public probes expose no raw SQL, stack, path or secret-adjacent detail;
- probe latency and load are bounded;
- requests correlate to exact release/build in journal/Sentry;
- required evidence survives reboot and cannot grow without bound;
- nested redaction negative tests pass.

---

## P1-6 — Live database RLS and index performance debt

**Linear:** `SAM-69`

### Confirmed live advisor findings

- more than twenty foreign keys lack covering indexes;
- many RLS policies repeatedly evaluate `auth.*` per row;
- many tables have multiple permissive policies for the same role/action;
- duplicate indexes exist across business events, chat, customers, follow-ups, milestones and several lead columns;
- numerous indexes are currently unused.

### Required remediation

- prioritize missing indexes using query/lock evidence;
- optimize RLS expressions while preserving role semantics;
- consolidate equivalent policies;
- remove exact duplicate indexes after dependency validation;
- observe unused indexes over a representative period before removal;
- add advisor diff review after every migration.

### Acceptance

- no unexplained duplicate index remains;
- critical FK delete/update paths avoid full scans/excessive locks;
- role authorization behavior is unchanged and tested;
- critical query plans improve or do not regress;
- migrations/rollback are tested outside production;
- remaining warnings have owner and review date.

---

## P1-7 — Production dependency and supply-chain risk

**Linear:** `SAM-70`  
**Related:** `SAM-32`, `SAM-33`

### Evidence

- existing Linear work tracks high-risk `hono` and `xlsx` findings;
- SheetJS is installed from a direct CDN tarball, requiring explicit provenance/integrity governance;
- runtime/package-manager versions are not pinned;
- current audit status must be reproduced from the lockfile rather than inferred from issue titles.

### Required remediation

- reproduce dependency audit and classify production reachability;
- upgrade, replace or isolate high-risk packages;
- verify provenance, immutable integrity and license of non-registry artifacts, or remove them;
- pin Node/npm and lockfile behavior;
- add dependency scanning with expiring exceptions;
- test XLSX handling for corrupt, oversized and malicious inputs with resource limits.

### Acceptance

- no unreviewed critical/high production vulnerability remains;
- `SAM-32`/`SAM-33` match actual code/lockfile state;
- direct artifacts have approved provenance/integrity or are removed;
- CI blocks newly introduced critical/high production findings;
- import/export regression and abuse tests pass.

---

# 5. P2 findings — cleanup after safety boundaries

## P2-1 — Linear and verified system state are inconsistent

**Linear:** `SAM-71`

Examples include `SAM-51`, `SAM-56`, `SAM-15`, `SAM-13` and regression/deployment tasks whose current status does not fully represent acceptance evidence.

Required outcome:

- code merge is not treated as production completion;
- every issue has owner, dependency, acceptance and evidence;
- stale/duplicate issues are related or closed with explanation;
- incident mitigation is separated from root-cause closure;
- Definition of Done distinguishes code, DB, deployment, UAT and observation.

---

## P2-2 — Naming, release metadata and legacy operational code

**Linear:** `SAM-72`

Confirmed debt:

- mixed service identifiers;
- release/build identity can be unknown;
- obsolete deploy/helper/monitoring paths remain callable;
- error formats, request IDs and bearer parsing vary;
- generated-artifact hygiene has required repeated cleanup.

Required outcome after P0/P1:

- canonical service/application/release/build naming;
- exact metadata throughout build, systemd, probes, logs, Sentry and evidence;
- unsupported operational paths fail closed with the canonical replacement;
- one API error envelope and correlation scheme;
- clean checkout/build/test leaves no generated repository changes.

---

# 6. Linear execution map

## Parent

- `SAM-58` — P0/P1 System Stability Remediation — clean production baseline

## P0

- `SAM-59` — credentials and E2E artifact isolation;
- `SAM-60` — single reproducible immutable deployment pipeline;
- `SAM-61` — Supabase definer/grant/audit RLS hardening;
- `SAM-62` — atomic idempotent critical lead mutations;
- `SAM-63` — systemd process ownership, recovery and stop provenance.

## P1

- `SAM-64` — request-scoped auth/session context;
- `SAM-65` — proxy availability and authorization rules;
- `SAM-66` — authenticated multi-role CI/production UAT;
- `SAM-67` — clean engineering gates;
- `SAM-68` — observability and probe consolidation;
- `SAM-69` — RLS/index performance debt;
- `SAM-70` — dependency and supply-chain risk.

## P2

- `SAM-71` — Linear/evidence reconciliation;
- `SAM-72` — naming, release metadata and legacy cleanup.

Every child contains scope, acceptance criteria and boundaries. Existing overlapping issues are related rather than silently replaced.

---

# 7. Dependency order for Codex

## Wave 0 — containment

1. `SAM-59` credential rotation/code containment. Manual credential rotation remains owner-controlled.
2. `SAM-61` privilege inventory and migration design only; no blind production application.
3. Keep feature development frozen.

## Wave 1 — safety boundaries

1. `SAM-60` authoritative immutable deployment pipeline.
2. `SAM-63` process supervision/recovery design and tests.
3. `SAM-62` transactional/idempotent critical mutations.
4. `SAM-64` request-scoped auth context.
5. `SAM-65` proxy timeout/failure/authorization policy.

## Wave 2 — proof

1. `SAM-66` authenticated multi-role UAT.
2. Deploy/refresh/transaction failure-injection tests.
3. Database privilege role-matrix tests.
4. Exercise exact rollback and clean process shutdown.

## Wave 3 — debt reduction

1. `SAM-67` engineering baseline burn-down.
2. `SAM-68` observability consolidation.
3. `SAM-69` measured RLS/index optimization.
4. `SAM-70` dependency remediation.
5. `SAM-71`/`SAM-72` reconciliation and cleanup.

Codex must work one bounded issue/branch at a time, stop at review, and must not deploy production unless separately authorized.

---

# 8. Global acceptance gate

Unrestricted feature development may resume only when:

- all P0 children are closed with direct evidence;
- P1 auth/proxy/UAT work (`SAM-64` through `SAM-66`) is closed;
- production uses the authoritative immutable pipeline;
- systemd clean stop and abnormal recovery are proven;
- real role-based login and core CRM workflows pass against the deployed artifact;
- rollback has been exercised successfully and proves exact prior SHA/build;
- live Supabase has no unreviewed security ERROR/high-risk WARN;
- no credential/session artifact remains in Git;
- critical lead mutations are atomic and idempotent;
- evidence is bound to exact SHA/build and fixtures are cleaned;
- the 13:00 incident remains open until forensic evidence proves the trigger, even if structural recovery is fixed.

## Final assessment

**System direction:** repair, not rewrite.  
**Current stability claim:** not acceptable.  
**Current feature-development decision:** NO-GO except bounded remediation.  
**Audit deliverables:** complete in Git and Linear.  
**Target after acceptance:** clean, reproducible, secure and evidence-driven production operation.
