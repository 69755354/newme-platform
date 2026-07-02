# infra/systemd/ — Systemd unit backups

This directory contains copies of systemd unit files. These are the **source of truth** for service configuration; the actual installed units live in `/etc/systemd/system/`.

## Why this directory exists

Systemd unit files in `/etc/systemd/system/` are not tracked by git. To make changes auditable and reproducible, this mirror is committed. After any systemd change, the new unit must be:

1. Applied to the live system: `sudo cp infra/systemd/<unit>.service /etc/systemd/system/`
2. Reloaded: `sudo systemctl daemon-reload`
3. Restarted (if needed): `sudo systemctl restart <unit>`
4. Committed to git with the change details

## Files

| Unit | Purpose | Last modified |
|------|---------|---------------|
| `newme-platform.service` | Next.js app (port 3001) | 2026-07-02 |

## Health Check Rationale (newme-platform.service ExecStartPost)

The health check validates 4 critical routes (login / root / dashboard / leads) all return non-000 HTTP status. Previous version only checked `/login` and broke on first 200, missing cold-start races where dashboard/leads would 502 while login happened to be cached.

10 retries × 2s = up to 20s grace period for Next.js cold start. Failed health check exits 1, which systemd logs as ExecStartPost failure but does NOT abort the service (it's informational).