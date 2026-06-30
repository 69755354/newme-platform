# NewMe Platform Recovery - 2026-06-26

Issue:
newme-platform.service failed repeatedly after reboot.

Root cause:
Next.js production build artifact `.next` was missing.
`next start` failed with:
Could not find a production build in the '.next' directory.

Actions:
- Stopped restart loop
- Ran `npm run build`
- Restarted newme-platform.service
- Verified service active
- Verified `curl -I http://localhost:3001`
- Verified `/api/health`

Result:
Service recovered.
