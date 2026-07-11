# Production Process Manager Policy

Production is systemd-only.

- Service: `newme-platform.service`
- PM2 is not approved for production takeover.
- Deployment scripts must not start PM2.
- Historical PM2 config, if needed for reference, lives under `docs/ops/deprecated/` and must not be used for production operations.

This document is policy only; it does not restart services or deploy anything.
