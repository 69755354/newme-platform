# Hermes CI webhook subscription — crm-ci

Status: provider selected and repository workflow added on 2026-07-10.

## Provider

- CI provider: GitHub Actions
- Workflow file: `.github/workflows/crm-ci.yml`
- Workflow name: `crm-ci`
- Trigger events: `pull_request`, `push` to `work`, `main`, `production`, and manual `workflow_dispatch`

## Required GitHub repository secrets

The build step reads these secrets if the production build requires live service configuration:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_SENTRY_DSN`
- `SENTRY_AUTH_TOKEN`
- `SENTRY_ORG`
- `SENTRY_PROJECT`

## Gates enforced by crm-ci

1. `bash scripts/check-taskboard.sh`
2. `npm run check:route-files`
3. `npm run check:schema-refs`
4. `npm run typecheck`
5. `npm run build`

## Hermes webhook subscription

Configure Hermes to subscribe to the GitHub Actions `workflow_run` event for workflow `crm-ci`.

Expected delivery contract:

- Event: `workflow_run`
- Workflow: `crm-ci`
- Accepted conclusions: `success`
- Blocking conclusions: `failure`, `timed_out`, `cancelled`, `action_required`
- Expected webhook acknowledgement: HTTP 200

## Manual verification

After pushing this branch, verify the subscription with:

```bash
git ls-remote origin HEAD
```

Then use the GitHub Actions UI or API to confirm the first `crm-ci` run completed successfully and that the Hermes webhook delivery returned HTTP 200.
