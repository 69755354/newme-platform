# infra/systemd/ — Systemd unit backups

This directory contains copies of systemd unit files. These are the **source of truth** for service configuration; the actual installed units live in `/etc/systemd/system/`.

## Why this directory exists

Systemd unit files in `/etc/systemd/system/` are not tracked by git. To make changes auditable and reproducible, this mirror is committed. After any systemd change, the new unit must be:

1. Applied to the live system: `sudo cp infra/systemd/<unit>.service /etc/systemd/system/`
2. Reloaded: `sudo systemctl daemon-reload`
3. Restarted (if needed): `sudo systemctl restart <unit>`
4. Committed to git with the change details

Applying a unit is an operator action. A pull request only updates this
versioned mirror; it does not modify `/etc/systemd/system/`, reload systemd,
restart the service, or change the production worktree.

## Release boundary

Before applying a unit or application release, the release owner must record
the exact `main` SHA, matching PR-head CI run and conclusion, migration status
(`not_required` for this release-hygiene change), and a verified rollback SHA
and build. The unit change is independently reversible by restoring the
previous unit file and reloading systemd; the application rollback remains the
previous verified Git SHA/build backup. Production application and unit changes
remain subject to total-control approval.

## Files

| Unit | Purpose | Last modified |
|------|---------|---------------|
| `newme-platform.service` | Next.js app (port 3001) | 2026-07-19 |

## Health Check Rationale (newme-platform.service ExecStartPost)

The health check validates 4 critical routes (login / root / dashboard / leads) all return non-000 HTTP status. Previous version only checked `/login` and broke on first 200, missing cold-start races where dashboard/leads would 502 while login happened to be cached.

10 retries × 2s = up to 20s grace period for Next.js cold start. The readiness helper runs with root privileges so it can read the root-owned runtime token, while the main process remains under `User=ubuntu`. A failed health check exits 1 and systemd treats the `ExecStartPost` failure as a service-start failure.
