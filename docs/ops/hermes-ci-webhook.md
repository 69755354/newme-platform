# Hermes CI webhook subscription — crm-ci

Status: provider selected; `crm-ci` is intentionally limited to the Hermes `workflow_run` contract after Phase 0.5.

## Provider

- CI provider: GitHub Actions
- Workflow file: `.github/workflows/crm-ci.yml`
- Workflow name: `crm-ci`
- Trigger events: `workflow_run` after the `ci` workflow completes on `work`, `main`, or `production`, plus manual `workflow_dispatch`

## Workflow responsibility split

| Workflow | File | Triggers | Required check | Responsibility |
|---|---|---|---|---|
| `ci` | `.github/workflows/ci.yml` | `pull_request`, `push` to `work`/`main`/`production`, manual | `Repository validation` | Runs repository validation: install, taskboard, route/schema gates, Supabase boundary, DB static, lint baseline, typecheck, tests, build smoke. |
| `crm-ci` | `.github/workflows/crm-ci.yml` | `workflow_run` after `ci`, manual | `Hermes CI webhook contract` | Provides the Hermes subscription target and fails if upstream `ci` did not succeed. It does not duplicate npm install/build/test gates. |

## Required GitHub repository secrets

None for Phase 0.5 CI validation. Build smoke uses safe placeholder values in `ci`; production secrets must not be used by CI.

## Gates enforced by ci

1. `bash scripts/check-taskboard.sh`
2. `npm run check:route-files`
3. `npm run check:schema-refs`
4. `npm run check:supabase-boundaries`
5. `npm run check:db-static`
6. `npm run lint:baseline`
7. `npm run typecheck`
8. `npm test`
9. `npm run build` with safe placeholder environment

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
# Hermes CI webhook — verified 2026-07-11T15:03:58Z
# trigger retry 15:07:56Z
