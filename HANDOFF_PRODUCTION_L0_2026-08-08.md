# NewMe production authentication L0 handoff — 2026-08-08

## Scope and safety state

- Repository: `69755354/newme-platform`
- Worktree: `C:\Users\69755\.codex\worktrees\l0-auth-supply-chain`
- Branch: `codex/l0-authenticated-login-probe`
- Local base SHA: `945d1b5e0615c963c19e116483fcc8c4253d03ea` (equal to `origin/main` when last fetched)
- Production current release: `/opt/newme/releases/945d1b5e0615c963c19e116483fcc8c4253d03ea`
- Production rollback release: `/opt/newme/releases/cbbb163dc82f64dadea1704ee412223bce4b8412`
- All handoff changes are local and uncommitted. No PR, merge, deployment, database mutation, DNS change, or production-data write was performed in this audit phase.
- `TASKBOARD.md` contains `PROD-L0-ROOT-CAUSE-PREVENTION | IN_PROGRESS`; do not mark it done until deployment, role UAT, alert drill, cleanup, and delayed verification all pass.

## Last verified live state

The final read-only production check before handoff returned:

```text
PUBLISHABLE_HTTP=200
SERVICE_HTTP=200
HEALTH_HTTP=200
ORIGIN_HTTP=400
AUTH_ANON_HTTP=401
ActiveState=active
SubState=running
NRestarts=0
```

The last 20-minute journal query returned no matching `invalid_origin`, `Unregistered API key`, `auth_me`, readiness, or error rows. This is a point-in-time check, not proof of future availability.

## Confirmed root-cause chain

### L0-1 — production Origin configuration drift

- A request sent directly to port 3001 with `Host: app.newme.ae` and `Origin: https://app.newme.ae` returned `403 {"error":"invalid_origin"}`.
- Cloudflare and Nginx were bypassed, so neither was the cause of that 403.
- systemd loads `/etc/newme/newme-runtime.env`; the release `.env.local` did not provide `NEXT_PUBLIC_SITE_URL`.
- Correcting the root-owned runtime value to exactly `https://app.newme.ae` restored the Origin probe to HTTP 400 and public health to 200 on 2026-08-07.
- The exact prior bad value and actor are not reconstructable from retained evidence: the mutable file had no change audit and the old value was overwritten.

### L0-2 — invalid Supabase service-role credential on the login path

- Production returned `Unregistered API key` for the configured service-role credential.
- Earliest retained evidence was the overdue cron at 2026-08-08 09:30 CST, then both cron jobs at 13:02, authenticated `/api/auth/me` 500 responses from 13:47–16:18, and the notification active-user query at 16:24.
- The old authenticated profile lookup used the service-role key, so every signed-in user could fail while the anonymous `/api/auth/me` probe still returned the expected 401.
- The key was rotated and the current release now returns HTTP 200 for both publishable-key and service-key read probes.
- The exact credential rotation actor/time cannot be reconstructed because the invalid release environment was pruned and no secret-change audit was retained.

### L0-3 — external dependency incorrectly coupled to process startup

- systemd `ExecStartPost` called `/api/ready`, which depended on Supabase.
- During the invalid-key incident, 62 service starts failed between 16:00 and 16:12 CST.
- The old `StartLimitIntervalSec=60` / `StartLimitBurst=5` combination did not stop the cycle because each readiness attempt lasted long enough for the rolling window to reset.
- This converted one credential failure into an application restart cascade and produced Nginx 502s.

### L0-4 — Cloudflare users shared one Nginx rate-limit bucket

- Nginx keyed limits on `$binary_remote_addr` but had no trusted Cloudflare real-IP configuration.
- Access logs therefore contained Cloudflare egress addresses rather than end-user addresses.
- A real `POST /api/auth/session` was rate-limited at 2026-08-08 17:41:24 CST; historical `/api/auth/me` 429 clusters were also found.
- Existing limits were only `api=30 requests/minute` and `login=5 requests/minute`, shared across unrelated users behind the same Cloudflare address.

### Detection failure

- The deployed Sentry cron script used the wrong URL/protocol, non-UUID IDs, mismatched monitor slugs, and swallowed every delivery error.
- The health script finalized from the wrong shell status and could mark failures successful.
- Application `logger.error` records went only to journald; handled 500 responses did not reach Sentry.
- `/api/monitoring/report` wrote `/tmp` files but did not send a Sentry event.
- Only `newme-health-check` existed in Sentry. No authenticated/dependency synthetic check existed.

## Local remediation already implemented

### Authentication boundary

- `src/app/api/auth/session/route.ts`
  - Production host always maps to immutable `https://app.newme.ae`.
  - Mutable runtime configuration cannot lock production out or broaden its Origin allowlist.
  - `Host` takes precedence over caller-controlled `X-Forwarded-Host`.
- `src/proxy.ts`
  - Bearer fallback reads the caller's profile with the publishable key plus caller JWT through RLS.
  - Login/request authentication no longer depends on the service-role key.

### Deployment and process supervision

- `scripts/validate-production-config.py`
  - Requires exact production site URL and Supabase project URL.
  - Validates readiness token, two distinct Supabase keys, and Sentry DSN shape without printing secrets.
  - Optional network mode performs bounded read-only publishable/service probes and requires HTTP 200.
- `scripts/deploy-immutable.sh`
  - Runs configuration plus network validation before installing dependencies/building/switching.
  - Builds with the exact git SHA as Sentry/app release identity.
  - Candidate checks `/api/ready`, legal production Origin (400), and anonymous auth (401).
  - Runs dependency and login probes after switch.
  - Resets systemd failed state before switch or rollback restarts.
- `infra/systemd/newme-readiness.sh`
  - Tests only local `/api/health` and local production-Origin request parsing.
  - No longer makes Supabase availability a process-liveness condition.
- Both systemd unit copies now use `StartLimitIntervalSec=300` and `StartLimitBurst=3`.
- Production rollback controller resets failed state before restart.

### Nginx ingress

- Added `infra/nginx/newme-platform.conf` from the live production route set.
- Removed the two temporary public routes `/codex_uat_key` and `/qr.png`.
- Added all 22 Cloudflare IPv4/IPv6 ranges verified on 2026-08-08, `CF-Connecting-IP`, and recursive real-IP handling.
- Changed limits to per-real-client `api=10r/s burst=50`, `login=30r/m burst=10`, and `oauth=10r/m burst=5`.
- Installer backs up both live files, installs identical versioned copies, runs `nginx -t`, reloads only on success, and restores the prior files if validation/reload fails.
- The live server has `--with-http_realip_module`; this was verified read-only.

### Monitoring and alerting

- Corrected Sentry cron transport to the verified public-key cron endpoint, UUID check-in IDs, POST lifecycle, exact HTTP 202 requirement, and nonzero failure propagation.
- Login probe now detects real-traffic 429 and 5xx responses, valid-Origin failures, liveness failures, anonymous auth failures, and Sentry transport failures.
- Added a read-only dependency probe for immutable release integrity, service state, exact project URL, publishable key, and service-role key.
- Both L0 probes run every two minutes and use first-failure Hermes alerts; Sentry transport failure itself is routed to Hermes.
- Health probe status handling was corrected.
- Production Pino errors and internal monitoring reports are sanitized and forwarded to Sentry.
- Server-side monitoring reports use loopback, so a bad public site URL cannot disable the reporting path.

## Verification completed

- Targeted combined suite: 46/46 passed.
- After adding the forged `X-Forwarded-Host` regression, the affected subset: 21/21 passed.
- TypeScript: `npm run typecheck` passed.
- ESLint on all changed TypeScript application files passed.
- Bash syntax passed for all changed shell scripts.
- Python compilation passed for both changed Python scripts.
- Taskboard gate: 18 passed, 0 failed, 0 warnings.
- Production read-only dependency and boundary probes passed as shown above.

## Verification not complete

- `npm test` is not green on this Windows worktree. The run reached the whole suite but exited 1. Observed failures include the existing Windows `npx` spawn failure in the lint-baseline negative test, CRLF-sensitive task-contract matching, and unrelated SAM-43 source-contract failures. The output was truncated, so do not claim these are the only full-suite failures.
- `npm run lint:baseline` cannot execute on this Windows host because `spawnSync('npx', ...)` yields no stdout; the attempted local compatibility edit was reverted before this handoff.
- A full production build has not been run after these changes.
- No GitHub CI run exists for these changes.
- No Nginx `nginx -t` has run against the proposed versioned file on the server; the canonical root installer is designed to perform this transactionally.
- Sentry monitors `newme-login-probe` and `newme-dependency-probe` have not yet been explicitly created/configured.
- No production deploy, role UAT, browser UAT, notifier alert/recovery drill, fixture cleanup, or delayed post-deploy check has occurred.

## Approved no-cost Sentry deviation (2026-08-09)

- `newme-login-probe` and `newme-dependency-probe` were created with the required two-minute schedule and one-failure threshold, but Sentry kept both disabled. Activating either returned HTTP 400 with `You don't have enough pay-as-you-go available to create a new seat`.
- The operator explicitly approved a no-cost substitute instead of changing the Sentry subscription.
- The single active `newme-health-check` monitor is therefore the aggregate Sentry transport for health, login, and dependency probes. Its target schedule is every two minutes with one-failure and one-recovery thresholds.
- The three child probes remain distinct and preserve independent Hermes failure/recovery state. Only their Sentry check-in is aggregated.
- This approval supersedes only the three-independent-Sentry-monitor requirement in steps 4, 8, and 12 below. It does not waive exact-SHA CI, canonical deploy, authenticated role UAT, fixture cleanup, Hermes alert/recovery drill, log review, or the delayed post-deploy check.
- The Sentry schedule must not be changed from five minutes to two minutes until the canonical production deploy is ready, because the currently deployed cron still runs the health probe every five minutes. On deploy failure or rollback, restore the Sentry schedule to five minutes before closing the incident response.

## Required next steps, in order

1. Review the entire local diff, especially Nginx, installer rollback behavior, dependency probe, and production config parser.
2. Run the targeted checks below again and run the full suite in Linux/GitHub CI. Do not waive a new failure caused by this diff.
3. Run a full production-mode build locally or in CI.
4. Create/configure Sentry monitors:
   - `newme-health-check`: every 5 minutes.
   - `newme-login-probe`: every 2 minutes.
   - `newme-dependency-probe`: every 2 minutes.
   - Use a one-failure alert threshold for the two L0 probes.
5. Commit, push, open PR, obtain review, merge to `main`, and wait for the exact merged SHA's successful `ci` run.
6. Read rollback status immediately before deployment and bind the canonical deploy to the exact `main` SHA, exact successful CI run ID, `not_required` migrations, and exact rollback SHA.
7. Let only `/usr/local/sbin/newme-deploy` perform root asset installation and immutable release switch. Do not manually overwrite Nginx/systemd/runtime files.
8. Verify immediately after deployment:
   - `nginx -t`, Nginx active, app active, `NRestarts=0`.
   - Local/public health 200, legal Origin 400, illegal Origin 403, anonymous auth 401.
   - Publishable/service dependency probes 200.
   - No public temporary UAT/QR routes.
   - Sentry check-ins visible for all three monitor slugs.
9. Execute authenticated browser/API UAT for admin, boss, sales, and admin-staff roles. Include login, refresh, logout, dashboard, lead list/detail, contact create/edit, contact quality, milestone, reassignment authorization, tasks, contracts/quotations/payments as role permits.
10. Create only uniquely labelled test fixtures; record exact IDs and remove/archive them. Query again and require zero remaining synthetic users/business fixtures before finalization.
11. Perform one clearly labelled Hermes alert/recovery drill and verify both delivery and state recovery. Do not use a real user outage as the drill.
12. Recheck after at least 10–15 minutes: service restart count, Nginx 429/5xx, app journal errors, cron results, Sentry events/check-ins, public and authenticated probes.
13. Finalize deployment evidence only after UAT and cleanup are proven. Then mark the taskboard row `DONE` and rerun the taskboard gate.

## Local commands

```powershell
Set-Location 'C:\Users\69755\.codex\worktrees\l0-auth-supply-chain'
git status --short --branch
git diff --check

$env:PATH='C:\Program Files\Git\bin;' + $env:PATH
node --test tests/unit/auth-log-probe.test.mjs tests/unit/hermes-alert.test.mjs tests/unit/observability.test.mjs tests/unit/production-config.test.mjs tests/security/proxy-availability.test.mjs tests/security/sam15-cookie-only-session.test.mjs tests/release/systemd-process-contract.test.mjs tests/release/sam60-deployment-contract.test.mjs tests/release/l0-production-guardrails.test.mjs
npm run typecheck
npx eslint src/lib/logger.ts src/app/api/monitoring/report/route.ts src/lib/report-server-error.ts src/app/api/auth/session/route.ts src/proxy.ts
& 'C:\Program Files\Git\bin\bash.exe' scripts/check-taskboard.sh
```

## Production commands after merge and exact CI success

Read-only status first:

```powershell
ssh -o BatchMode=yes newme-production 'sudo -n /usr/local/sbin/newme-production-rollback status'
```

Canonical deploy shape (substitute only verified values):

```powershell
ssh -o BatchMode=yes newme-production "sudo -n /usr/local/sbin/newme-deploy <FULL_MAIN_SHA> <SUCCESSFUL_CI_RUN_ID> not_required '' <FULL_ROLLBACK_SHA>"
```

Never print or transmit `.env.local`, `/etc/newme/newme-runtime.env`, the GitHub Actions read token, Supabase keys, Sentry token, SSH private key, passwords, or cookies.

## Non-L0 findings that must remain separate

- Production Supabase security advisors reported nine authenticated `SECURITY DEFINER` warnings and leaked-password protection disabled. The reviewed functions generally contain caller/business authorization; `next_quote_no()` needs a separate active-user design review. Do not revoke it blindly because the quote flow calls it directly.
- Performance advisors reported unindexed foreign keys, auth RLS init-plan findings, multiple permissive policies, unused/duplicate indexes, and Auth connection configuration. These require a separate measured database change set.
- Migration history names/versions differ between the repository and production records even where live schema objects exist. Do not run migration repair or history rewriting without an explicit schema/history reconciliation plan.
